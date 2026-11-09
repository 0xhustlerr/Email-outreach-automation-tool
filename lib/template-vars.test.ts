// Template placeholder filling, shared by the queue, the import routes, the
// Send modal and the Templates page preview.

import { describe, it, expect } from "vitest";
import { displayName, replySubject, senderVars, substitute, urlVars } from "./template-vars";

describe("substitute", () => {
  it("fills contact placeholders and leaves the sender ones for the mailer", () => {
    const vars = {
      name: displayName("Alex"),
      ...senderVars(),
      ...urlVars({ upwork: "https://upwork.com/a", username: "alex" }),
    };
    expect(substitute("Hi {{name}}, {{url}} {{url_github}} — {{sender}} {{nope}}!", vars)).toBe(
      "Hi Alex, https://upwork.com/a https://github.com/alex — {{sender}} !",
    );
  });
});

describe("displayName", () => {
  it("falls back to 'there' for a missing name or one that is really a URL", () => {
    expect(displayName("https://upwork.com/x")).toBe("there");
    expect(displayName("")).toBe("there");
    expect(displayName(" Alex ")).toBe("Alex");
  });
});

describe("replySubject", () => {
  it("prefixes the Opener's subject with Re:", () => {
    expect(replySubject("Quick question")).toBe("Re: Quick question");
  });

  it("never doubles an existing Re:", () => {
    expect(replySubject("Re: Quick question")).toBe("Re: Quick question");
    expect(replySubject("RE:hi")).toBe("RE:hi");
  });

  it("handles an empty subject", () => {
    expect(replySubject("  ")).toBe("Re:");
  });
});
