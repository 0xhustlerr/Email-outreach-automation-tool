"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { MailIdentity, SignatureScope } from "@/lib/types";
import ReplySyncModal from "@/components/ReplySyncModal";
import { renderSignature, textToEmailHtml } from "@/lib/mail-html";
import {
  Card,
  EmptyState,
  PageBody,
  PageHeader,
  Segmented,
  StatCard,
  StatGrid,
} from "@/components/ui/dashboard";

// Manage the Gmail accounts the app sends from. Everything lives in the local
// database, so a shipped build starts empty and each user adds their own. Reply
// sync (reading replies) is configured per account in its own modal. Rendered
// as two pages: Accounts (default) and Integrations (`focusSection="github"`:
// the GitHub token for scan rate limits, and open tracking).

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
  /** Each Sender's Signature (plain text or HTML, '' = none) and its scope. */
  signatures?: Record<string, { signature: string; scope: SignatureScope }>;
  health?: SenderHealth[];
  replySync?: {
    /** Global fallback client exists (legacy shared-client setups / env). */
    clientConfigured: boolean;
    /** Per inbox: its own stored client, or the global fallback. */
    accountClients?: Record<string, boolean>;
    accounts: Record<string, boolean>;
    /** Why an account's inbox could not be read on the last sync cycle. */
    accountErrors?: Record<string, { error: string; needsReauth: boolean }>;
    /** Null until the first cycle runs — until then `accounts` means "token on
     *  file", not "token verified". */
    lastSyncAt?: string | null;
  };
  github?: { tokenSet: boolean };
  tracking?: { urlSet: boolean; enabled: boolean; url: string };
  /** Accounts Gmail policy-blocked; they resume at the next local midnight. */
  senderBlocks?: SenderBlock[];
};

type RemovedCounts = { history: number; sequences: number };

/** Longest Signature the server accepts — Gmail's own limit. */
const SIG_MAX = 10_000;

