// composeEmail is what both sendMail and the Templates page preview render
// through, so what the preview shows is what goes out.

import { describe, it, expect } from "vitest";
import { composeEmail } from "./mail-html";

const ann = { name: "Ann Lee", email: "ann@example.com" };

describe("composeEmail", () => {
  it("fills the sender placeholders in subject and body", () => {
    const e = composeEmail({
      subject: "From {{sender}}",
      body: "Hi,\n\nReach me at {{sender_email}}.\n\n{{sender}}",
      sender: ann,
    });
    expect(e.subject).toBe("From Ann Lee");
    expect(e.text).toBe("Hi,\n\nReach me at ann@example.com.\n\nAnn Lee");
    expect(e.html).toContain("Reach me at ann@example.com.");
  });

  it("appends the Signature to both parts", () => {
    const e = composeEmail({
      subject: "Hi",
      body: "Hello there\n",
      sender: ann,
      signature: "{{sender}}\nAcme Dev",
    });
    expect(e.text).toBe("Hello there\n\nAnn Lee\nAcme Dev");
    expect(e.html).toContain('class="gmail_signature"');
    expect(e.html).toContain("Ann Lee<br>\nAcme Dev");
  });

  it("keeps an Openers-only Signature off a reply, and on an opener", () => {
    const base = { subject: "Hi", body: "Hello", sender: ann, signature: "Ann", signatureScope: "openers" as const };
    const reply = composeEmail({ ...base, isReply: true });
    expect(reply.text).toBe("Hello");
    expect(reply.html).not.toContain("gmail_signature");
    expect(composeEmail(base).text).toBe("Hello\n\nAnn");
  });

  it("escapes a tag-like display name in the HTML part", () => {
    const e = composeEmail({ subject: "", body: "{{sender}}", sender: { name: "<b>x</b>", email: "x@y.z" } });
    expect(e.html).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(e.html).not.toContain("<b>x</b>");
  });

  it("adds the tracking pixel when given", () => {
    const e = composeEmail({ subject: "", body: "Hi", sender: ann, pixelUrl: "https://t.example/p.gif" });
    expect(e.html).toContain('src="https://t.example/p.gif"');
  });
});
