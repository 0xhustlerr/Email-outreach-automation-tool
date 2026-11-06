// A Sender's Signature is appended in sendMail, the choke point every send
// passes through. nodemailer is mocked, so nothing here can reach SMTP.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { sendMailSpy, sender } = vi.hoisted(() => ({
  sendMailSpy: vi.fn<(mail: Record<string, unknown>) => Promise<{ messageId: string }>>(
    async () => ({ messageId: "<test@local>" }),
  ),
  sender: { signature: "", signatureScope: "all" as "all" | "openers" },
}));

vi.mock("nodemailer", () => ({
  default: {
    createTransport: vi.fn(() => ({ sendMail: sendMailSpy, verify: vi.fn(), close: vi.fn() })),
  },
}));

vi.mock("./identities-store", () => ({
  listStoredIdentities: () => [
    {
      email: "ann@example.com",
      name: "Ann Lee",
      // An IP literal skips the DNS-over-HTTPS lookup, so the test stays offline.
      smtpHost: "127.0.0.1",
      smtpPort: 465,
      smtpSecure: true,
      smtpUser: "ann@example.com",
      smtpPass: "app-password-1234",
      oauthRefreshToken: "",
      oauthClientId: "",
      oauthClientSecret: "",
      signature: sender.signature,
      signatureScope: sender.signatureScope,
    },
  ],
}));

async function send(extra: { inReplyTo?: string; isReply?: boolean; body?: string } = {}) {
  const { sendMail } = await import("./mail");
  await sendMail({
    from: { name: "Ann Lee", email: "ann@example.com" },
    to: "bob@example.com",
    subject: "hi",
    body: "Hi Bob,\n\nQuick question.\n\nBest,\n{{sender}}",
    ...extra,
  });
  const mail = sendMailSpy.mock.calls.at(-1)?.[0] as { text: string; html: string };
  return mail;
}

describe("sendMail signature", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_SEND_DISABLED", "0");
    sender.signature = "";
    sender.signatureScope = "all";
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    sendMailSpy.mockClear();
  });

  it("changes nothing when the Sender has no signature", async () => {
    const mail = await send();
    expect(mail.text).toBe("Hi Bob,\n\nQuick question.\n\nBest,\nAnn Lee");
    expect(mail.html).not.toContain("gmail_signature");
  });

  it("appends a plain-text signature to both parts, resolving {{sender}}", async () => {
    sender.signature = "{{sender}}\nFounder · https://acme.com";
    const mail = await send();
    expect(mail.text).toBe(
      "Hi Bob,\n\nQuick question.\n\nBest,\nAnn Lee\n\nAnn Lee\nFounder · https://acme.com",
    );
    expect(mail.html).toContain('<div class="gmail_signature"');
    expect(mail.html).toContain('<a href="https://acme.com"');
  });

  it("inserts an HTML signature as-is and gives the text part a readable version", async () => {
    sender.signature = '<div><b>{{sender}}</b></div><div><a href="https://acme.com">Acme</a></div>';
    const mail = await send();
    expect(mail.html).toContain("<b>Ann Lee</b>");
    expect(mail.text.endsWith("\n\nAnn Lee\nAcme <https://acme.com>")).toBe(true);
  });

  it("escapes the sender name when filling an HTML signature", async () => {
    sender.signature = "<p>{{sender}}</p>";
    const { sendMail } = await import("./mail");
    await sendMail({
      from: { name: "Ann <script>", email: "ann@example.com" },
      to: "bob@example.com",
      subject: "hi",
      body: "Hello",
    });
    const mail = sendMailSpy.mock.calls.at(-1)?.[0] as { html: string };
    expect(mail.html).toContain("<p>Ann &lt;script&gt;</p>");
  });

  it("goes on replies when the scope is every email", async () => {
    sender.signature = "Ann";
    const mail = await send({ inReplyTo: "<op@local>" });
    expect(mail.html).toContain("gmail_signature");
  });

  it("stays off threaded replies when the scope is Openers only", async () => {
    sender.signature = "Ann";
    sender.signatureScope = "openers";
    const reply = await send({ inReplyTo: "<op@local>" });
    expect(reply.html).not.toContain("gmail_signature");
    expect(reply.text.endsWith("Best,\nAnn Lee")).toBe(true);

    const opener = await send();
    expect(opener.html).toContain("gmail_signature");
  });

  it("stays off a reply whose thread headers are missing when the scope is Openers only", async () => {
    sender.signature = "Ann";
    sender.signatureScope = "openers";
    const reply = await send({ isReply: true });
    expect(reply.html).not.toContain("gmail_signature");
  });

  it("does not start the text part with blank lines when the body is empty", async () => {
    sender.signature = "Ann";
    const mail = await send({ body: "" });
    expect(mail.text).toBe("Ann");
  });
});
