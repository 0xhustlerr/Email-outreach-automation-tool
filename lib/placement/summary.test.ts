import { describe, expect, it } from "vitest";
import { summarizePlacement } from "./summary";
import { emptyCounts, type Placement, type PlacementTestView } from "./types";

function test(status: PlacementTestView["status"], placements: Placement[], error = ""): PlacementTestView {
  const counts = emptyCounts();
  for (const p of placements) {
    counts[p] += 1;
    counts.total += 1;
  }
  return {
    id: "t",
    sender: "ann@example.com",
    provider: "seeds",
    templateId: "opener-x",
    subject: "hi",
    status,
    error,
    createdAt: "2026-11-09T10:00:00Z",
    sentAt: "2026-11-09T10:00:05Z",
    finishedAt: null,
    counts,
    results: [],
  };
}

describe("summarizePlacement", () => {
  it("is null with no test", () => {
    expect(summarizePlacement(null)).toBeNull();
  });

  it("all Inbox is green", () => {
    expect(summarizePlacement(test("done", ["inbox", "inbox"]))).toMatchObject({
      tone: "success",
      label: "Inbox 2/2",
    });
  });

  it("any Spam is red, even while still checking", () => {
    expect(summarizePlacement(test("running", ["spam", "pending", "inbox"]))).toMatchObject({
      tone: "danger",
      label: "Spam 1/3",
    });
  });

  it("a tab result is a warning", () => {
    expect(summarizePlacement(test("done", ["inbox", "tab"]))).toMatchObject({
      tone: "warning",
      label: "Inbox 1/2",
    });
  });

  it("failed sends and unreadable inboxes don't count toward the total", () => {
    expect(summarizePlacement(test("done", ["inbox", "send_failed", "error"]))).toMatchObject({
      label: "Inbox 1/1",
    });
  });

  it("a failed test says so", () => {
    expect(summarizePlacement(test("failed", [], "boom"))).toMatchObject({
      tone: "neutral",
      label: "Test failed",
      title: "boom",
    });
  });
});