export default function SendersModal({
  onChanged,
  focusSection = null,
}: {
  onClose: () => void;
  asPage?: boolean;
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

  // rename — inline edit of a connected account's display name.
  const [renameFor, setRenameFor] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  // signature — inline editor for one account's Signature. A Gmail pull only
  // fills the draft; nothing is stored until Save.
  const [sigFor, setSigFor] = useState<string | null>(null);
  const [sigDraft, setSigDraft] = useState("");
  const [sigScope, setSigScope] = useState<SignatureScope>("all");
  const [pulling, setPulling] = useState(false);
  // Shown inside the editor: the page-level messages sit above the account
  // list, usually scrolled out of view from the row being edited.
  const [sigMsg, setSigMsg] = useState<{ kind: "error" | "warn" | "ok"; text: string } | null>(null);

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

  // The Integrations page focuses the token field on open; the Accounts page's
  // header "Add account" button jumps to the add form.
  const githubInputRef = useRef<HTMLInputElement>(null);
  const addCardRef = useRef<HTMLDivElement>(null);
  const addNameRef = useRef<HTMLInputElement>(null);

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
      githubInputRef.current?.focus({ preventScroll: true });
    }, 80);
    return () => window.clearTimeout(t);
  }, [focusSection]);

  const clientConfigured = !!data?.replySync?.clientConfigured;
  const syncAccounts = data?.replySync?.accounts ?? {};
  const syncErrors = data?.replySync?.accountErrors ?? {};
  const blockByEmail = new Map(
    (data?.senderBlocks ?? []).map((b) => [b.sender, b]),
  );
  const healthByEmail = new Map(
    (data?.health ?? []).map((h) => [h.email.toLowerCase(), h]),
  );
  const smtpByEmail = data?.smtp ?? {};
  const sigByEmail = data?.signatures ?? {};
  const sigTooLong = sigDraft.trim().length > SIG_MAX;
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
  // checked — including a fresh reply-sync token exchange per account — while
  // with one, `probe` also tries the other standard port when the account's
  // own one can't be reached, so a blocked 465 has an obvious fix.
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
        /** Present on the all-accounts check: reply-sync tokens re-verified.
         *  Counts only — the per-inbox detail lands in the refetched snapshot. */
        replySync?: { checked: number; broken: number };
      };
      if (!res.ok || !body.ok) {
        setError(body.error ?? "Could not check the connection.");
        return;
      }
      const results = body.results ?? [];
      mergeHealth(results);
      if (body.suggestion) setSuggestion(body.suggestion);
      // The all-accounts check also re-verified reply sync server-side; refetch
      // the snapshot so the per-account badges pick up the fresh result.
      if (!addr) void refresh();

      const failed = results.filter((r) => !r.ok);
      const replyChecked = body.replySync?.checked ?? 0;
      const replyBroken = body.replySync?.broken ?? 0;
      const replyNote =
        replyChecked === 0
          ? ""
          : replyBroken === 0
            ? ` Reply sync verified on ${replyChecked} inbox(es).`
            : ` Reply sync is broken on ${replyBroken} of ${replyChecked} inbox(es) — hover its badge for the reason.`;
      if (failed.length === 0 && replyBroken === 0) {
        flash(
          addr
            ? `${addr} — connected and signed in.`
            : `All ${results.length} account(s) connected and signed in.${replyNote}`,
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
            : failed.length > 0
              ? `${failed.length} of ${results.length} account(s) could not connect. Open Reconnect on each to fix it.${replyNote}`
              : `All ${results.length} account(s) connected and signed in.${replyNote}`,
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
    setSigFor(null);
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

  const openRename = (addr: string, current: string) => {
    clearMsgs();
    setPendingRemove(null);
    setRenameValue(current);
    setRenameFor(addr);
  };

  // Change only the display name — no SMTP re-verification, unlike Reconnect.
  const saveRename = async (addr: string, current: string) => {
    const next = renameValue.trim();
    if (!next) {
      setError("Enter a display name.");
      return;
    }
    if (next === current) {
      setRenameFor(null);
      return;
    }
    clearMsgs();
    setBusy(true);
    try {
      const res = await fetch("/api/senders", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: addr, name: next }),
      });
      const body = (await res.json()) as SendersState & { ok: boolean; error?: string };
      if (!res.ok || !body.ok) {
        setError(body.error ?? "Could not rename the account.");
        return;
      }
      setData(body);
      setRenameFor(null);
      flash(`Renamed ${addr} to “${next}”.`);
      onChanged?.();
    } catch {
      setError("Network error while renaming the account.");
    } finally {
      setBusy(false);
    }
  };

  const openSignature = (addr: string) => {
    clearMsgs();
    setPendingRemove(null);
    setRenewFor(null);
    setSuggestion(null);
    const cur = sigByEmail[addr.toLowerCase()];
    setSigDraft(cur?.signature ?? "");
    setSigScope(cur?.scope ?? "all");
    setSigMsg(null);
    setSigFor(addr);
  };

  // Store the draft (or '' to remove the signature) and its scope. Remove
  // passes the saved scope, so an unsaved toggle isn't stored with it.
  const saveSignature = async (
    addr: string,
    signature: string,
    signatureScope: SignatureScope = "all",
  ) => {
    clearMsgs();
    setSigMsg(null);
    setBusy(true);
    try {
      const res = await fetch("/api/senders", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: addr, signature, signatureScope }),
      });
      const body = (await res.json().catch(() => ({}))) as Partial<SendersState> & {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok || !body.ok) {
        setSigMsg({ kind: "error", text: body.error ?? `Could not save the signature (HTTP ${res.status}).` });
        return;
      }
      setData(body as SendersState);
      setSigFor(null);
      flash(
        signature.trim()
          ? `Saved the signature for ${addr}.`
          : `Removed the signature from ${addr}.`,
      );
      onChanged?.();
    } catch {
      setSigMsg({ kind: "error", text: "Network error while saving the signature." });
    } finally {
      setBusy(false);
    }
  };

  // Fetch the signature set in Gmail into the draft, for review before Save.
  const pullSignature = async (addr: string) => {
    clearMsgs();
    setSigMsg(null);
    setPulling(true);
    try {
      const res = await fetch("/api/senders/signature", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: addr }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        signature?: string;
        error?: string;
        needsReauth?: boolean;
      };
      if (!res.ok || !body.ok) {
        setSigMsg({
          kind: "error",
          text:
            (body.error ?? `Could not pull the Gmail signature (HTTP ${res.status}).`) +
            (body.needsReauth ? " Reconnect Reply sync for this account." : ""),
        });
        return;
      }
      const sig = (body.signature ?? "").trim();
      if (!sig) {
        setSigMsg({ kind: "warn", text: "This Gmail account has no signature set." });
        return;
      }
      setSigDraft(sig);
      setSigMsg({ kind: "ok", text: "Pulled from Gmail — not saved yet. Check the preview, then Save signature." });
    } catch {
      setSigMsg({ kind: "error", text: "Network error while pulling the Gmail signature." });
    } finally {
      setPulling(false);
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

  const identities = data?.identities ?? [];
  const connectedCount = identities.filter(
    (id) => healthByEmail.get(id.email.toLowerCase())?.ok,
  ).length;
  const syncOnCount = identities.filter((id) => {
    const k = id.email.toLowerCase();
    return !!syncAccounts[k] && !syncErrors[k];
  }).length;
  const syncBrokenCount = identities.filter((id) => !!syncErrors[id.email.toLowerCase()]).length;
  const blockedCount = identities.filter((id) => blockByEmail.has(id.email.toLowerCase())).length;

  const scrollToAdd = () => {
    addCardRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    addNameRef.current?.focus({ preventScroll: true });
  };

  const messages = (error || okMsg || warnMsg) && (
    <div className="flex flex-col gap-2">
      {error && (
        <p role="alert" className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3.5 py-2.5 text-xs leading-relaxed text-rose-200">
          {error}
        </p>
      )}
      {okMsg && !error && (
        <p className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3.5 py-2.5 text-xs leading-relaxed text-emerald-200">
          {okMsg}
        </p>
      )}
      {warnMsg && !error && (
        <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3.5 py-2.5 text-xs leading-relaxed text-amber-200">
          {warnMsg}
        </p>
      )}
    </div>
  );

  const replyDialog = replyFor && (
    <ReplySyncModal
      email={replyFor}
      clientConfigured={
        data?.replySync?.accountClients?.[replyFor.toLowerCase()] ??
        clientConfigured
      }
      syncOn={!!syncAccounts[replyFor.toLowerCase()]}
      onClose={() => setReplyFor(null)}
      onChanged={(snap) => {
        setData((prev) => ({ ...(prev as SendersState), ...snap }));
        onChanged?.();
      }}
    />
  );

  // ── Integrations page ────────────────────────────────────────────────────
  if (focusSection === "github") {
    return (
      <>
        <PageBody>
          <PageHeader
            title="Integrations"
            description="Services that power scanning and tracking"
            icon={<PlugIcon className="h-5 w-5" />}
          />

          {messages}

          <div className="grid items-start gap-6 lg:grid-cols-2">
            {/* GitHub token */}
            <Card
              title={
                <span className="flex items-center gap-2">
                  <GithubIcon className="h-4 w-4 text-slate-400" />
                  GitHub access token
                </span>
              }
              description="Optional but recommended: raises scanning from 60 to 5,000 requests/hour. Use your own token — it stays on this computer."
              actions={
                <span className={"badge " + (githubTokenSet ? "badge-success" : "badge-neutral")}>
                  {githubTokenSet ? "Set" : "Not set"}
                </span>
              }
            >
              <label htmlFor="github-token" className="field-label">
                {githubTokenSet ? "Replace token" : "Token"}
              </label>
              <div className="flex flex-col gap-2 sm:flex-row">
                <input
                  id="github-token"
                  ref={githubInputRef}
                  type="text"
                  value={githubToken}
                  onChange={(e) => setGithubToken(e.target.value)}
                  placeholder={githubTokenSet ? "Token set — paste to replace" : "ghp_… or github_pat_…"}
                  autoComplete="off"
                  className="input min-w-0 font-mono placeholder:font-sans sm:flex-1"
                />
                <div className="flex shrink-0 gap-2">
                  <button
                    type="button"
                    onClick={() => saveGithubToken(githubToken.trim())}
                    disabled={busy || githubToken.trim().length < 10}
                    className="btn btn-primary flex-1 sm:flex-none"
                  >
                    Save
                  </button>
                  {githubTokenSet && (
                    <button
                      type="button"
                      onClick={() => saveGithubToken("")}
                      disabled={busy}
                      className="btn btn-danger flex-1 sm:flex-none"
                    >
                      Clear
                    </button>
                  )}
                </div>
              </div>
              <p className="field-hint">We check the token against GitHub before saving it.</p>
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
            </Card>

            {/* Open tracking */}
            <Card
              title={
                <span className="flex items-center gap-2">
                  <EyeIcon className="h-4 w-4 text-slate-400" />
                  Open tracking
                </span>
              }
              description="See when recipients open your emails. Needs a small free tracking service (a Cloudflare Worker) — paste its URL. Opens are a rough signal, not exact; replies stay the strongest one."
              actions={
                <span
                  className={
                    "badge " +
                    (trackingUrlSet && trackingEnabled
                      ? "badge-success"
                      : trackingUrlSet
                        ? "badge-warning"
                        : "badge-neutral")
                  }
                >
                  {trackingUrlSet ? (trackingEnabled ? "On" : "Paused") : "Not set"}
                </span>
              }
            >
              {trackingUrlSet && (
                <div className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-white/5 bg-white/[0.02] px-3.5 py-3">
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-slate-400">Tracking service</p>
                    <p title={trackingCurrentUrl} className="mt-0.5 truncate font-mono text-xs text-slate-200">
                      {trackingCurrentUrl}
                    </p>
                  </div>
                  <label className="flex shrink-0 cursor-pointer items-center gap-2 text-xs font-medium text-slate-300">
                    <input
                      type="checkbox"
                      checked={trackingEnabled}
                      onChange={(e) =>
                        putTracking(
                          { trackingEnabled: e.target.checked },
                          e.target.checked ? "Open tracking enabled." : "Open tracking paused.",
                        )
                      }
                      className="peer sr-only"
                    />
                    <span
                      aria-hidden
                      className="relative h-5 w-9 rounded-full bg-slate-700 transition after:absolute after:left-0.5 after:top-0.5 after:h-4 after:w-4 after:rounded-full after:bg-white after:transition peer-checked:bg-cyan-500 peer-checked:after:translate-x-4 peer-focus-visible:ring-2 peer-focus-visible:ring-cyan-400/50"
                    />
                    Enabled
                  </label>
                </div>
              )}
              <label htmlFor="tracking-url" className="field-label">
                {trackingUrlSet ? "Replace URL" : "Worker URL"}
              </label>
              <div className="flex flex-col gap-2 sm:flex-row">
                <input
                  id="tracking-url"
                  type="text"
                  value={trackingUrl}
                  onChange={(e) => setTrackingUrl(e.target.value)}
                  placeholder={trackingUrlSet ? "Replace URL…" : "https://open-tracking.you.workers.dev"}
                  autoComplete="off"
                  className="input min-w-0 font-mono placeholder:font-sans sm:flex-1"
                />
                <div className="flex shrink-0 gap-2">
                  <button
                    type="button"
                    onClick={() => putTracking({ trackingUrl: trackingUrl.trim() }, "Tracking service connected.")}
                    disabled={busy || !/^https?:\/\//i.test(trackingUrl.trim())}
                    className="btn btn-primary flex-1 sm:flex-none"
                  >
                    Save
                  </button>
                  {trackingUrlSet && (
                    <button
                      type="button"
                      onClick={() => putTracking({ trackingUrl: "" }, "Tracking disconnected.")}
                      disabled={busy}
                      className="btn btn-danger flex-1 sm:flex-none"
                    >
                      Clear
                    </button>
                  )}
                </div>
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
                  <li className="mt-1 rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2 text-xs text-slate-400">
                    Tracking switches emails to HTML with a hidden 1×1 pixel. Opens are approximate (Apple Mail and
                    image-blockers skew them) — replies remain the strongest signal.
                  </li>
                </ol>
              </Collapsible>
            </Card>
          </div>
        </PageBody>
        {replyDialog}
      </>
    );
  }

  // ── Accounts page ────────────────────────────────────────────────────────
  return (
    <>
      <PageBody>
        <PageHeader
          title="Accounts"
          description="Gmail accounts you send from, and reply sync for each"
          icon={<MailIcon className="h-5 w-5" />}
          actions={
            <>
              {identities.length > 0 && (
                <button
                  type="button"
                  onClick={() => recheck()}
                  disabled={busy || checking !== null}
                  title="Check every account right now: open a real SMTP connection and sign in, and verify its reply-sync token with Google"
                  className="btn btn-secondary"
                >
                  {checking === "*" ? (
                    <SpinnerIcon className="h-4 w-4 animate-spin" />
                  ) : (
                    <RefreshIcon className="h-4 w-4" />
                  )}
                  {checking === "*" ? "Checking…" : "Recheck all"}
                </button>
              )}
              <button type="button" onClick={scrollToAdd} className="btn btn-primary">
                <PlusIcon className="h-4 w-4" />
                Add account
              </button>
            </>
          }
        />

        {identities.length > 0 && (
          <StatGrid cols={4}>
            <StatCard
              label="Accounts"
              value={identities.length}
              hint="Stored on this computer"
              icon={<MailIcon className="h-4 w-4" />}
            />
            <StatCard
              label="Connected"
              value={connectedCount}
              tone={connectedCount > 0 ? "success" : "default"}
              hint="SMTP login verified"
              icon={<PlugIcon className="h-4 w-4" />}
            />
            <StatCard
              label="Reply sync on"
              value={syncOnCount}
              tone={syncBrokenCount > 0 ? "warning" : syncOnCount > 0 ? "info" : "default"}
              hint={syncBrokenCount > 0 ? `${syncBrokenCount} broken` : "Replies read automatically"}
              icon={<RefreshIcon className="h-4 w-4" />}
            />
            <StatCard
              label="Paused today"
              value={blockedCount}
              tone={blockedCount > 0 ? "warning" : "default"}
              hint="Gmail policy blocks"
              icon={<PauseIcon className="h-4 w-4" />}
            />
          </StatGrid>
        )}

        {messages}

        {/* Current accounts */}
        <Card
          flush
          title="Connections"
          description="Reconnect to test or change an account's SMTP settings. Reply sync reads incoming replies."
        >
          {identities.length === 0 ? (
            <EmptyState
              icon={<MailIcon className="h-5 w-5" />}
              title="No accounts yet"
              description="Add your first Gmail below."
            />
          ) : (
            <ul className="divide-y divide-white/5">
              {identities.map((id) => {
                const key = id.email.toLowerCase();
                const syncOn = !!syncAccounts[key];
                // Token on file but the last scan couldn't read the inbox —
                // the state that used to render as a healthy green pill.
                const syncErr = syncErrors[key];
                const block = blockByEmail.get(key);
                const hp = healthByEmail.get(key);
                const smtp = smtpByEmail[key];
                const renewing = renewFor === id.email;
                const sigOpen = sigFor === id.email;
                const sigSaved = sigByEmail[key];
                const hasSig = !!sigSaved?.signature.trim();
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
                  <li key={id.email} className="px-5 py-4">
                    <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                      <div className="flex min-w-0 items-center gap-3">
                        <AccountAvatar name={id.name} email={id.email} />
                        <div className="min-w-0">
                          {renameFor === id.email ? (
                            <form
                              className="flex flex-wrap items-center gap-1.5"
                              onSubmit={(e) => {
                                e.preventDefault();
                                void saveRename(id.email, id.name);
                              }}
                            >
                              <input
                                autoFocus
                                value={renameValue}
                                onChange={(e) => setRenameValue(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === "Escape") {
                                    e.stopPropagation();
                                    setRenameFor(null);
                                  }
                                }}
                                maxLength={100}
                                disabled={busy}
                                aria-label={`Display name for ${id.email}`}
                                className="input h-8 w-44 min-w-0"
                              />
                              <button
                                type="submit"
                                disabled={busy || !renameValue.trim()}
                                className="btn btn-sm btn-primary"
                              >
                                Save
                              </button>
                              <button
                                type="button"
                                onClick={() => setRenameFor(null)}
                                className="btn btn-sm btn-ghost"
                              >
                                Cancel
                              </button>
                            </form>
                          ) : (
                            <div className="group flex min-w-0 items-center gap-1">
                              <div className="truncate text-sm font-medium text-slate-100">{id.name}</div>
                              <button
                                type="button"
                                onClick={() => openRename(id.email, id.name)}
                                disabled={busy}
                                title="Edit display name"
                                aria-label={`Edit display name for ${id.email}`}
                                className="btn btn-sm btn-ghost btn-icon h-6 w-6 shrink-0 opacity-60 group-hover:opacity-100"
                              >
                                <PencilIcon className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          )}
                          <div title={id.email} className="mt-0.5 truncate font-mono text-xs text-slate-400">
                            {id.email}
                          </div>
                          {/* Wraps: badges refuse to shrink, so a narrow row
                              with several at once stays inside its column. */}
                          <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-1.5">
                            <HealthBadge health={hp} checking={checking === id.email} />
                            {syncErr ? (
                              <span
                                title={
                                  `Replies to this inbox are NOT being read: ${syncErr.error}` +
                                  (syncErr.needsReauth ? " Reconnect this account to fix it." : "")
                                }
                                className="badge badge-warning shrink-0"
                              >
                                Reply sync broken
                              </span>
                            ) : (
                              syncOn && <span className="badge badge-info shrink-0">Reply sync on</span>
                            )}
                            {hasSig && (
                              <span
                                title={
                                  sigSaved?.scope === "openers"
                                    ? "A signature is added to Openers only"
                                    : "A signature is added to every email from this account"
                                }
                                className="badge badge-info shrink-0"
                              >
                                Signature{sigSaved?.scope === "openers" ? " · Openers" : ""}
                              </span>
                            )}
                            {block && (
                              // No time shown: this page polls slowly, so a
                              // live-looking clock would read stale. The title
                              // carries the detail; Resume lives in the queue.
                              <span
                                title={`Gmail bounced this account with a policy block${
                                  block.detail ? `: ${block.detail}` : ""
                                }. Outreach skips it until the next local midnight, then resumes on its own. Open the Queue to resume it early.`}
                                className="badge badge-warning shrink-0"
                              >
                                Paused — Gmail block
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                      <div className="flex shrink-0 flex-wrap items-center gap-1.5 md:justify-end">
                        <button
                          type="button"
                          onClick={() => (renewing ? setRenewFor(null) : openRenew(id.email))}
                          disabled={busy}
                          title="Re-test this account's SMTP connection, or renew its host, port, username and app password"
                          className={
                            "btn btn-sm btn-secondary " +
                            (renewing
                              ? "border-cyan-400/50 bg-cyan-400/10 text-cyan-200"
                              : hp && !hp.ok
                                ? "border-amber-500/40 bg-amber-500/10 text-amber-200"
                                : "")
                          }
                        >
                          <RefreshIcon className="h-3.5 w-3.5" />
                          Reconnect
                        </button>
                        <button
                          type="button"
                          onClick={() => (sigOpen ? setSigFor(null) : openSignature(id.email))}
                          disabled={busy}
                          title={hasSig ? "Edit this account's signature" : "Add a signature to emails from this account"}
                          className={
                            "btn btn-sm btn-secondary " +
                            (sigOpen ? "border-cyan-400/50 bg-cyan-400/10 text-cyan-200" : "")
                          }
                        >
                          <SignatureIcon className="h-3.5 w-3.5" />
                          {hasSig ? "Signature" : "Add signature"}
                        </button>
                        <button
                          type="button"
                          onClick={() => setReplyFor(id.email)}
                          className={
                            "btn btn-sm btn-secondary " +
                            (syncErr ? "border-amber-500/40 text-amber-200" : "")
                          }
                          title={
                            syncErr
                              ? `Replies to this inbox are NOT being read: ${syncErr.error}` +
                                (syncErr.needsReauth
                                  ? " Reconnect this account to fix it."
                                  : "")
                              : "Set up reading of incoming replies for this account"
                          }
                        >
                          <span
                            className={
                              "h-1.5 w-1.5 rounded-full " +
                              (syncErr
                                ? "bg-amber-400"
                                : syncOn
                                  ? "bg-emerald-400"
                                  : "bg-slate-500")
                            }
                          />
                          {syncErr ? "Reply sync broken" : "Reply sync"}
                        </button>
                        {pendingRemove === id.email ? (
                          <>
                            <button
                              type="button"
                              onClick={() => removeAccount(id.email)}
                              disabled={busy}
                              className="btn btn-sm bg-rose-500 font-semibold text-white hover:bg-rose-400"
                            >
                              Delete + history
                            </button>
                            <button
                              type="button"
                              onClick={() => setPendingRemove(null)}
                              className="btn btn-sm btn-ghost"
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
                            className="btn btn-sm btn-danger"
                          >
                            Remove
                          </button>
                        )}
                      </div>
                    </div>
                    {pendingRemove === id.email && (
                      <p className="mt-3 rounded-lg border border-rose-500/20 bg-rose-500/5 px-3 py-2 text-xs leading-relaxed text-rose-300/90">
                        Removes the account and deletes its send history (hidden from
                        History &amp; Insights) plus any pending queue items from it.
                      </p>
                    )}

                    {renewing && (
                      <div className="mt-4 space-y-4 rounded-xl border border-white/10 bg-slate-950/40 p-4">
                        <p className="text-xs leading-relaxed text-slate-400">
                          {hp
                            ? hp.ok
                              ? `Connected — SMTP login ok on ${hp.target}, checked at ${checkTime(hp.checkedAt)}.`
                              : `Last check at ${checkTime(hp.checkedAt)} failed${hp.target ? ` on ${hp.target}` : ""}: ${hp.error}`
                            : "Not checked since the app started. Test the connection, or change the settings below and save."}
                        </p>

                        {hp && !hp.ok && !hp.unconfigured && isTimeout(hp.error) && (
                          <p className="text-xs leading-relaxed text-slate-500">
                            A timeout means the server never answered, so this says
                            nothing about your app password. Try the other port below.
                            If 465 and 587 both time out, the block is outside the app —
                            usually a VPN or proxy tunnel, a firewall, or antivirus mail
                            scanning sitting on the connection. Disconnect the VPN and
                            test again.
                          </p>
                        )}

                        {sug && (
                          <div className="flex flex-col gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3.5 py-2.5 sm:flex-row sm:items-center sm:justify-between">
                            <span className="text-xs leading-relaxed text-emerald-200">
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
                              className="btn btn-sm btn-secondary shrink-0 border-emerald-500/40 text-emerald-200"
                            >
                              Use port {sug.port}
                            </button>
                          </div>
                        )}

                        <div className="grid gap-3 sm:grid-cols-2">
                          <div className="sm:col-span-2">
                            <label className="field-label" htmlFor={`renew-host-${key}`}>SMTP host</label>
                            <input
                              id={`renew-host-${key}`}
                              type="text"
                              value={renewHost}
                              onChange={(e) => setRenewHost(e.target.value)}
                              placeholder="SMTP host"
                              className="input"
                            />
                          </div>
                          <div>
                            <label className="field-label" htmlFor={`renew-port-${key}`}>Port</label>
                            <input
                              id={`renew-port-${key}`}
                              type="text"
                              value={renewPort}
                              onChange={(e) => setRenewPort(e.target.value)}
                              placeholder="Port"
                              className="input tabular-nums"
                            />
                          </div>
                          <div>
                            <label className="field-label" htmlFor={`renew-user-${key}`}>SMTP username</label>
                            <input
                              id={`renew-user-${key}`}
                              type="text"
                              value={renewUser}
                              onChange={(e) => setRenewUser(e.target.value)}
                              placeholder="SMTP username"
                              className="input"
                            />
                          </div>
                          <div className="sm:col-span-2">
                            <label className="field-label" htmlFor={`renew-pass-${key}`}>App password</label>
                            <input
                              id={`renew-pass-${key}`}
                              type="text"
                              value={renewPass}
                              onChange={(e) => setRenewPass(e.target.value)}
                              placeholder={
                                needsPass
                                  ? `App password for ${renewHost.trim()}`
                                  : "New app password (leave blank to keep current)"
                              }
                              autoComplete="off"
                              className="input font-mono placeholder:font-sans"
                            />
                            {needsPass && (
                              // Mirrors the server rule: the stored password is only
                              // ever replayed to the account's own server, so moving
                              // it elsewhere has to be typed out.
                              <p className="field-hint text-amber-300/90">
                                {smtp?.hasPass
                                  ? `Enter the app password for ${renewHost.trim()} — the one on file belongs to ${smtp.host} and is not sent to a different server.`
                                  : "Enter the account's app password (16 characters for Gmail)."}
                              </p>
                            )}
                          </div>
                        </div>

                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-xs font-medium text-slate-400">Port preset</span>
                          <div className="seg">
                            {[
                              { port: "465", label: "465 · SSL" },
                              { port: "587", label: "587 · STARTTLS" },
                            ].map((p) => (
                              <button
                                key={p.port}
                                type="button"
                                onClick={() => setRenewPort(p.port)}
                                className={"seg-item " + (renewPort.trim() === p.port ? "seg-item-active" : "")}
                              >
                                {p.label}
                              </button>
                            ))}
                          </div>
                        </div>

                        <div className="flex flex-col gap-3 border-t border-white/5 pt-4 sm:flex-row sm:items-center sm:justify-between">
                          <p className="text-xs leading-relaxed text-slate-500 sm:max-w-md">
                            Saving re-verifies the login and drops the cached connection,
                            so the next send uses these settings. History, queue and reply
                            sync for this account are untouched.
                          </p>
                          <div className="flex shrink-0 flex-wrap items-center gap-2">
                            <button
                              type="button"
                              onClick={() => {
                                setRenewFor(null);
                                setSuggestion(null);
                              }}
                              className="btn btn-ghost"
                            >
                              Cancel
                            </button>
                            <button
                              type="button"
                              onClick={() => recheck(id.email)}
                              disabled={busy || checking !== null}
                              title="Try the stored settings now, and the other standard port if this one can't be reached"
                              className="btn btn-secondary"
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
                              className="btn btn-primary"
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
                          </div>
                        </div>
                      </div>
                    )}

                    {sigOpen && (
                      <div className="mt-4 space-y-4 rounded-xl border border-white/10 bg-slate-950/40 p-4">
                        <div>
                          <div className="flex flex-wrap items-end justify-between gap-2">
                            <label className="field-label" htmlFor={`sig-${key}`}>
                              Signature
                            </label>
                            <button
                              type="button"
                              onClick={() => pullSignature(id.email)}
                              disabled={busy || pulling || !syncOn}
                              title={
                                syncOn
                                  ? "Load the signature set in this account's Gmail settings into the box below"
                                  : "Connect Reply sync for this account to pull its Gmail signature"
                              }
                              className="btn btn-sm btn-secondary"
                            >
                              {pulling ? (
                                <SpinnerIcon className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <MailIcon className="h-3.5 w-3.5" />
                              )}
                              Pull from Gmail
                            </button>
                          </div>
                          <textarea
                            id={`sig-${key}`}
                            autoFocus
                            value={sigDraft}
                            onChange={(e) => setSigDraft(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Escape") {
                                e.stopPropagation();
                                setSigFor(null);
                              }
                            }}
                            rows={5}
                            disabled={busy}
                            spellCheck={false}
                            placeholder={"Jane Doe\nFounder, Acme · https://acme.com"}
                            className="input mt-1.5 min-h-[7rem] font-mono text-xs leading-relaxed placeholder:font-sans"
                          />
                          <p className="field-hint flex flex-wrap justify-between gap-x-3">
                            <span>
                              Plain text, or paste HTML. {"{{sender}}"} and {"{{sender_email}}"} work here too.
                              {!syncOn && " Pull from Gmail needs Reply sync connected for this account."}
                            </span>
                            <span className={"tabular-nums " + (sigTooLong ? "text-amber-300" : "")}>
                              {sigDraft.trim().length.toLocaleString()} / {SIG_MAX.toLocaleString()}
                            </span>
                          </p>
                        </div>

                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-xs font-medium text-slate-400">Add it to</span>
                          <Segmented<SignatureScope>
                            value={sigScope}
                            onChange={setSigScope}
                            options={[
                              { value: "all", label: "Every email" },
                              { value: "openers", label: "Openers only" },
                            ]}
                          />
                          <span className="text-xs text-slate-500">
                            {sigScope === "openers"
                              ? "Pitches, Bumps and replies in the thread go without it."
                              : "Openers, Pitches, Bumps and replies."}
                          </span>
                        </div>

                        {sigDraft.trim() && (
                          <div>
                            <div className="field-label">Preview</div>
                            <SignaturePreview signature={sigDraft} sender={id} />
                          </div>
                        )}

                        {(sigMsg || sigTooLong) && (
                          <p
                            role={sigMsg?.kind === "error" ? "alert" : "status"}
                            className={
                              "rounded-lg border px-3.5 py-2.5 text-xs leading-relaxed " +
                              (sigMsg?.kind === "error"
                                ? "border-rose-500/30 bg-rose-500/10 text-rose-200"
                                : sigMsg?.kind === "ok"
                                  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
                                  : "border-amber-500/30 bg-amber-500/10 text-amber-200")
                            }
                          >
                            {sigMsg?.text ??
                              `This signature is ${sigDraft.trim().length.toLocaleString()} characters; the limit is ${SIG_MAX.toLocaleString()} (Gmail's own). Embedded images make pulled signatures long. Host the image instead, or shorten it.`}
                          </p>
                        )}

                        <div className="flex flex-col gap-3 border-t border-white/5 pt-4 sm:flex-row sm:items-center sm:justify-between">
                          <div>
                            {hasSig && (
                              <button
                                type="button"
                                onClick={() => saveSignature(id.email, "", sigSaved?.scope)}
                                disabled={busy}
                                className="btn btn-sm btn-danger"
                              >
                                Remove signature
                              </button>
                            )}
                          </div>
                          <div className="flex shrink-0 flex-wrap items-center gap-2">
                            <button type="button" onClick={() => setSigFor(null)} className="btn btn-ghost">
                              Cancel
                            </button>
                            <button
                              type="button"
                              onClick={() => saveSignature(id.email, sigDraft, sigScope)}
                              disabled={busy || pulling || sigTooLong || (!sigDraft.trim() && !hasSig)}
                              className="btn btn-primary"
                            >
                              {busy ? (
                                <>
                                  <SpinnerIcon className="h-3.5 w-3.5 animate-spin" />
                                  Saving…
                                </>
                              ) : (
                                "Save signature"
                              )}
                            </button>
                          </div>
                        </div>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        {/* Add account */}
        <div ref={addCardRef} className="scroll-mt-6">
          <Card
            title="Add a Gmail account"
            description="Sign in with a Google App Password. Everything is stored on this computer."
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="add-name" className="field-label">Display name</label>
                <input
                  id="add-name"
                  ref={addNameRef}
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Display name (e.g. Wael)"
                  className="input"
                />
              </div>
              <div>
                <label htmlFor="add-email" className="field-label">Gmail address</label>
                <input
                  id="add-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@gmail.com"
                  autoComplete="off"
                  className="input"
                />
              </div>
              <div className="sm:col-span-2">
                <label htmlFor="add-pass" className="field-label">App password</label>
                <input
                  id="add-pass"
                  type="text"
                  value={appPassword}
                  onChange={(e) => setAppPassword(e.target.value)}
                  placeholder="16-character App Password"
                  autoComplete="off"
                  className="input font-mono placeholder:font-sans"
                />
                <p className="field-hint">Not your Gmail password — see the guide below to create one.</p>
              </div>
            </div>

            <button
              type="button"
              onClick={() => setShowAdvanced((v) => !v)}
              aria-expanded={showAdvanced}
              className="btn btn-sm btn-ghost mt-3 -ml-2"
            >
              <ChevronIcon className={"h-3.5 w-3.5 transition " + (showAdvanced ? "rotate-90" : "")} />
              Advanced (non-Gmail SMTP)
            </button>
            {showAdvanced && (
              <div className="mt-2 grid gap-4 rounded-xl border border-white/5 bg-white/[0.02] p-4 sm:grid-cols-2">
                <div className="sm:col-span-2">
                  <label htmlFor="add-host" className="field-label">SMTP host</label>
                  <input
                    id="add-host"
                    type="text"
                    value={smtpHost}
                    onChange={(e) => setSmtpHost(e.target.value)}
                    placeholder="SMTP host"
                    className="input"
                  />
                </div>
                <div>
                  <label htmlFor="add-port" className="field-label">Port</label>
                  <input
                    id="add-port"
                    type="text"
                    value={smtpPort}
                    onChange={(e) => setSmtpPort(e.target.value)}
                    placeholder="Port (465)"
                    className="input tabular-nums"
                  />
                </div>
                <div>
                  <label htmlFor="add-user" className="field-label">SMTP username</label>
                  <input
                    id="add-user"
                    type="text"
                    value={smtpUser}
                    onChange={(e) => setSmtpUser(e.target.value)}
                    placeholder="SMTP username (defaults to email)"
                    className="input"
                  />
                </div>
              </div>
            )}

            <div className="mt-4 flex justify-end border-t border-white/5 pt-4">
              <button
                type="button"
                onClick={addAccount}
                disabled={!canAdd}
                className="btn btn-primary w-full sm:w-auto"
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
            </div>

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
          </Card>
        </div>
      </PageBody>
      {replyDialog}
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
  const base = "badge shrink-0 ";
  if (checking) {
    return (
      <span className={base + "badge-info"}>
        Checking…
      </span>
    );
  }
  if (!health) {
    return (
      <span
        title="Not checked since the app started. Use Recheck all, or Reconnect on this account."
        className={base + "badge-neutral"}
      >
        Not checked
      </span>
    );
  }
  if (health.ok) {
    return (
      <span
        title={`SMTP login ok on ${health.target}, checked at ${checkTime(health.checkedAt)}.`}
        className={base + "badge-success"}
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
      className={base + "badge-danger"}
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
    <div className="mt-4 rounded-xl border border-white/10 bg-white/[0.02]">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 rounded-xl px-4 py-3 text-left transition hover:bg-white/[0.03]"
      >
        <span className="flex min-w-0 items-center gap-2 text-sm font-medium text-slate-200">
          <BookIcon className="h-4 w-4 shrink-0 text-cyan-300" />
          {title}
        </span>
        <ChevronIcon className={"h-4 w-4 shrink-0 text-slate-400 transition " + (open ? "rotate-90" : "")} />
      </button>
      {open && (
        <div className="border-t border-white/5 px-4 py-4 text-[13px] leading-relaxed text-slate-300">
          {children}
        </div>
      )}
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-cyan-500/15 text-[11px] font-semibold tabular-nums text-cyan-200 ring-1 ring-inset ring-cyan-400/25">
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

/** The signature as recipients will see it, placeholders filled with this
 *  Sender, rendered by the same code the send path uses. Sandboxed: pasted
 *  HTML can't run scripts in the app, and its styles stay inside the frame.
 *  Same-origin (still without scripts) only so the frame can be sized to its
 *  content. Always white, like an email client. */
function SignaturePreview({ signature, sender }: { signature: string; sender: MailIdentity }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(48);
  const html = textToEmailHtml("", undefined, renderSignature(signature, sender).html);
  const fit = () => {
    const doc = ref.current?.contentDocument;
    if (doc?.body) setHeight(Math.min(Math.max(doc.body.scrollHeight, 24), 400));
  };
  return (
    // The padding sits on the frame element, outside the rendered email.
    <div className="mt-1.5 rounded-lg border border-white/10 bg-white px-3.5 py-3">
      <iframe
        ref={ref}
        title="Signature preview"
        sandbox="allow-same-origin"
        srcDoc={html}
        onLoad={fit}
        style={{ height }}
        className="block w-full border-0 bg-white"
      />
    </div>
  );
}

type IconProps = { className?: string };

function SignatureIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M3 17c3-1 4-9 6-9s-1 9 2 9 3-5 5-5 1 4 3 4" />
      <path d="M3 21h18" />
    </svg>
  );
}

function MailIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="m22 7-10 6L2 7" />
    </svg>
  );
}

function GithubIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4" />
      <path d="M9 18c-4.51 2-5-2-7-2" />
    </svg>
  );
}

function EyeIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function PauseIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <rect x="6" y="4" width="4" height="16" rx="1" />
      <rect x="14" y="4" width="4" height="16" rx="1" />
    </svg>
  );
}

function BookIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20" />
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

function PencilIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
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
