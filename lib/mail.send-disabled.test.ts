import { afterEach, describe, expect, it, vi } from "vitest";

// nodemailer is mocked so this test can never reach a real SMTP server,
// whether or not the guard works.
const sendMailSpy = vi.fn(async () => ({ messageId: "<test@local>" }));
vi.mock("nodemailer", () => ({
  default: {
    createTransport: vi.fn(() => ({ sendMail: sendMailSpy, verify: vi.fn(), close: vi.fn() })),
  },
}));

describe("sendMail kill switch", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    sendMailSpy.mockClear();
  });

  it("refuses to send and never touches the transport when NEXT_PUBLIC_SEND_DISABLED=1", async () => {
    vi.stubEnv("NEXT_PUBLIC_SEND_DISABLED", "1");
    const { sendMail, isSendingDisabled } = await import("./mail");
    expect(isSendingDisabled()).toBe(true);
    await expect(
      sendMail({
        from: { name: "Test", email: "sender@example.com" },
        to: "someone@example.com",
        subject: "hi",
        body: "hello",
      }),
    ).rejects.toThrow(/Sending is disabled/);
    expect(sendMailSpy).not.toHaveBeenCalled();
  });

  it("is off when the variable is unset", async () => {
    vi.stubEnv("NEXT_PUBLIC_SEND_DISABLED", "");
    const { isSendingDisabled } = await import("./mail");
    expect(isSendingDisabled()).toBe(false);
  });
});
