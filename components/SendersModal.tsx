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

/** An account's SMTP connection settings. The password is never sent here —
 *  only whether one is on file. Mirrors `smtp` in the /api/senders snapshot. */
type SmtpInfo = {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  hasPass: boolean;
};

/** Result of the last SMTP connect + login for one account (in-memory on the
 *  server, so it is absent until a check has run). */
type SenderHealth = {
  email: string;
  ok: boolean;
  /** 'host:port' that was tried. */
  target: string;
  error: string;
  unconfigured: boolean;
  checkedAt: string;
};

/** A port that answered when the account's own one didn't. */
type Suggestion = { email: string; host: string; port: number; secure: boolean };

type SendersState = {
  identities: MailIdentity[];
  stored: string[];
  smtpConfigured: boolean;
  smtp?: Record<string, SmtpInfo>;
  health?: SenderHealth[];
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

  // reconnect — renew a connected account's SMTP settings in place. The app
  // password field stays empty on open: the stored one is reused unless the
  // user actually pastes a new one.
  const [renewFor, setRenewFor] = useState<string | null>(null);
  const [renewHost, setRenewHost] = useState("smtp.gmail.com");
  const [renewPort, setRenewPort] = useState("465");
  const [renewUser, setRenewUser] = useState("");
  const [renewPass, setRenewPass] = useState("");
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  /** Account currently being verified — "*" while re-checking all of them. */
  const [checking, setChecking] = useState<string | null>(null);

  const [replyFor, setReplyFor] = useState<string | null>(null);
  const [pendingRemove, setPendingRemove] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);
  // A caveat the server attached to an otherwise successful save — the account
  // was stored but may not actually be able to send (e.g. its app password
  // could not be verified because outbound SMTP is blocked here). Amber and
  // separate from okMsg: a green "ready to send" would be a plain lie.
  const [warnMsg, setWarnMsg] = useState<string | null>(null);

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
  const healthByEmail = new Map(
    (data?.health ?? []).map((h) => [h.email.toLowerCase(), h]),
  );
  const smtpByEmail = data?.smtp ?? {};
  const githubTokenSet = !!data?.github?.tokenSet;
  const trackingUrlSet = !!data?.tracking?.urlSet;
  const trackingEnabled = !!data?.tracking?.enabled;
  const trackingCurrentUrl = data?.tracking?.url ?? "";

  const clearMsgs = () => {
    setError(null);
    setOkMsg(null);
    setWarnMsg(null);
  };

  const flash = (msg: string) => {
    clearMsgs();
    setOkMsg(msg);
  };

  const addAccount = async () => {
    clearMsgs();
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
      const body = (await res.json()) as SendersState & {
        ok: boolean;
        error?: string;
        warning?: string;
      };
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
      // The account is saved either way, but only claim it can send when the
      // server actually reached the SMTP server and signed in.
      if (body.warning) {
        clearMsgs();
        setWarnMsg(`Added ${added}. ${body.warning}`);
      } else {
        flash(`Added ${added} — verified and ready to send.`);
      }
      onChanged?.();
    } catch {
      setError("Network error while adding the account.");
    } finally {
      setBusy(false);
    }
  };

  /** Fold fresh check results into the account list without a full refetch. */
  const mergeHealth = (results: SenderHealth[]) => {
    setData((prev) => {
      if (!prev) return prev;
      const next = new Map(
        (prev.health ?? []).map((h) => [h.email.toLowerCase(), h] as const),
      );
      for (const r of results) next.set(r.email.toLowerCase(), r);
      return { ...prev, health: [...next.values()] };
    });
  };

  // Re-run the SMTP connect + login. Without an address every account is
  // checked; with one, `probe` also tries the other standard port when the
  // account's own one can't be reached, so a blocked 465 has an obvious fix.
  const recheck = async (addr?: string) => {
    clearMsgs();
    setSuggestion(null);
    setChecking(addr ?? "*");
    try {
      const res = await fetch("/api/senders/health", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(addr ? { email: addr, probe: true } : {}),
      });
      const body = (await res.json()) as {
        ok: boolean;
        error?: string;
        results?: SenderHealth[];
        suggestion?: Suggestion | null;
      };
      if (!res.ok || !body.ok) {
        setError(body.error ?? "Could not check the connection.");
        return;
      }
      const results = body.results ?? [];
      mergeHealth(results);
      if (body.suggestion) setSuggestion(body.suggestion);

      const failed = results.filter((r) => !r.ok);
      if (failed.length === 0) {
        flash(
          addr
            ? `${addr} — connected and signed in.`
            : `All ${results.length} account(s) connected and signed in.`,
        );
      } else if (body.suggestion) {
        clearMsgs();
        setWarnMsg(
          `Port ${body.suggestion.port} works for ${body.suggestion.email} — apply it below to reconnect.`,
        );
      } else {
        clearMsgs();
        setWarnMsg(
          addr
            ? `${addr} — ${failed[0]?.error || "could not connect"}`
            : `${failed.length} of ${results.length} account(s) could not connect. Open Reconnect on each to fix it.`,
        );
      }
    } catch {
      setError("Network error while checking the connection.");
    } finally {
      setChecking(null);
    }
  };

  const openRenew = (addr: string) => {
    clearMsgs();
    setSuggestion(null);
    setPendingRemove(null);
    const cur = smtpByEmail[addr.toLowerCase()];
    setRenewHost(cur?.host ?? "smtp.gmail.com");
    setRenewPort(String(cur?.port ?? 465));
    setRenewUser(cur?.user ?? addr);
    setRenewPass("");
    setRenewFor(addr);
  };

  // Save renewed connection settings for an existing account. An empty password
  // field keeps the stored one — this flow is usually about the port or host,
  // not the credentials.
  const saveRenew = async (addr: string) => {
    clearMsgs();
    setBusy(true);
    try {
      const port = Number(renewPort) || 465;
      const res = await fetch("/api/senders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: addr,
          appPassword: renewPass.trim(),
          smtpHost: renewHost.trim() || "smtp.gmail.com",
          smtpPort: port,
          smtpSecure: port === 465,
          smtpUser: renewUser.trim() || addr,
        }),
      });
      const body = (await res.json()) as SendersState & {
        ok: boolean;
        error?: string;
        warning?: string;
      };
      if (!res.ok || !body.ok) {
        setError(body.error ?? "Could not update the connection.");
        return;
      }
      setData(body);
      setRenewPass("");
      setSuggestion(null);
      if (body.warning) {
        clearMsgs();
        setWarnMsg(`Updated ${addr}. ${body.warning}`);
      } else {
        setRenewFor(null);
        flash(`Reconnected ${addr} — verified and ready to send.`);
      }
      onChanged?.();
    } catch {
      setError("Network error while updating the connection.");
    } finally {
      setBusy(false);
    }
  };

  const removeAccount = async (addr: string) => {
    clearMsgs();
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
    clearMsgs();
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
    clearMsgs();
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
            {warnMsg && !error && (
              <p className="mb-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200">
                {warnMsg}
              </p>
            )}

            {/* Current accounts */}
            {(data?.identities ?? []).length > 0 && (
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="text-[11px] font-medium uppercase tracking-[0.22em] text-slate-400">
                  Connections
                </span>
                <button
                  type="button"
                  onClick={() => recheck()}
                  disabled={busy || checking !== null}
                  title="Open a real SMTP connection for every account and sign in, right now"
                  className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 px-2.5 py-1 text-[11px] font-medium text-slate-300 transition hover:bg-white/5 disabled:opacity-40"
                >
                  {checking === "*" ? (
                    <SpinnerIcon className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <RefreshIcon className="h-3.5 w-3.5" />
                  )}
                  {checking === "*" ? "Checking…" : "Recheck all"}
                </button>
              </div>
            )}
            <div className="space-y-2">
              {(data?.identities ?? []).length === 0 && (
                <p className="text-xs text-slate-500">No accounts yet. Add your first Gmail below.</p>
              )}
              {(data?.identities ?? []).map((id) => {
                const key = id.email.toLowerCase();
                const syncOn = !!syncAccounts[key];
                const block = blockByEmail.get(key);
                const hp = healthByEmail.get(key);
                const smtp = smtpByEmail[key];
                const renewing = renewFor === id.email;
                const sug = suggestion?.email.toLowerCase() === key ? suggestion : null;
                // A password must be typed when there is none on file, or when
                // the form points the account at a different server than the one
                // the stored password belongs to (the server refuses to replay
                // it elsewhere). Port and username changes stay password-free.
                const needsPass =
                  renewing &&
                  renewPass.trim().length < 8 &&
                  (!smtp?.hasPass ||
                    renewHost.trim().toLowerCase() !== smtp.host.toLowerCase());
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
                            <HealthBadge health={hp} checking={checking === id.email} />
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
                          onClick={() => (renewing ? setRenewFor(null) : openRenew(id.email))}
                          disabled={busy}
                          title="Re-test this account's SMTP connection, or renew its host, port, username and app password"
                          className={
                            "inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[11px] font-medium transition disabled:opacity-40 " +
                            (renewing
                              ? "border-cyan-400/50 bg-cyan-400/10 text-cyan-200"
                              : hp && !hp.ok
                                ? "border-amber-500/40 bg-amber-500/10 text-amber-200 hover:bg-amber-500/20"
                                : "border-white/10 text-slate-300 hover:bg-white/5")
                          }
                        >
                          <RefreshIcon className="h-3.5 w-3.5" />
                          Reconnect
                        </button>
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
                              clearMsgs();
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

                    {renewing && (
                      <div className="mt-3 space-y-2.5 rounded-xl border border-white/10 bg-slate-950/40 p-3">
                        <p className="text-[11px] leading-relaxed text-slate-400">
                          {hp
                            ? hp.ok
                              ? `Connected — SMTP login ok on ${hp.target}, checked at ${checkTime(hp.checkedAt)}.`
                              : `Last check at ${checkTime(hp.checkedAt)} failed${hp.target ? ` on ${hp.target}` : ""}: ${hp.error}`
                            : "Not checked since the app started. Test the connection, or change the settings below and save."}
                        </p>

                        {hp && !hp.ok && !hp.unconfigured && isTimeout(hp.error) && (
                          <p className="text-[11px] leading-relaxed text-slate-500">
                            A timeout means the server never answered, so this says
                            nothing about your app password. Try the other port below.
                            If 465 and 587 both time out, the block is outside the app —
                            usually a VPN or proxy tunnel, a firewall, or antivirus mail
                            scanning sitting on the connection. Disconnect the VPN and
                            test again.
                          </p>
                        )}

                        {sug && (
                          <div className="flex items-center justify-between gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2">
                            <span className="text-[11px] leading-relaxed text-emerald-200">
                              Port {sug.port} connected and signed in
                              {sug.secure ? " (SSL)" : " (STARTTLS)"}. Your current
                              port is blocked on this network.
                            </span>
                            <button
                              type="button"
                              onClick={() => {
                                setRenewHost(sug.host);
                                setRenewPort(String(sug.port));
                              }}
                              className="shrink-0 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1 text-[11px] font-semibold text-emerald-200 transition hover:bg-emerald-500/20"
                            >
                              Use port {sug.port}
                            </button>
                          </div>
                        )}

                        <div className="grid grid-cols-2 gap-2.5">
                          <input
                            type="text"
                            value={renewHost}
                            onChange={(e) => setRenewHost(e.target.value)}
                            placeholder="SMTP host"
                            className="col-span-2 rounded-lg border border-white/10 bg-slate-900/70 px-3 py-2 text-sm text-slate-200 outline-none placeholder:text-slate-500 focus:border-cyan-400/50"
                          />
                          <input
                            type="text"
                            value={renewPort}
                            onChange={(e) => setRenewPort(e.target.value)}
                            placeholder="Port"
                            className="rounded-lg border border-white/10 bg-slate-900/70 px-3 py-2 text-sm text-slate-200 outline-none placeholder:text-slate-500 focus:border-cyan-400/50"
                          />
                          <input
                            type="text"
                            value={renewUser}
                            onChange={(e) => setRenewUser(e.target.value)}
                            placeholder="SMTP username"
                            className="rounded-lg border border-white/10 bg-slate-900/70 px-3 py-2 text-sm text-slate-200 outline-none placeholder:text-slate-500 focus:border-cyan-400/50"
                          />
                          <input
                            type="text"
                            value={renewPass}
                            onChange={(e) => setRenewPass(e.target.value)}
                            placeholder={
                              needsPass
                                ? `App password for ${renewHost.trim()}`
                                : "New app password (leave blank to keep current)"
                            }
                            autoComplete="off"
                            className="col-span-2 rounded-lg border border-white/10 bg-slate-900/70 px-3 py-2 font-mono text-sm text-slate-200 outline-none placeholder:font-sans placeholder:text-slate-500 focus:border-cyan-400/50"
                          />
                        </div>

                        {needsPass && (
                          // Mirrors the server rule: the stored password is only
                          // ever replayed to the account's own server, so moving
                          // it elsewhere has to be typed out.
                          <p className="text-[11px] leading-relaxed text-amber-300/90">
                            {smtp?.hasPass
                              ? `Enter the app password for ${renewHost.trim()} — the one on file belongs to ${smtp.host} and is not sent to a different server.`
                              : "Enter the account's app password (16 characters for Gmail)."}
                          </p>
                        )}

                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="mr-1 text-[11px] text-slate-500">Port:</span>
                          {[
                            { port: "465", label: "465 · SSL" },
                            { port: "587", label: "587 · STARTTLS" },
                          ].map((p) => (
                            <button
                              key={p.port}
                              type="button"
                              onClick={() => setRenewPort(p.port)}
                              className={
                                "rounded-lg border px-2 py-0.5 text-[11px] font-medium transition " +
                                (renewPort.trim() === p.port
                                  ? "border-cyan-400/50 bg-cyan-400/10 text-cyan-200"
                                  : "border-white/10 text-slate-400 hover:bg-white/5")
                              }
                            >
                              {p.label}
                            </button>
                          ))}
                        </div>

                        <div className="flex flex-wrap items-center gap-2 pt-0.5">
                          <button
                            type="button"
                            onClick={() => recheck(id.email)}
                            disabled={busy || checking !== null}
                            title="Try the stored settings now, and the other standard port if this one can't be reached"
                            className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-1.5 text-[12px] font-medium text-slate-200 transition hover:bg-white/5 disabled:opacity-40"
                          >
                            {checking === id.email ? (
                              <>
                                <SpinnerIcon className="h-3.5 w-3.5 animate-spin" />
                                Testing…
                              </>
                            ) : (
                              <>
                                <PlugIcon className="h-3.5 w-3.5" />
                                Test connection
                              </>
                            )}
                          </button>
                          <button
                            type="button"
                            onClick={() => saveRenew(id.email)}
                            disabled={busy || checking !== null || needsPass}
                            className="inline-flex items-center gap-1.5 rounded-lg bg-cyan-500/90 px-3 py-1.5 text-[12px] font-semibold text-slate-950 transition hover:bg-cyan-400 disabled:opacity-40"
                          >
                            {busy ? (
                              <>
                                <SpinnerIcon className="h-3.5 w-3.5 animate-spin" />
                                Verifying…
                              </>
                            ) : (
                              "Save & reconnect"
                            )}
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setRenewFor(null);
                              setSuggestion(null);
                            }}
                            className="rounded-lg border border-white/10 px-3 py-1.5 text-[12px] text-slate-300 transition hover:bg-white/5"
                          >
                            Cancel
                          </button>
                        </div>
                        <p className="text-[11px] leading-relaxed text-slate-500">
                          Saving re-verifies the login and drops the cached connection,
                          so the next send uses these settings. History, queue and reply
                          sync for this account are untouched.
                        </p>
                      </div>
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

/** A connection-level failure (the server never answered), as opposed to a
 *  rejected login — the two need completely different fixes. Kept in sync with
 *  isSmtpUnreachable in lib/mail.ts, which decides server-side whether an
 *  account is saved unverified; it can't be imported here because that module
 *  pulls in nodemailer. */
function isTimeout(error: string): boolean {
  return /timeout|timed out|ETIMEDOUT|ETIMEOUT|ECONNRESET|ECONNREFUSED|ESOCKET|EDNS|ENETUNREACH|EHOSTUNREACH|greeting never received/i.test(
    error,
  );
}

/** Local wall-clock time of a check, e.g. "08:29". */
function checkTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "unknown time"
    : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// Whether this account can actually reach its SMTP server right now. Absent
// until a check has run (the server holds these in memory), which is why
// "Not checked" is a distinct state from a failure rather than a red badge.
function HealthBadge({
  health,
  checking,
}: {
  health?: SenderHealth;
  checking: boolean;
}) {
  const base = "shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium ";
  if (checking) {
    return (
      <span className={base + "border-cyan-400/30 bg-cyan-400/10 text-cyan-200"}>
        Checking…
      </span>
    );
  }
  if (!health) {
    return (
      <span
        title="Not checked since the app started. Use Recheck all, or Reconnect on this account."
        className={base + "border-white/10 bg-white/[0.03] text-slate-500"}
      >
        Not checked
      </span>
    );
  }
  if (health.ok) {
    return (
      <span
        title={`SMTP login ok on ${health.target}, checked at ${checkTime(health.checkedAt)}.`}
        className={base + "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"}
      >
        Connected
      </span>
    );
  }
  return (
    <span
      title={`${health.target ? `${health.target}: ` : ""}${health.error} (checked at ${checkTime(
        health.checkedAt,
      )}). Open Reconnect to test again or change the port.`}
      className={base + "border-rose-500/30 bg-rose-500/10 text-rose-300"}
    >
      {health.unconfigured ? "No credentials" : "Can't connect"}
    </span>
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

function RefreshIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M21 12a9 9 0 0 1-9 9 9 9 0 0 1-7.35-3.8" />
      <path d="M3 12a9 9 0 0 1 9-9 9 9 0 0 1 7.35 3.8" />
      <path d="M21 3v5h-5" />
      <path d="M3 21v-5h5" />
    </svg>
  );
}

function PlugIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M9 2v6M15 2v6" />
      <path d="M6 8h12v3a6 6 0 0 1-6 6 6 6 0 0 1-6-6V8Z" />
      <path d="M12 17v5" />
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
