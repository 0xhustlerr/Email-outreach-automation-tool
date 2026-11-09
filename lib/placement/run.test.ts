// Placement test orchestration against a throwaway database (lib/db.ts opens
// <cwd>/.data/app.db, so the test moves into a temp dir first). SMTP and Gmail
// are mocked — nothing here can send or read real mail.

import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  disabled: false,
  sendMail: vi.fn<
    (args: { to: string; bcc?: string[]; subject: string; body: string; from: { email: string } }) => Promise<{ messageId: string }>
  >(),
  findPlacement: vi.fn(),
}));

vi.mock("@/lib/mail", () => ({
  isSendingDisabled: () => h.disabled,
  listIdentities: () => [
    { email: "ann@example.com", name: "Ann" },
    { email: "bob@example.com", name: "Bob" },
    { email: "cat@example.com", name: "Cat" }, // no Gmail token → not a seed
  ],
  sendMail: h.sendMail,
}));

vi.mock("@/lib/gmail", () => ({
  parseGmailAccounts: () => ({
    "ann@example.com": { clientId: "c", clientSecret: "s", refreshToken: "r" },
    "bob@example.com": { clientId: "c", clientSecret: "s", refreshToken: "r" },
  }),
  getAccessToken: async (email: string) =>
    ["ann@example.com", "bob@example.com"].includes(email) ? `token-${email}` : null,
  cachedAccessToken: async (email: string) => `token-${email}`,
  gmailFetch: vi.fn(),
}));

vi.mock("./gmail-placement", () => ({ findPlacement: h.findPlacement }));

const originalCwd = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "placement-run-"));
let run: typeof import("./run");
let store: typeof import("./store");
let db: typeof import("@/lib/db").db;
let openerId = "";

beforeAll(async () => {
  process.chdir(tmp);
  run = await import("./run");
  store = await import("./store");
  db = (await import("@/lib/db")).db;
  openerId = (await import("@/lib/templates-store")).listTemplates("opener")[0].id;
  // An extra Gmail inbox that only receives tests (uses the global client).
  (await import("@/lib/identities-store")).setGmailClient("gid", "gsecret");
  store.upsertSeedInbox({ email: "Seed@Gmail.com", refreshToken: "1//seed" });
});

afterAll(() => {
  db.close();
  process.chdir(originalCwd);
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  h.disabled = false;
  h.sendMail.mockReset();
  h.findPlacement.mockReset();
  let n = 0;
  h.sendMail.mockImplementation(async () => ({ messageId: `<m${++n}@example.com>` }));
  db.exec(`DELETE FROM placement_results; DELETE FROM placement_tests;`);
});

/** Collect now, bypassing the 20s throttle. */
async function refreshNow(id: string) {
  store.updateTest(id, { checked_at: null });
  await run.refreshPlacementTest(id);
}

async function settled(id: string) {
  for (let i = 0; i < 50; i++) {
    const t = store.getTest(id);
    if (t && t.status !== "sending") return t;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("test never left 'sending'");
}

const sendLogCount = () => (db.prepare(`SELECT COUNT(*) AS n FROM send_log`).get() as { n: number }).n;

describe("startPlacementTests", () => {
  it("refuses while sending is disabled, before anything is created", () => {
    h.disabled = true;
    expect(() =>
      run.startPlacementTests({ senders: ["ann@example.com"], provider: "seeds", templateId: openerId }),
    ).toThrow(/Sending is disabled/);
    expect(h.sendMail).not.toHaveBeenCalled();
    expect(store.listTestsByStatus("sending")).toHaveLength(0);
  });

  it("rejects an unknown Sender or template", () => {
    expect(() =>
      run.startPlacementTests({ senders: ["zed@example.com"], provider: "seeds", templateId: openerId }),
    ).toThrow(/not a connected Sender/);
    expect(() =>
      run.startPlacementTests({ senders: ["ann@example.com"], provider: "seeds", templateId: "nope" }),
    ).toThrow(/Opener template/);
  });

  it("mails each seed one-to-one, never the Sender itself, and never logs outreach", async () => {
    const [view] = run.startPlacementTests({
      senders: ["ann@example.com"],
      provider: "seeds",
      templateId: openerId,
    });
    const test = await settled(view.id);
    expect(test.status).toBe("running");
    expect(test.sent_at).toBeTruthy();

    const recipients = h.sendMail.mock.calls.map(([a]) => a.to).sort();
    expect(recipients).toEqual(["bob@example.com", "seed@gmail.com"]);
    expect(h.sendMail.mock.calls.every(([a]) => !a.bcc?.length)).toBe(true);
    // Contact placeholders are filled; the sender ones are left for the mailer.
    expect(h.sendMail.mock.calls[0][0].body).not.toMatch(/\{\{\s*name\s*\}\}/);

    const results = store.listResults(view.id);
    expect(results.map((r) => r.placement)).toEqual(["pending", "pending"]);
    expect(results.every((r) => r.message_id.startsWith("<m"))).toBe(true);
    expect(sendLogCount()).toBe(0);
  });

  it("records a failed seed send without failing the whole test", async () => {
    h.sendMail.mockImplementation(async (a) => {
      if (a.to === "bob@example.com") throw new Error("550 nope");
      return { messageId: "<ok@example.com>" };
    });
    const [view] = run.startPlacementTests({ senders: ["ann@example.com"], provider: "seeds", templateId: openerId });
    const test = await settled(view.id);
    expect(test.status).toBe("running");
    const bob = store.listResults(view.id).find((r) => r.seed === "bob@example.com")!;
    expect(bob.placement).toBe("send_failed");
    expect(bob.detail).toBe("550 nope");
  });

  it("fails the test when every send fails", async () => {
    h.sendMail.mockRejectedValue(new Error("auth failed"));
    const [view] = run.startPlacementTests({ senders: ["ann@example.com"], provider: "seeds", templateId: openerId });
    const test = await settled(view.id);
    expect(test.status).toBe("failed");
    expect(test.error).toBe("auth failed");
  });
});

describe("sending", () => {
  it("tests Senders one after another, never interleaved", async () => {
    h.sendMail.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 5));
      return { messageId: "<x@example.com>" };
    });
    const views = run.startPlacementTests({
      senders: ["ann@example.com", "bob@example.com"],
      provider: "seeds",
      templateId: openerId,
    });
    await Promise.all(views.map((v) => settled(v.id)));
    const froms = h.sendMail.mock.calls.map(([a]) => a.from.email);
    expect(froms).toEqual(["ann@example.com", "ann@example.com", "bob@example.com", "bob@example.com"]);
  });

  it("fills links and the name from the most recent real send", async () => {
    const { saveTemplate } = await import("@/lib/templates-store");
    const t = saveTemplate({ label: "Linked", subject: "hey {{name}}", body: "see {{url}} and {{url_github}}", kind: "opener" });
    const { logSendToDb } = await import("@/lib/db");
    logSendToDb({
      date: new Date().toISOString(),
      name: "Dana",
      username: "dana-dev",
      country: "",
      site: "",
      contact: "dana@example.org",
      link: "https://www.upwork.com/freelancers/dana",
      sender: "ann@example.com",
      mailSent: true,
    });
    try {
      const [view] = run.startPlacementTests({ senders: ["ann@example.com"], provider: "seeds", templateId: t.id });
      await settled(view.id);
      const sent = h.sendMail.mock.calls[0][0];
      expect(sent.subject).toBe("hey Dana");
      expect(sent.body).toBe("see https://www.upwork.com/freelancers/dana and https://github.com/dana-dev");
    } finally {
      db.exec(`DELETE FROM send_log`);
    }
  });
});

