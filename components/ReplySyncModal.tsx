"use client";

import { useEffect, useState } from "react";

// Per-account reply-sync setup, opened from an account's "Reply sync" button in
// the Accounts modal. One shared Google OAuth client (Client ID + Secret) plus
// this account's refresh token. Includes a from-zero guide.

type Snapshot = {
  replySync?: { clientConfigured: boolean; accounts: Record<string, boolean> };
};

export default function ReplySyncModal({
  email,
  clientConfigured,
  syncOn,
  onClose,
  onChanged,
}: {
  email: string;
  clientConfigured: boolean;
  syncOn: boolean;
  onClose: () => void;
  onChanged?: (snap: Snapshot) => void;
}) {
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [refreshToken, setRefreshToken] = useState("");
  const [showGuide, setShowGuide] = useState(!clientConfigured);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);
  const [clientDone, setClientDone] = useState(clientConfigured);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const saveClient = async () => {
    setError(null);
    setOkMsg(null);
    setBusy(true);
    try {
      const res = await fetch("/api/senders", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId, clientSecret }),
      });
      const body = (await res.json()) as Snapshot & { ok: boolean; error?: string };
      if (!res.ok || !body.ok) {
        setError(body.error ?? "Could not save the OAuth client.");
        return;
      }
      setClientId("");
      setClientSecret("");
      setClientDone(true);
      setOkMsg("Client saved. Now paste this account's refresh token below.");
      onChanged?.(body);
    } catch {
      setError("Network error while saving the OAuth client.");
    } finally {
      setBusy(false);
    }
  };

  const saveToken = async (token: string) => {
    setError(null);
    setOkMsg(null);
    setBusy(true);
    try {
      const res = await fetch("/api/senders", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, refreshToken: token }),
      });
      const body = (await res.json()) as Snapshot & { ok: boolean; error?: string };
      if (!res.ok || !body.ok) {
        setError(body.error ?? "Could not save the refresh token.");
        return;
      }
      onChanged?.(body);
      setOkMsg(token ? `Reply sync is on for ${email}.` : `Reply sync turned off for ${email}.`);
      setRefreshToken("");
      if (token) window.setTimeout(onClose, 900);
    } catch {
      setError("Network error while saving the refresh token.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fade-in fixed inset-0 z-[80] flex items-center justify-center bg-black/80 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="glass slide-in relative flex max-h-[92vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl shadow-2xl shadow-black/50">
        <div className="flex-1 overflow-auto p-6">
          <div className="mb-4 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="flex items-center gap-2 text-lg font-semibold text-slate-100">
                <SyncIcon className="h-5 w-5 text-cyan-300" />
                Reply sync
              </h3>
              <p className="mt-1 truncate text-xs text-slate-400">
                Read incoming replies for <span className="text-slate-200">{email}</span>
                {syncOn ? " · currently on" : ""}
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded-full p-2 text-slate-400 transition hover:bg-white/5 hover:text-slate-100"
              aria-label="Close"
            >
              <CloseIcon className="h-4 w-4" />
            </button>
          </div>

          {error && (
            <p className="mb-3 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-[11px] text-rose-200">
              {error}
            </p>
          )}
          {okMsg && !error && (
            <p className="mb-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-[11px] text-emerald-200">
              {okMsg}
            </p>
          )}

          {/* Step 1: shared OAuth client */}
          <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h4 className="text-[11px] font-medium uppercase tracking-[0.22em] text-slate-400">
                1 · Google OAuth client (shared)
              </h4>
              <span
                className={
                  "rounded-full border px-2 py-0.5 text-[10px] font-medium " +
                  (clientDone
                    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                    : "border-white/10 bg-white/[0.03] text-slate-500")
                }
              >
                {clientDone ? "Set" : "Not set"}
              </span>
            </div>
            <div className="space-y-2.5">
              <input
                type="text"
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                placeholder={clientDone ? "Client ID (set — paste to replace)" : "OAuth Client ID"}
                autoComplete="off"
                className="w-full rounded-lg border border-white/10 bg-slate-900/70 px-3 py-2 font-mono text-[12px] text-slate-200 outline-none placeholder:font-sans placeholder:text-slate-500 focus:border-cyan-400/50"
              />
              <input
                type="text"
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
                placeholder={clientDone ? "Client Secret (set — paste to replace)" : "OAuth Client Secret"}
                autoComplete="off"
                className="w-full rounded-lg border border-white/10 bg-slate-900/70 px-3 py-2 font-mono text-[12px] text-slate-200 outline-none placeholder:font-sans placeholder:text-slate-500 focus:border-cyan-400/50"
              />
            </div>
            <button
              type="button"
              onClick={saveClient}
              disabled={busy || !clientId.trim() || !clientSecret.trim()}
              className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg border border-cyan-400/40 bg-cyan-500/10 px-3 py-2 text-sm font-semibold text-cyan-200 transition hover:bg-cyan-400/20 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy ? <SpinnerIcon className="h-4 w-4 animate-spin" /> : null}
              Save client
            </button>
          </div>

          {/* Step 2: this account's refresh token */}
          <div className="mt-4 rounded-2xl border border-white/10 bg-white/[0.03] p-4">
            <h4 className="mb-2 text-[11px] font-medium uppercase tracking-[0.22em] text-slate-400">
              2 · Refresh token for {email}
            </h4>
            {!clientDone && (
              <p className="mb-2 text-[11px] text-amber-300/90">Save the OAuth client above first.</p>
            )}
            <input
              type="text"
              value={refreshToken}
              onChange={(e) => setRefreshToken(e.target.value)}
              placeholder="1//0g… (from OAuth Playground, signed in as this account)"
              autoComplete="off"
              disabled={!clientDone}
              className="w-full rounded-lg border border-white/10 bg-slate-900/70 px-3 py-2 font-mono text-[12px] text-slate-200 outline-none placeholder:font-sans placeholder:text-slate-500 focus:border-cyan-400/50 disabled:opacity-50"
            />
            <div className="mt-2 flex items-center gap-2">
              <button
                type="button"
                onClick={() => saveToken(refreshToken.trim())}
                disabled={busy || !clientDone || refreshToken.trim().length < 10}
                className="flex items-center gap-1.5 rounded-lg bg-cyan-500/90 px-3 py-1.5 text-[12px] font-semibold text-slate-950 transition hover:bg-cyan-400 disabled:opacity-40"
              >
                {busy ? <SpinnerIcon className="h-3.5 w-3.5 animate-spin" /> : null}
                Save &amp; verify
              </button>
              {syncOn && (
                <button
                  type="button"
                  onClick={() => saveToken("")}
                  disabled={busy}
                  className="rounded-lg border border-rose-500/30 px-3 py-1.5 text-[12px] text-rose-300 transition hover:bg-rose-500/10 disabled:opacity-40"
                >
                  Turn off
                </button>
              )}
            </div>
          </div>

          {/* Guide */}
          <div className="mt-4 rounded-xl border border-white/10 bg-white/[0.02]">
            <button
              type="button"
              onClick={() => setShowGuide((v) => !v)}
              className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left"
            >
              <span className="text-[11px] font-medium uppercase tracking-[0.18em] text-cyan-300">
                How to set up reply sync (from zero)
              </span>
              <ChevronIcon className={"h-4 w-4 shrink-0 text-slate-400 transition " + (showGuide ? "rotate-90" : "")} />
            </button>
            {showGuide && (
              <div className="border-t border-white/5 px-3 py-3 text-[12px] leading-relaxed text-slate-300">
                <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-cyan-300">
                  A. Create the OAuth client (once)
                </div>
                <ol className="space-y-3">
                  <Step n={1} title="Open Google Cloud Console">
                    Go to <Ext href="https://console.cloud.google.com/">console.cloud.google.com</Ext>{" "}
                    and create a project.
                  </Step>
                  <Step n={2} title="Enable the Gmail API">
                    <Ext href="https://console.cloud.google.com/apis/library/gmail.googleapis.com">
                      APIs &amp; Services → enable “Gmail API”
                    </Ext>
                    .
                  </Step>
                  <Step n={3} title="Consent screen">
                    OAuth consent screen → External → add your Gmail as a{" "}
                    <span className="text-slate-100">Test user</span> → add the scope{" "}
                    <span className="font-mono text-slate-100">.../auth/gmail.readonly</span>{" "}
                    (reading replies is all this token is used for — sending goes over SMTP).
                  </Step>
                  <Step n={4} title="Create credentials">
                    Credentials → Create OAuth client ID →{" "}
                    <span className="text-slate-100">Web application</span> → add redirect URI{" "}
                    <span className="font-mono text-slate-100">
                      https://developers.google.com/oauthplayground
                    </span>
                    . Paste the Client ID &amp; Secret above (step 1).
                  </Step>
                </ol>
                <div className="mb-1 mt-4 text-[11px] font-semibold uppercase tracking-[0.16em] text-cyan-300">
                  B. Get this account’s refresh token
                </div>
                <ol className="space-y-3">
                  <Step n={5} title="OAuth Playground">
                    Open{" "}
                    <Ext href="https://developers.google.com/oauthplayground/">
                      developers.google.com/oauthplayground
                    </Ext>{" "}
                    → gear → tick <span className="text-slate-100">Use your own OAuth credentials</span> →
                    paste the same Client ID &amp; Secret.
                  </Step>
                  <Step n={6} title="Authorize">
                    Pick the scope{" "}
                    <span className="font-mono text-slate-100">
                      https://www.googleapis.com/auth/gmail.readonly
                    </span>{" "}
                    → Authorize → sign in <span className="text-slate-100">as {email}</span> → Allow.
                  </Step>
                  <Step n={7} title="Copy the refresh token">
                    Click <span className="text-slate-100">Exchange authorization code for tokens</span>,
                    copy the <span className="text-slate-100">Refresh token</span> (starts with{" "}
                    <span className="font-mono text-slate-100">1//</span>) and paste it in step 2.
                  </Step>
                  <li className="mt-1 rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2 text-[11px] text-slate-400">
                    While the consent screen is in Testing the token can expire in ~7 days. Click{" "}
                    <span className="text-slate-200">Publish app</span> to make it permanent.
                  </li>
                </ol>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-cyan-500/20 text-[11px] font-semibold text-cyan-200">
        {n}
      </span>
      <div>
        <div className="font-medium text-slate-100">{title}</div>
        <div className="text-slate-400">{children}</div>
      </div>
    </li>
  );
}

function Ext({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="text-cyan-400 underline decoration-cyan-400/40 hover:decoration-cyan-400">
      {children}
    </a>
  );
}

type IconProps = { className?: string };

function SyncIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
      <path d="M3 21v-5h5" />
    </svg>
  );
}

function CloseIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

function ChevronIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

function SpinnerIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className={className}>
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>
  );
}
