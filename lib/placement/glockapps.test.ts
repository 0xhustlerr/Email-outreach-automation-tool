// GlockApps response mapping. The fixture mirrors the Swagger examples
// (TestItem.inboxes[] with iType "Inbox"/"Spam" and gappsFlags); replace it
// with a captured live response once one is available.

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/identities-store", () => ({ getGlockAppsSettings: () => null }));

const { mapGlockAppsInbox, mapGlockAppsResult, parseInsertHeader } = await import("./glockapps");

describe("parseInsertHeader", () => {
  it("splits GlockApps' header line into a name and value", () => {
    expect(parseInsertHeader("X-API-Campaign-id: 2023-09-24-11:09:04:723t")).toEqual({
      "X-API-Campaign-id": "2023-09-24-11:09:04:723t",
    });
  });

  it("ignores anything that isn't a plain header line", () => {
    expect(parseInsertHeader(undefined)).toEqual({});
    expect(parseInsertHeader("no colon here")).toEqual({});
    expect(parseInsertHeader("Bad Name: x")).toEqual({});
  });
});

describe("mapGlockAppsInbox", () => {
  it("maps Inbox and Spam", () => {
    expect(mapGlockAppsInbox({ iType: "Inbox" })).toEqual({ placement: "inbox", detail: "" });
    expect(mapGlockAppsInbox({ iType: "Spam" })).toEqual({ placement: "spam", detail: "" });
  });

  it("reads a Gmail Promotions flag, as an object or an array", () => {
    expect(mapGlockAppsInbox({ iType: "Inbox", gappsFlags: { gappsGmailInPromotions: true } })).toEqual({
      placement: "tab",
      detail: "Promotions",
    });
    expect(mapGlockAppsInbox({ iType: "Inbox", gappsFlags: ["GAPPS_GMAIL_IN_PROMOTIONS"] })?.placement).toBe(
      "tab",
    );
    expect(mapGlockAppsInbox({ iType: "Inbox", gappsFlags: { gappsGmailInPromotions: false } })?.placement).toBe(
      "inbox",
    );
  });

  it("leaves an unknown iType pending", () => {
    expect(mapGlockAppsInbox({ iType: "X" })).toBeNull();
    expect(mapGlockAppsInbox({})).toBeNull();
  });
});

describe("mapGlockAppsResult", () => {
  const ours = [
    { seed: "a@gmail.com", placement: "pending" as const },
    { seed: "b@outlook.com", placement: "pending" as const },
    { seed: "c@yahoo.com", placement: "pending" as const },
  ];
  const item = {
    finished: false,
    inboxes: [
      { email: "A@gmail.com", iType: "Inbox", seedName: "Gmail" },
      { email: "b@outlook.com", iType: "Spam", seedName: "Outlook" },
      { email: "c@yahoo.com", iType: "X", seedName: "Yahoo" },
    ],
  };

  it("maps what is known and keeps waiting on the rest", () => {
    const r = mapGlockAppsResult(item, ours, { giveUp: false });
    expect(r.finished).toBe(false);
    expect(r.updates).toEqual([
      { seed: "a@gmail.com", seedProvider: "Gmail", placement: "inbox", detail: "" },
      { seed: "b@outlook.com", seedProvider: "Outlook", placement: "spam", detail: "" },
    ]);
  });

  it("marks the rest Missing once GlockApps says finished", () => {
    const r = mapGlockAppsResult({ ...item, finished: true }, ours, { giveUp: false });
    expect(r.finished).toBe(true);
    expect(r.updates.find((u) => u.seed === "c@yahoo.com")?.placement).toBe("missing");
  });

  it("marks a seed GlockApps never listed Missing when finished", () => {
    const r = mapGlockAppsResult(
      { finished: true, inboxes: [] },
      [{ seed: "z@aol.com", placement: "pending" }],
      { giveUp: false },
    );
    expect(r.updates).toEqual([{ seed: "z@aol.com", placement: "missing", detail: "Never arrived" }]);
  });

  it("gives up after the timeout even if GlockApps never finishes", () => {
    expect(mapGlockAppsResult(item, ours, { giveUp: true }).finished).toBe(true);
  });
});