describe("refreshPlacementTest", () => {
  it("collects placements and finishes once every seed is known", async () => {
    const [view] = run.startPlacementTests({ senders: ["ann@example.com"], provider: "seeds", templateId: openerId });
    await settled(view.id);

    h.findPlacement.mockImplementation(async (access: string) =>
      access === "token-bob@example.com" ? { placement: "spam", detail: "" } : null,
    );
    await refreshNow(view.id);
    let t = store.toView(store.getTest(view.id)!);
    expect(t.status).toBe("running");
    expect(t.counts.spam).toBe(1);
    expect(t.counts.pending).toBe(1);

    h.findPlacement.mockResolvedValue({ placement: "tab", detail: "Promotions" });
    await refreshNow(view.id);
    t = store.toView(store.getTest(view.id)!);
    expect(t.status).toBe("done");
    expect(t.counts).toMatchObject({ spam: 1, tab: 1, pending: 0, total: 2 });
  });

  it("is throttled between reads", async () => {
    const [view] = run.startPlacementTests({ senders: ["ann@example.com"], provider: "seeds", templateId: openerId });
    await settled(view.id);
    h.findPlacement.mockResolvedValue(null);
    await refreshNow(view.id);
    const calls = h.findPlacement.mock.calls.length;
    await run.refreshPlacementTest(view.id);
    expect(h.findPlacement.mock.calls.length).toBe(calls);
  });

  it("fails a test a restart left 'sending'", async () => {
    const orphan = store.createTest({ sender: "ann@example.com", provider: "seeds", templateId: openerId, subject: "hi" });
    await run.refreshPlacementTest(orphan.id);
    expect(store.getTest(orphan.id)?.status).toBe("failed");
  });

  it("closes out a test whose provider keeps failing past its window", async () => {
    const [view] = run.startPlacementTests({ senders: ["ann@example.com"], provider: "seeds", templateId: openerId });
    await settled(view.id);
    const spy = vi.spyOn(run.PROVIDERS.seeds, "collect").mockRejectedValue(new Error("API down"));
    try {
      await refreshNow(view.id);
      expect(store.getTest(view.id)?.status).toBe("running"); // still inside the window
      expect(store.getTest(view.id)?.error).toBe("API down");

      store.updateTest(view.id, { sent_at: new Date(Date.now() - 16 * 60_000).toISOString() });
      await refreshNow(view.id);
      const t = store.toView(store.getTest(view.id)!);
      expect(t.status).toBe("done");
      expect(t.counts).toMatchObject({ error: 2, pending: 0 });
    } finally {
      spy.mockRestore();
    }
  });

  it("marks seeds Missing once the window has passed", async () => {
    const [view] = run.startPlacementTests({ senders: ["ann@example.com"], provider: "seeds", templateId: openerId });
    await settled(view.id);
    store.updateTest(view.id, { sent_at: new Date(Date.now() - 16 * 60_000).toISOString() });
    h.findPlacement.mockResolvedValue(null);
    await refreshNow(view.id);
    const t = store.toView(store.getTest(view.id)!);
    expect(t.status).toBe("done");
    expect(t.counts.missing).toBe(2);
  });
});
