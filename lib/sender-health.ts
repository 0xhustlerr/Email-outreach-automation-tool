// Startup SMTP health check for the connected sending accounts.
//
// On every server start/restart each configured account gets one real SMTP
// connect + AUTH (nodemailer verify), so the console says up front which
// accounts can actually send and why the others can't — instead of the first
// failure only surfacing hours later as a queue error against one contact.
//
// Read-only: it opens its own short-lived connections (never the cached send
// transports) and sends nothing, so it cannot touch daily caps or warm-up.

import { listSendAccounts, probeSmtp, verifySmtp, type SmtpConfig } from "./mail";
import { listActiveBlocks } from "./sender-blocks";

// Let the server finish binding before spending sockets on SMTP handshakes.
const START_DELAY_MS = 3_000;
// Gmail rejects a burst of parallel logins from a cold start, so keep it low.
const CONCURRENCY = 3;

export type SenderHealthResult = {
  email: string;
  ok: boolean;
  /** 'host:port' of the account, for the log line. */
  target: string;
  /** Empty when ok; the SMTP failure reason otherwise. */
  error: string;
  /** True when the account has no usable credentials — nothing to verify. */
  unconfigured: boolean;
  /** ISO timestamp of this check, so the UI can say how stale it is. */
  checkedAt: string;
};

// Last known status per account (key: lowercased email). Held on globalThis so
// it survives dev HMR, and deliberately in memory only: a status is a statement
// about right now, and a stale one read back from disk after a restart would be
// worse than showing nothing.
const globalForHealth = globalThis as unknown as {
  __senderHealth?: boolean;
  __senderHealthLast?: Map<string, SenderHealthResult>;
};

function store(): Map<string, SenderHealthResult> {
  globalForHealth.__senderHealthLast ??= new Map();
  return globalForHealth.__senderHealthLast;
}

/** Last known SMTP status for every account checked since the server started.
 *  Empty until the startup check (or a recheck from Accounts) has run. */
export function getSenderHealth(): SenderHealthResult[] {
  return [...store().values()];
}

/** Remember the outcome of a check so the Accounts UI can show it. The error is
 *  collapsed here rather than at each call site, so a raw multi-line SMTP
 *  paragraph can never reach the badge tooltip. */
export function recordSenderHealth(
  r: Omit<SenderHealthResult, "checkedAt">,
): SenderHealthResult {
  const full: SenderHealthResult = {
    ...r,
    error: r.error ? oneLine(r.error) : "",
    checkedAt: new Date().toISOString(),
  };
  store().set(r.email.trim().toLowerCase(), full);
  return full;
}

/** Drop an account's status — called when the account itself is removed, so
 *  re-adding it later doesn't show the deleted account's last failure. */
export function forgetSenderHealth(email: string): void {
  store().delete(email.trim().toLowerCase());
}

/** One line of SMTP error, collapsed — Gmail's are multi-line paragraphs. */
function oneLine(s: string): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > 220 ? `${flat.slice(0, 217)}...` : flat;
}

async function checkAccount(
  a: ReturnType<typeof listSendAccounts>[number],
): Promise<SenderHealthResult> {
  if (!a.smtp) {
    return recordSenderHealth({
      email: a.email,
      ok: false,
      target: "",
      error: "no SMTP host/user/password stored",
      unconfigured: true,
    });
  }
  const target = `${a.smtp.host}:${a.smtp.port}`;
  const res = await verifySmtp(a.smtp);
  return recordSenderHealth({
    email: a.email,
    ok: res.ok,
    target,
    error: res.ok ? "" : (res.error ?? "SMTP verification failed"),
    unconfigured: false,
  });
}

/** Re-verify one account on demand (the Accounts modal's Reconnect flow).
 *  With `probe`, an unreachable port also tries the standard alternate, and
 *  `working` comes back with the endpoint that did connect. Never throws;
 *  returns null when the address isn't a connected account. */
export async function recheckSendAccount(
  email: string,
  opts: { probe?: boolean } = {},
): Promise<{ result: SenderHealthResult; working: SmtpConfig | null } | null> {
  const wanted = email.trim().toLowerCase();
  const account = listSendAccounts().find(
    (a) => a.email.toLowerCase() === wanted,
  );
  if (!account) return null;
  if (!account.smtp || !opts.probe) {
    return { result: await checkAccount(account), working: null };
  }
  const probe = await probeSmtp(account.smtp);
  const result = recordSenderHealth({
    email: account.email,
    ok: probe.ok,
    target: `${account.smtp.host}:${account.smtp.port}`,
    error: probe.ok ? "" : (probe.error ?? "SMTP verification failed"),
    unconfigured: false,
  });
  return { result, working: probe.working };
}

/** Verify every connected account once and log the outcome. Never throws. */
export async function checkSendAccountsNow(): Promise<SenderHealthResult[]> {
  const accounts = listSendAccounts();
  if (accounts.length === 0) {
    console.warn("[senders] no sending account connected — add one in Accounts");
    return [];
  }

  console.log(`[senders] checking ${accounts.length} connected account(s)...`);

  const results: SenderHealthResult[] = [];
  for (let i = 0; i < accounts.length; i += CONCURRENCY) {
    const batch = accounts.slice(i, i + CONCURRENCY);
    results.push(
      ...(await Promise.all(
        batch.map((a) =>
          checkAccount(a).catch((e: unknown) =>
            recordSenderHealth({
              email: a.email,
              ok: false,
              target: "",
              error: e instanceof Error ? e.message : String(e),
              unconfigured: false,
            }),
          ),
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
