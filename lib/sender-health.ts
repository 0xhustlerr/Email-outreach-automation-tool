// Startup SMTP health check for the connected sending accounts.
//
// On every server start/restart each configured account gets one real SMTP
// connect + AUTH (nodemailer verify), so the console says up front which
// accounts can actually send and why the others can't — instead of the first
// failure only surfacing hours later as a queue error against one contact.
//
// Read-only: it opens its own short-lived connections (never the cached send
// transports) and sends nothing, so it cannot touch daily caps or warm-up.

import { listSendAccounts, verifySmtp } from "./mail";
import { listActiveBlocks } from "./sender-blocks";

// Let the server finish binding before spending sockets on SMTP handshakes.
const START_DELAY_MS = 3_000;
// Gmail rejects a burst of parallel logins from a cold start, so keep it low.
const CONCURRENCY = 3;

type Result = {
  email: string;
  ok: boolean;
  /** 'host:port' of the account, for the log line. */
  target: string;
  /** Empty when ok; the SMTP failure reason otherwise. */
  error: string;
  /** True when the account has no usable credentials — nothing to verify. */
  unconfigured: boolean;
};

const globalForHealth = globalThis as unknown as { __senderHealth?: boolean };

/** One line of SMTP error, collapsed — Gmail's are multi-line paragraphs. */
function oneLine(s: string): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > 220 ? `${flat.slice(0, 217)}...` : flat;
}

async function checkAccount(
  a: ReturnType<typeof listSendAccounts>[number],
): Promise<Result> {
  if (!a.smtp) {
    return {
      email: a.email,
      ok: false,
      target: "",
      error: "no SMTP host/user/password stored",
      unconfigured: true,
    };
  }
  const target = `${a.smtp.host}:${a.smtp.port}`;
  const res = await verifySmtp(a.smtp);
  return {
    email: a.email,
    ok: res.ok,
    target,
    error: res.ok ? "" : oneLine(res.error ?? "SMTP verification failed"),
    unconfigured: false,
  };
}

/** Verify every connected account once and log the outcome. Never throws. */
export async function checkSendAccountsNow(): Promise<Result[]> {
  const accounts = listSendAccounts();
  if (accounts.length === 0) {
    console.warn("[senders] no sending account connected — add one in Accounts");
    return [];
  }

  console.log(`[senders] checking ${accounts.length} connected account(s)...`);

  const results: Result[] = [];
  for (let i = 0; i < accounts.length; i += CONCURRENCY) {
    const batch = accounts.slice(i, i + CONCURRENCY);
    results.push(
      ...(await Promise.all(
        batch.map((a) =>
          checkAccount(a).catch((e: unknown) => ({
            email: a.email,
            ok: false,
            target: "",
            error: oneLine(e instanceof Error ? e.message : String(e)),
            unconfigured: false,
          })),
        ),
      )),
    );
  }

  for (const r of results) {
    if (r.ok) {
      console.log(`[senders] OK   ${r.email} — SMTP login ok (${r.target})`);
    } else if (r.unconfigured) {
      console.warn(`[senders] SKIP ${r.email} — ${r.error}`);
    } else {
      console.error(`[senders] FAIL ${r.email} — ${r.target}: ${r.error}`);
    }
  }

  // A healthy login still can't send while Gmail has the account stood down for
  // the day, so report today's blocks alongside the verify results.
  for (const b of listActiveBlocks()) {
    console.warn(
      `[senders] PAUSED ${b.sender} — ${b.reason}${
        b.statusCode ? ` (${b.statusCode})` : ""
      }, resumes at local midnight`,
    );
  }

  const ready = results.filter((r) => r.ok).length;
  const line = `[senders] ${ready}/${results.length} account(s) ready to send`;
  if (ready === results.length) console.log(line);
  else console.warn(line);
  return results;
}

/** Fire the check in the background at server start. Safe to call twice. */
export function startSenderHealthCheck(): void {
  if (globalForHealth.__senderHealth) return;
  globalForHealth.__senderHealth = true;
  setTimeout(() => {
    void checkSendAccountsNow().catch((e: unknown) => {
      console.error(
        `[senders] health check failed: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    });
  }, START_DELAY_MS);
}
