"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { MailIdentity } from "@/lib/types";
import ReplySyncModal from "@/components/ReplySyncModal";

// Manage the Gmail accounts the app sends from. Everything lives in the local
// database, so a shipped build starts empty and each user adds their own. Reply
// sync (reading replies) is configured per account in its own modal. A GitHub
// token (for scan rate limits) is also set here.

// Mirrors SenderBlock in lib/sender-blocks.ts — `sender` is always lowercased.
type SenderBlock = {
  sender: string;
  reason: string;
  detail: string;
  until: string;
};

type SendersState = {
  identities: MailIdentity[];
  stored: string[];
  smtpConfigured: boolean;
  replySync?: { clientConfigured: boolean; accounts: Record<string, boolean> };
  github?: { tokenSet: boolean };
  tracking?: { urlSet: boolean; enabled: boolean; url: string };
  /** Accounts Gmail policy-blocked; they resume at the next local midnight. */
  senderBlocks?: SenderBlock[];
};

type RemovedCounts = { history: number; queued: number; sequences: number };

export default function SendersModal({
  onClose,
  onChanged,
  focusSection = null,
}: {
  onClose: () => void;
  onChanged?: () => void;
  /** Opened straight to a section (e.g. from the Setup menu's "GitHub token"). */
  focusSection?: "github" | null;
}) {
  const [data, setData] = useState<SendersState | null>(null);

  // add-account form
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [appPassword, setAppPassword] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [smtpHost, setSmtpHost] = useState("smtp.gmail.com");
  const [smtpPort, setSmtpPort] = useState("465");
  const [smtpUser, setSmtpUser] = useState("");
  const [showGmailGuide, setShowGmailGuide] = useState(false);

  // github token
  const [githubToken, setGithubToken] = useState("");
  const [showGithubGuide, setShowGithubGuide] = useState(false);

  // open tracking
  const [trackingUrl, setTrackingUrl] = useState("");
  const [showTrackingGuide, setShowTrackingGuide] = useState(false);

  const [replyFor, setReplyFor] = useState<string | null>(null);
  const [pendingRemove, setPendingRemove] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);

  // Deep-link support: scroll to + briefly highlight the GitHub token section
  // when opened from the Setup menu's "GitHub token" item.
  const githubRef = useRef<HTMLDivElement>(null);
  const githubInputRef = useRef<HTMLInputElement>(null);
  const [flashGithub, setFlashGithub] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/senders");
      if (res.ok) setData((await res.json()) as SendersState);
    } catch {
      // ignore — keep last known state
    }
  }, []);

  useEffect(() => {
    void refresh();
    // A Gmail block can land while this modal is open, so keep it live —
    // slower than the queue modal, since nothing else here changes on its own.
    const id = window.setInterval(refresh, 20000);
    return () => window.clearInterval(id);
  }, [refresh]);

  useEffect(() => {
    if (focusSection !== "github") return;
    const t = window.setTimeout(() => {
      githubRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      githubInputRef.current?.focus({ preventScroll: true });
      setFlashGithub(true);
      window.setTimeout(() => setFlashGithub(false), 2200);
    }, 80);
    return () => window.clearTimeout(t);
  }, [focusSection]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !replyFor) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, replyFor]);

  const clientConfigured = !!data?.replySync?.clientConfigured;
  const syncAccounts = data?.replySync?.accounts ?? {};
  const blockByEmail = new Map(
    (data?.senderBlocks ?? []).map((b) => [b.sender, b]),
  );
  const githubTokenSet = !!data?.github?.tokenSet;
  const trackingUrlSet = !!data?.tracking?.urlSet;
  const trackingEnabled = !!data?.tracking?.enabled;
  const trackingCurrentUrl = data?.tracking?.url ?? "";

  const flash = (msg: string) => {
    setError(null);
    setOkMsg(msg);
  };

  const addAccount = async () => {
    setError(null);
    setOkMsg(null);
    setBusy(true);
    try {
      const payload: Record<string, unknown> = { name, email, appPassword };
      if (showAdvanced) {
        payload.smtpHost = smtpHost.trim() || "smtp.gmail.com";
        payload.smtpPort = Number(smtpPort) || 465;
        payload.smtpSecure = (Number(smtpPort) || 465) === 465;
        payload.smtpUser = smtpUser.trim() || email;
      }
      const res = await fetch("/api/senders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = (await res.json()) as SendersState & { ok: boolean; error?: string };
      if (!res.ok || !body.ok) {
        setError(body.error ?? "Could not add the account.");
        return;
      }
      setData(body);
      const added = email.trim().toLowerCase();
      setName("");
      setEmail("");
      setAppPassword("");
      setSmtpUser("");
      flash(`Added ${added} — verified and ready to send.`);
      onChanged?.();
    } catch {
      setError("Network error while adding the account.");
    } finally {
      setBusy(false);
    }
  };

  const removeAccount = async (addr: string) => {
    setError(null);
    setOkMsg(null);
    setBusy(true);
    setPendingRemove(null);
    try {
      const res = await fetch("/api/senders", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: addr }),
      });
      const body = (await res.json()) as SendersState & {
        ok: boolean;
        error?: string;
        removed?: RemovedCounts;
      };
      if (!res.ok || !body.ok) {
        setError(body.error ?? "Could not remove the account.");
        return;
      }
      setData(body);
      const r = body.removed;
      const extra = r
        ? ` Deleted ${r.history} history row${r.history === 1 ? "" : "s"}` +
          (r.queued ? `, ${r.queued} queued` : "") +
          (r.sequences ? `, ${r.sequences} sequence${r.sequences === 1 ? "" : "s"}` : "") +
          "."
        : "";
      flash(`Removed ${addr}.${extra}`);
      onChanged?.();
    } catch {
      setError("Network error while removing the account.");
    } finally {
      setBusy(false);
    }
  };

  const saveGithubToken = async (token: string) => {
    setError(null);
    setOkMsg(null);
    setBusy(true);
    try {
      const res = await fetch("/api/senders", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ githubToken: token }),
      });
      const body = (await res.json()) as SendersState & { ok: boolean; error?: string };
      if (!res.ok || !body.ok) {
        setError(body.error ?? "Could not save the GitHub token.");
        return;
      }
      setData(body);
      setGithubToken("");
      flash(token ? "GitHub token saved and verified." : "GitHub token removed.");
    } catch {
      setError("Network error while saving the GitHub token.");
    } finally {
      setBusy(false);
    }
  };

  const putTracking = async (payload: Record<string, unknown>, okText: string) => {
    setError(null);
    setOkMsg(null);
    setBusy(true);
    try {
      const res = await fetch("/api/senders", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = (await res.json()) as SendersState & { ok: boolean; error?: string };
      if (!res.ok || !body.ok) {
        setError(body.error ?? "Could not update open tracking.");
        return;
      }
      setData(body);
      setTrackingUrl("");
      flash(okText);
    } catch {
      setError("Network error while updating open tracking.");
    } finally {
      setBusy(false);
    }
  };

  const canAdd =
    !busy &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) &&
    appPassword.trim().length >= 8;

  return (
    <>
      <div
        className="fade-in fixed inset-0 z-[70] flex items-center justify-center bg-black/75 p-4"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <div className="glass slide-in relative flex max-h-[92vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl shadow-2xl shadow-black/50">
          <div className="flex-1 overflow-auto p-6">
            {/* Header */}
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <h3 className="flex items-center gap-2 text-lg font-semibold text-slate-100">
                  <MailIcon className="h-5 w-5 text-cyan-300" />
                  Accounts
                  {(data?.identities?.length ?? 0) > 0 && (
                    <span className="rounded-full bg-cyan-400/15 px-2 py-0.5 text-xs font-semibold text-cyan-200">
                      {data!.identities.length}
                    </span>
                  )}
                </h3>
                <p className="mt-1 text-xs text-slate-400">
                  Add the Gmail accounts you send from. Connect reply sync per
                  account. Everything is stored on this computer.
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

            {/* Messages */}
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

            {/* Current accounts */}
            <div className="space-y-2">
              {(data?.identities ?? []).length === 0 && (
                <p className="text-xs text-slate-500">No accounts yet. Add your first Gmail below.</p>
              )}
              {(data?.identities ?? []).map((id) => {
                const syncOn = !!syncAccounts[id.email.toLowerCase()];
                const block = blockByEmail.get(id.email.toLowerCase());
                return (
                  <div
                    key={id.email}
                    className="rounded-xl border border-white/5 bg-white/[0.02] px-3 py-2.5"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex min-w-0 items-center gap-3">
                        <AccountAvatar name={id.name} email={id.email} />
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium text-slate-100">{id.name}</div>
                          <div className="flex items-center gap-2">
                            <span className="truncate font-mono text-[11px] text-slate-400">{id.email}</span>
                            {block && (
                              // No time shown: this modal polls slowly, so a
                              // live-looking clock would read stale. The title
                              // carries the detail; Resume lives in the queue.
                              <span
                                title={`Gmail bounced this account with a policy block${
                                  block.detail ? `: ${block.detail}` : ""
                                }. Outreach skips it until the next local midnight, then resumes on its own. Open the Queue to resume it early.`}
                                className="shrink-0 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-300"
                              >
                                Paused — Gmail block
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => setReplyFor(id.email)}
                          className={
                            "inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[11px] font-medium transition " +
                            (syncOn
                              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20"
                              : "border-cyan-400/30 text-cyan-200 hover:bg-cyan-400/10")
                          }
                          title="Set up reading of incoming replies for this account"
                        >
                          <span className={"h-1.5 w-1.5 rounded-full " + (syncOn ? "bg-emerald-400" : "bg-slate-500")} />
                          Reply sync
                        </button>
                        {pendingRemove === id.email ? (
                          <>
                            <button
                              type="button"
                              onClick={() => removeAccount(id.email)}
                              disabled={busy}
                              className="rounded-lg bg-rose-500/90 px-2.5 py-1 text-[11px] font-semibold text-white transition hover:bg-rose-400 disabled:opacity-40"
                            >
                              Delete + history
                            </button>
                            <button
                              type="button"
                              onClick={() => setPendingRemove(null)}
                              className="rounded-lg border border-white/10 px-2.5 py-1 text-[11px] text-slate-300 transition hover:bg-white/5"
                            >
                              Cancel
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            onClick={() => {
                              setError(null);
                              setOkMsg(null);
                              setPendingRemove(id.email);
                            }}
                            disabled={busy}
                            className="rounded-lg border border-rose-500/30 px-2.5 py-1 text-[11px] font-medium text-rose-300 transition hover:bg-rose-500/10 disabled:opacity-40"
                          >
                            Remove
                          </button>
                        )}
                      </div>
                    </div>
                    {pendingRemove === id.email && (
                      <p className="mt-2 text-[11px] text-rose-300/90">
                        Removes the account and deletes its send history (hidden from
                        History &amp; Insights) plus any pending queue items from it.
                      </p>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Add account */}
            <div className="mt-5 rounded-2xl border border-white/10 bg-white/[0.03] p-4">
              <h4 className="mb-3 text-[11px] font-medium uppercase tracking-[0.22em] text-slate-400">
                Add a Gmail account
              </h4>
              <div className="space-y-2.5">
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Display name (e.g. Wael)"
                  className="w-full rounded-lg border border-white/10 bg-slate-900/70 px-3 py-2 text-sm text-slate-200 outline-none placeholder:text-slate-500 focus:border-cyan-400/50"
                />
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@gmail.com"
                  autoComplete="off"
                  className="w-full rounded-lg border border-white/10 bg-slate-900/70 px-3 py-2 text-sm text-slate-200 outline-none placeholder:text-slate-500 focus:border-cyan-400/50"
                />
                <input
                  type="text"
                  value={appPassword}
                  onChange={(e) => setAppPassword(e.target.value)}
                  placeholder="16-character App Password"
                  autoComplete="off"
                  className="w-full rounded-lg border border-white/10 bg-slate-900/70 px-3 py-2 font-mono text-sm text-slate-200 outline-none placeholder:font-sans placeholder:text-slate-500 focus:border-cyan-400/50"
                />
              </div>

              <button
                type="button"
                onClick={() => setShowAdvanced((v) => !v)}
                className="mt-2 flex items-center gap-1 text-[11px] font-medium text-slate-400 transition hover:text-slate-200"
              >
                <ChevronIcon className={"h-3.5 w-3.5 transition " + (showAdvanced ? "rotate-90" : "")} />
                Advanced (non-Gmail SMTP)
              </button>
              {showAdvanced && (
                <div className="mt-2 grid grid-cols-2 gap-2.5">
                  <input
                    type="text"
                    value={smtpHost}
                    onChange={(e) => setSmtpHost(e.target.value)}
                    placeholder="SMTP host"
                    className="col-span-2 rounded-lg border border-white/10 bg-slate-900/70 px-3 py-2 text-sm text-slate-200 outline-none placeholder:text-slate-500 focus:border-cyan-400/50"
                  />
                  <input
                    type="text"
                    value={smtpPort}
                    onChange={(e) => setSmtpPort(e.target.value)}
                    placeholder="Port (465)"
                    className="rounded-lg border border-white/10 bg-slate-900/70 px-3 py-2 text-sm text-slate-200 outline-none placeholder:text-slate-500 focus:border-cyan-400/50"
                  />
                  <input
                    type="text"
                    value={smtpUser}
                    onChange={(e) => setSmtpUser(e.target.value)}
                    placeholder="SMTP username (defaults to email)"
                    className="rounded-lg border border-white/10 bg-slate-900/70 px-3 py-2 text-sm text-slate-200 outline-none placeholder:text-slate-500 focus:border-cyan-400/50"
                  />
                </div>
              )}

              <button
                type="button"
                onClick={addAccount}
                disabled={!canAdd}
                className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg bg-cyan-500/90 px-3 py-2 text-sm font-semibold text-slate-950 transition hover:bg-cyan-400 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {busy ? (
                  <>
                    <SpinnerIcon className="h-4 w-4 animate-spin" />
                    Verifying…
                  </>
                ) : (
                  <>
                    <PlusIcon className="h-4 w-4" />
                    Add account
                  </>
                )}
              </button>

              <Collapsible
                open={showGmailGuide}
                onToggle={() => setShowGmailGuide((v) => !v)}
                title="How to get a Gmail App Password (from zero)"
              >
                <ol className="space-y-3">
                  <Step n={1} title="Open your Google Account">
                    Go to <Ext href="https://myaccount.google.com/">myaccount.google.com</Ext> and
                    sign in with the Gmail you want to send from.
                  </Step>
                  <Step n={2} title="Turn on 2-Step Verification">
                    Open{" "}
                    <Ext href="https://myaccount.google.com/signinoptions/twosv">
                      Security → 2-Step Verification
                    </Ext>{" "}
                    and finish setup.
                  </Step>
                  <Step n={3} title="Open App Passwords">
                    Go to{" "}
                    <Ext href="https://myaccount.google.com/apppasswords">
                      myaccount.google.com/apppasswords
                    </Ext>{" "}
                    → name it (e.g. Outreach) → Create.
                  </Step>
                  <Step n={4} title="Copy &amp; paste">
                    Copy the 16-character code into the App Password field above, then Add account.
                  </Step>
                </ol>
              </Collapsible>
            </div>

            {/* GitHub token */}
            <div
              ref={githubRef}
              className={
                "mt-4 rounded-2xl border p-4 transition-colors duration-500 " +
                (flashGithub
                  ? "border-cyan-400/60 bg-cyan-500/[0.06] ring-2 ring-cyan-400/40"
                  : "border-white/10 bg-white/[0.03]")
              }
            >
              <div className="mb-1 flex items-center justify-between gap-2">
                <h4 className="text-[11px] font-medium uppercase tracking-[0.22em] text-slate-400">
                  GitHub access token
                </h4>
                <span
                  className={
                    "rounded-full border px-2 py-0.5 text-[10px] font-medium " +
                    (githubTokenSet
                      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                      : "border-white/10 bg-white/[0.03] text-slate-500")
                  }
                >
                  {githubTokenSet ? "Set" : "Not set"}
                </span>
              </div>
              <p className="mb-3 text-[11px] leading-relaxed text-slate-500">
                Optional but recommended: raises scanning from 60 to 5,000 requests/hour.
                Use your own token — it stays on this computer.
              </p>
              <div className="flex items-center gap-2">
                <input
                  ref={githubInputRef}
                  type="text"
                  value={githubToken}
                  onChange={(e) => setGithubToken(e.target.value)}
                  placeholder={githubTokenSet ? "Token set — paste to replace" : "ghp_… or github_pat_…"}
                  autoComplete="off"
                  className="min-w-0 flex-1 rounded-lg border border-white/10 bg-slate-900/70 px-3 py-2 font-mono text-[12px] text-slate-200 outline-none placeholder:font-sans placeholder:text-slate-500 focus:border-cyan-400/50"
                />
                <button
                  type="button"
                  onClick={() => saveGithubToken(githubToken.trim())}
                  disabled={busy || githubToken.trim().length < 10}
                  className="shrink-0 rounded-lg border border-cyan-400/40 bg-cyan-500/10 px-3 py-2 text-[12px] font-semibold text-cyan-200 transition hover:bg-cyan-400/20 disabled:opacity-40"
                >
                  Save
                </button>
                {githubTokenSet && (
                  <button
                    type="button"
                    onClick={() => saveGithubToken("")}
                    disabled={busy}
                    className="shrink-0 rounded-lg border border-rose-500/30 px-3 py-2 text-[12px] text-rose-300 transition hover:bg-rose-500/10 disabled:opacity-40"
                  >
                    Clear
                  </button>
                )}
              </div>
              <Collapsible
                open={showGithubGuide}
                onToggle={() => setShowGithubGuide((v) => !v)}
                title="How to create a GitHub token (from zero)"
              >
                <ol className="space-y-3">
                  <Step n={1} title="Open token settings">
                    Signed in to GitHub, go to{" "}
                    <Ext href="https://github.com/settings/tokens">github.com/settings/tokens</Ext>.
                  </Step>
                  <Step n={2} title="Generate a token">
                    Click <span className="text-slate-100">Generate new token</span>. Either a{" "}
                    classic token, or a fine-grained token with{" "}
                    <span className="text-slate-100">Public repositories (read-only)</span> access —
                    both work. No special scopes are needed for public data.
                  </Step>
                  <Step n={3} title="Copy &amp; paste">
                    Copy the token (starts with{" "}
                    <span className="font-mono text-slate-100">ghp_</span> or{" "}
                    <span className="font-mono text-slate-100">github_pat_</span>) and paste it above →
                    Save. We check it against GitHub before saving.
                  </Step>
                </ol>
              </Collapsible>
            </div>

            {/* Open tracking */}
            <div className="mt-4 rounded-2xl border border-white/10 bg-white/[0.03] p-4">
              <div className="mb-1 flex items-center justify-between gap-2">
                <h4 className="text-[11px] font-medium uppercase tracking-[0.22em] text-slate-400">
                  Open tracking
                </h4>
                <span
                  className={
                    "rounded-full border px-2 py-0.5 text-[10px] font-medium " +
                    (trackingUrlSet && trackingEnabled
                      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                      : trackingUrlSet
                        ? "border-amber-500/30 bg-amber-500/10 text-amber-300"
                        : "border-white/10 bg-white/[0.03] text-slate-500")
                  }
                >
                  {trackingUrlSet ? (trackingEnabled ? "On" : "Paused") : "Not set"}
                </span>
              </div>
              <p className="mb-3 text-[11px] leading-relaxed text-slate-500">
                See when recipients open your emails. Needs a small free tracking
                service (a Cloudflare Worker) — paste its URL. Opens are a rough
                signal, not exact; replies stay the strongest one.
              </p>
              {trackingUrlSet && (
                <div className="mb-2 flex items-center justify-between gap-2 rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2">
                  <span className="truncate font-mono text-[11px] text-slate-300">{trackingCurrentUrl}</span>
                  <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-[11px] text-slate-400">
                    <input
                      type="checkbox"
                      checked={trackingEnabled}
                      onChange={(e) =>
                        putTracking(
                          { trackingEnabled: e.target.checked },
                          e.target.checked ? "Open tracking enabled." : "Open tracking paused.",
                        )
                      }
                      className="h-3.5 w-3.5 accent-cyan-500"
                    />
                    Enabled
                  </label>
                </div>
              )}
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={trackingUrl}
                  onChange={(e) => setTrackingUrl(e.target.value)}
                  placeholder={trackingUrlSet ? "Replace URL…" : "https://open-tracking.you.workers.dev"}
                  autoComplete="off"
                  className="min-w-0 flex-1 rounded-lg border border-white/10 bg-slate-900/70 px-3 py-2 font-mono text-[12px] text-slate-200 outline-none placeholder:font-sans placeholder:text-slate-500 focus:border-cyan-400/50"
                />
                <button
                  type="button"
                  onClick={() => putTracking({ trackingUrl: trackingUrl.trim() }, "Tracking service connected.")}
                  disabled={busy || !/^https?:\/\//i.test(trackingUrl.trim())}
                  className="shrink-0 rounded-lg border border-cyan-400/40 bg-cyan-500/10 px-3 py-2 text-[12px] font-semibold text-cyan-200 transition hover:bg-cyan-400/20 disabled:opacity-40"
                >
                  Save
                </button>
                {trackingUrlSet && (
                  <button
                    type="button"
                    onClick={() => putTracking({ trackingUrl: "" }, "Tracking disconnected.")}
                    disabled={busy}
                    className="shrink-0 rounded-lg border border-rose-500/30 px-3 py-2 text-[12px] text-rose-300 transition hover:bg-rose-500/10 disabled:opacity-40"
                  >
                    Clear
                  </button>
                )}
              </div>
              <Collapsible
                open={showTrackingGuide}
                onToggle={() => setShowTrackingGuide((v) => !v)}
                title="How to set up open tracking (from zero)"
              >
                <ol className="space-y-3">
                  <Step n={1} title="Install Wrangler">
                    On any computer: <span className="font-mono text-slate-100">npm i -g wrangler</span> then{" "}
                    <span className="font-mono text-slate-100">wrangler login</span>.
                  </Step>
                  <Step n={2} title="Deploy the Worker">
                    Open <span className="font-mono text-slate-100">tracking-worker/</span> → run{" "}
                    <span className="font-mono text-slate-100">wrangler kv namespace create OPENS</span> (paste the
                    id into wrangler.toml) → <span className="font-mono text-slate-100">wrangler deploy</span>.
                  </Step>
                  <Step n={3} title="Paste the URL">
                    Wrangler prints a URL like{" "}
                    <span className="font-mono text-slate-100">https://open-tracking.you.workers.dev</span> — paste
                    it above and Save.
                  </Step>
                  <li className="mt-1 rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2 text-[11px] text-slate-400">
                    Tracking switches emails to HTML with a hidden 1×1 pixel. Opens are approximate (Apple Mail and
                    image-blockers skew them) — replies remain the strongest signal.
                  </li>
                </ol>
              </Collapsible>
            </div>
          </div>
        </div>
      </div>

      {replyFor && (
        <ReplySyncModal
          email={replyFor}
          clientConfigured={clientConfigured}
          syncOn={!!syncAccounts[replyFor.toLowerCase()]}
          onClose={() => setReplyFor(null)}
          onChanged={(snap) => {
            setData((prev) => ({ ...(prev as SendersState), ...snap }));
            onChanged?.();
          }}
        />
      )}
    </>
  );
}

function Collapsible({
  open,
  onToggle,
  title,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-3 rounded-xl border border-white/10 bg-white/[0.02]">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left"
      >
        <span className="text-[11px] font-medium uppercase tracking-[0.18em] text-cyan-300">
          {title}
        </span>
        <ChevronIcon className={"h-4 w-4 shrink-0 text-slate-400 transition " + (open ? "rotate-90" : "")} />
      </button>
      {open && (
        <div className="border-t border-white/5 px-3 py-3 text-[12px] leading-relaxed text-slate-300">
          {children}
        </div>
      )}
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

// Stable identity colour per sending account — mirrors the sender colour-coding
// used in the History table so an account reads the same everywhere. Known
// accounts get a fixed hue; anything else hashes into a small fallback set.
const KNOWN_SENDER_COLORS: Record<string, string> = {
  "imagesatomic@gmail.com": "#38bdf8",
  "creativeengineer166@gmail.com": "#a78bfa",
  "dwicenterlifechanges@gmail.com": "#34d399",
  "dvdkbrk@gmail.com": "#fbbf24",
};
const FALLBACK_SENDER_HEX = ["#fb7185", "#2dd4bf", "#818cf8", "#fb923c"];

function accountColorHex(email: string): string {
  const key = email.trim().toLowerCase();
  if (KNOWN_SENDER_COLORS[key]) return KNOWN_SENDER_COLORS[key];
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash + key.charCodeAt(i) * 17) % 997;
  return FALLBACK_SENDER_HEX[hash % FALLBACK_SENDER_HEX.length];
}

function AccountAvatar({ name, email }: { name: string; email: string }) {
  const color = accountColorHex(email);
  const initial = (name.trim()[0] || email.trim()[0] || "?").toUpperCase();
  return (
    <span
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-semibold"
      style={{
        color,
        backgroundColor: `${color}22`,
        boxShadow: `inset 0 0 0 1px ${color}55`,
      }}
      aria-hidden
    >
      {initial}
    </span>
  );
}

type IconProps = { className?: string };

function MailIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="m22 7-10 6L2 7" />
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

function PlusIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M12 5v14M5 12h14" />
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
