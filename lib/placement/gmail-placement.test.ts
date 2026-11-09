import { beforeEach, describe, expect, it, vi } from "vitest";

// gmailFetch is the only network edge. Mocking the module also keeps the test
// from loading lib/gmail (which opens the app database on import).
const gmailFetch = vi.hoisted(() => vi.fn<(url: string, init?: RequestInit) => Promise<Response>>());
vi.mock("@/lib/gmail", () => ({ gmailFetch }));

const { findPlacement, labelsToPlacement, placementQueries } = await import("./gmail-placement");

describe("labelsToPlacement", () => {
  it("reads Spam", () => {
    expect(labelsToPlacement(["SPAM", "UNREAD"])).toEqual({ placement: "spam", detail: "" });
  });

  it("Spam wins even if a category label is present", () => {
    expect(labelsToPlacement(["SPAM", "CATEGORY_PROMOTIONS"]).placement).toBe("spam");
  });

  it("a category tab wins over INBOX (Promotions messages carry both)", () => {
    expect(labelsToPlacement(["INBOX", "CATEGORY_PROMOTIONS", "UNREAD"])).toEqual({
      placement: "tab",
      detail: "Promotions",
    });
    expect(labelsToPlacement(["INBOX", "CATEGORY_UPDATES"]).detail).toBe("Updates");
  });

  it("reads Primary as Inbox", () => {
    expect(labelsToPlacement(["INBOX", "CATEGORY_PERSONAL", "UNREAD"])).toEqual({
      placement: "inbox",
      detail: "",
    });
    expect(labelsToPlacement(["INBOX"]).placement).toBe("inbox");
  });

  it("calls a message outside Inbox and Spam 'other'", () => {
    expect(labelsToPlacement(["TRASH"])).toEqual({ placement: "other", detail: "Trash" });
    expect(labelsToPlacement(["UNREAD"]).placement).toBe("other");
  });
});

describe("placementQueries", () => {
  const sentAfterMs = Date.UTC(2026, 10, 9, 12, 0, 0);

  it("searches the exact Message-ID first, without angle brackets", () => {
    const [first] = placementQueries({
      messageId: "<abc.123@mail.example.com>",
      from: "ann@example.com",
      subject: "you around?",
      sentAfterMs,
    });
    expect(first).toBe("rfc822msgid:abc.123@mail.example.com");
  });

  it("falls back to sender + subject + time, with a minute of slack", () => {
    const qs = placementQueries({
      messageId: "<abc@x>",
      from: "ann@example.com",
      subject: 'quick "q" for you',
      sentAfterMs,
    });
    expect(qs[1]).toBe(
      `from:ann@example.com subject:"quick q for you" after:${sentAfterMs / 1000 - 60}`,
    );
  });

  it("skips the Message-ID query when there is none", () => {
    const qs = placementQueries({ messageId: "", from: "a@b.co", subject: "hi", sentAfterMs });
    expect(qs).toHaveLength(1);
    expect(qs[0].startsWith("from:")).toBe(true);
  });
});

describe("findPlacement", () => {
  const msg = {
    messageId: "<abc@example.com>",
    from: "ann@example.com",
    subject: "you around?",
    sentAfterMs: Date.UTC(2026, 10, 9, 12),
  };
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  beforeEach(() => {
    gmailFetch.mockReset();
  });

  it("finds by Message-ID, including Spam, and reads the labels", async () => {
    gmailFetch.mockImplementation(async (url) => {
      if (url.includes("/messages?")) return json({ messages: [{ id: "g1" }] });
      return json({ labelIds: ["SPAM"] });
    });
    expect(await findPlacement("tok", msg)).toEqual({ placement: "spam", detail: "" });
    const list = new URL(gmailFetch.mock.calls[0][0]);
    expect(list.searchParams.get("q")).toBe("rfc822msgid:abc@example.com");
    expect(list.searchParams.get("includeSpamTrash")).toBe("true");
    expect(gmailFetch.mock.calls[1][0]).toContain("/messages/g1?format=minimal");
    expect((gmailFetch.mock.calls[0][1]?.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });

  it("falls back to sender + subject when the Message-ID isn't found", async () => {
    gmailFetch.mockImplementation(async (url) => {
      const q = new URL(url).searchParams.get("q") ?? "";
      if (url.includes("/messages?")) return json(q.startsWith("from:") ? { messages: [{ id: "g2" }] } : {});
      return json({ labelIds: ["INBOX", "CATEGORY_PERSONAL"] });
    });
    expect(await findPlacement("tok", msg)).toEqual({ placement: "inbox", detail: "" });
    expect(gmailFetch).toHaveBeenCalledTimes(3);
  });

  it("is null when the message hasn't arrived", async () => {
    gmailFetch.mockImplementation(async () => json({ resultSizeEstimate: 0 }));
    expect(await findPlacement("tok", msg)).toBeNull();
  });

  it("throws Gmail's error so the caller can report it", async () => {
    gmailFetch.mockResolvedValue(json({ error: { message: "Invalid Credentials" } }, 401));
    await expect(findPlacement("tok", msg)).rejects.toThrow("Invalid Credentials");
  });
});
