import { describe, it, expect } from "vitest";
import { isAutomatedReply } from "./auto-reply";

function headers(values: Record<string, string>) {
  return (name: string) => values[name] ?? "";
}

describe("isAutomatedReply", () => {
  it("treats a Gmail vacation responder as automated", () => {
    expect(
      isAutomatedReply(headers({ "Auto-Submitted": "auto-replied" }), "Re: hi"),
    ).toBe(true);
  });

  it("treats an Outlook out-of-office subject as automated", () => {
    expect(isAutomatedReply(headers({}), "Automatic reply: Quick question")).toBe(true);
    expect(isAutomatedReply(headers({}), "Out of Office: Quick question")).toBe(true);
  });

  it("treats auto-responder and bulk precedence headers as automated", () => {
    expect(isAutomatedReply(headers({ "X-Autoreply": "yes" }), "Re: hi")).toBe(true);
    expect(isAutomatedReply(headers({ Precedence: "bulk" }), "Re: hi")).toBe(true);
  });

  it("keeps a real reply", () => {
    expect(
      isAutomatedReply(headers({ "Auto-Submitted": "no" }), "Re: Quick question"),
    ).toBe(false);
    expect(isAutomatedReply(headers({}), "Re: out of office plans")).toBe(false);
  });
});
