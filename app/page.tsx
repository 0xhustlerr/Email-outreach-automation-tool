"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import HistoryModal from "@/components/HistoryModal";
import GmailAvatar from "@/components/GmailAvatar";
import { CountryFlag } from "@/components/CountryFlag";
import { resolveLocation } from "@/lib/country";
import InsightsModal, {
  InsightsDashboard,
  computeInsights,
} from "@/components/InsightsModal";
import { primaryEmail } from "@/lib/sheet-active";
import KnockAppShell from "@/components/knock/KnockAppShell";
import ReplyNotificationsBell from "@/components/ReplyNotificationsBell";
import { useNewReplies } from "@/hooks/useNewReplies";
import { useReplyCustomTabs } from "@/hooks/useReplyCustomTabs";
import { useSheetHistory } from "@/hooks/useSheetHistory";
import { toast } from "sonner";
import { EMAIL_TEMPLATES } from "@/lib/email-templates";
import TemplatesModal from "@/components/TemplatesModal";
import ContactsModal from "@/components/ContactsModal";
import QueueModal from "@/components/QueueModal";
import ImportCsvModal from "@/components/ImportCsvModal";
import SendersModal from "@/components/SendersModal";
import {
  loadSelectedTemplateIdRaw,
  saveSelectedTemplateIdRaw,
  useTemplates,
} from "@/hooks/useTemplates";
import type {
  DiscoveryResult,
  MailIdentity,
  Repo,
  ScanEvent,
  ScanMatch,
} from "@/lib/types";

const DEFAULT_COMMITS_PER_REPO = Number(
  process.env.NEXT_PUBLIC_DEFAULT_COMMITS_PER_REPO ?? "5",
);

const ALL_REPOS = "__all__";

type Phase = "idle" | "loading-repos" | "scanning" | "done" | "error";

type LogEntry = {
  id: number;
  kind: "info" | "skip" | "match" | "error" | "done";
  text: string;
};

type ContactSource = {
  label: string;
  url: string | null;
  // ISO 8601, only populated for commit-sourced contacts (from /api/scan).
  // Discovery sources (profile, README, blog) leave this null.
  date: string | null;
};

type ContactKind = "email" | "telegram" | "phone";

type Contact = {
  kind: ContactKind;
  value: string;
  names: string[];
  sources: ContactSource[];
};

// Mirrors the server-side parseGitHubUsername: bare login, github.com/<login>,
// or a full profile URL. Used to avoid pinging /api/repos on partial input.
function isMaybeUsernameInput(input: string): boolean {
  const trimmed = input.trim();
  if (!trimmed) return false;
  const withoutProto = trimmed.replace(/^https?:\/\//i, "");
  const withoutHost = withoutProto.replace(/^(www\.)?github\.com\/?/i, "");
  const firstSegment = withoutHost.split(/[/?#]/)[0];
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(firstSegment);
}

// Matches a Stack Overflow user profile URL - the shape we hand off to
// /api/resolve-so for GitHub-login extraction.
function isStackOverflowProfileUrl(input: string): boolean {
  return /^https?:\/\/(www\.)?stackoverflow\.com\/users\/\d+/i.test(
    input.trim(),
  );
}

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

// Pull the country out of GitHub's free-form `location` field.
// Most profiles use "City, State, Country" or "City-State. Country." -
// we split on commas then periods and take the last non-empty segment,
// stripping trailing punctuation. Falls back to the full string when
// there's no separator (e.g. bare "Tokyo" or "Planet Earth") so the
// user can still see what GitHub had and edit the cell manually.
function extractCountry(location: string | null | undefined): string {
  if (!location) return "";
  const commaParts = location
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const tail =
    commaParts.length > 0 ? commaParts[commaParts.length - 1] : location.trim();
  const periodParts = tail
    .split(".")
    .map((s) => s.trim())
    .filter(Boolean);
  const last =
    periodParts.length > 0 ? periodParts[periodParts.length - 1] : tail;
  return last.replace(/[.,;:\s]+$/, "").trim();
}

// Compact label for a fixed UTC-offset timezone ("UTC-05:00" -> "UTC−5").
// IANA zone names are returned unchanged.
function prettyOffset(tz: string): string {
  const m = /UTC([+-])(\d{2}):(\d{2})/.exec(tz);
  if (!m) return tz;
  const sign = m[1] === "-" ? "−" : "+";
  const h = parseInt(m[2], 10);
  return `UTC${sign}${h}${m[3] !== "00" ? ":" + m[3] : ""}`;
}

// Short, human-legible date for the source pill. Returns null if we don't
// have one - callers use that to hide the chip entirely on non-commit sources.
function formatSourceDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  const sameYear = d.getUTCFullYear() === now.getUTCFullYear();
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: sameYear ? undefined : "numeric",
  });
}

export default function Page() {
  const [profileUrl, setProfileUrl] = useState("");
  const [user, setUser] = useState<string | null>(null);
  const [repos, setRepos] = useState<Repo[] | null>(null); // null = not loaded yet
  const [selectedRepo, setSelectedRepo] = useState<string>(ALL_REPOS);
  const [commitsPerRepo, setCommitsPerRepo] = useState<number>(
    Number.isFinite(DEFAULT_COMMITS_PER_REPO) && DEFAULT_COMMITS_PER_REPO > 0
      ? DEFAULT_COMMITS_PER_REPO
      : 5,
  );

  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState<{ index: number; total: number } | null>(
    null,
  );
  const [matches, setMatches] = useState<ScanMatch[]>([]);
  const [scannedCount, setScannedCount] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [discovery, setDiscovery] = useState<DiscoveryResult | null>(null);
  const [discoveryPhase, setDiscoveryPhase] = useState<
    "idle" | "loading" | "done" | "error"
  >("idle");
  const [senders, setSenders] = useState<MailIdentity[]>([]);
  const [smtpConfigured, setSmtpConfigured] = useState<boolean>(true);
  const [sheetsConfigured, setSheetsConfigured] = useState<boolean>(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [insightsOpen, setInsightsOpen] = useState(false);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [contactsOpen, setContactsOpen] = useState(false);
  const [queueOpen, setQueueOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [sendersOpen, setSendersOpen] = useState(false);
  // When the Setup menu's "GitHub token" item opens Accounts, jump straight to
  // that section instead of the top of the config hub.
  const [sendersFocus, setSendersFocus] = useState<"github" | null>(null);
  const [queuedCount, setQueuedCount] = useState(0);
  const { templates: pageTemplates } = useTemplates();
  const [directSaveOpen, setDirectSaveOpen] = useState(false);
  const [directSaveUrl, setDirectSaveUrl] = useState("");
  const [directSaveDone, setDirectSaveDone] = useState(false);
  const sheetHistory = useSheetHistory(sheetsConfigured);
  const replyCustomTabs = useReplyCustomTabs();
  const newReplies = useNewReplies(
    sheetHistory.rows,
    sheetHistory.replyNotifications,
    sheetHistory.messageIds,
    sheetHistory.receivedInboxes,
    replyCustomTabs.customTabs,
  );
  const [sendTarget, setSendTarget] = useState<Contact | null>(null);
  const [sendToEditable, setSendToEditable] = useState(false);
  const [sendPrefill, setSendPrefill] = useState<{
    name?: string;
    url?: string;
    fromEmail?: string;
    country?: string;
  } | null>(null);
  // Lowercased emails we've successfully sent to this session - drives the
  // "sent ✓" state on contact cards.
  const [sentEmails, setSentEmails] = useState<Set<string>>(() => new Set());
  const [queuedEmails, setQueuedEmails] = useState<Set<string>>(() => new Set());

  const scanAbortRef = useRef<AbortController | null>(null);
  const reposAbortRef = useRef<AbortController | null>(null);
  const discoverAbortRef = useRef<AbortController | null>(null);
  const logIdRef = useRef(0);
  const logScrollRef = useRef<HTMLDivElement>(null);

  const appendLog = (kind: LogEntry["kind"], text: string) => {
    setLog((prev) => {
      const next = [...prev, { id: ++logIdRef.current, kind, text }];
      // Cap at 500 entries so a long scan can't bloat the DOM.
      return next.length > 500 ? next.slice(next.length - 500) : next;
    });
  };

  const resetRunState = () => {
    setProgress(null);
    setMatches([]);
    setScannedCount(0);
    setError(null);
    setLog([]);
    logIdRef.current = 0;
    setDiscovery(null);
    setDiscoveryPhase("idle");
  };

  // Auto-load repos when the URL becomes a valid-looking GitHub profile.
  useEffect(() => {
    const trimmed = profileUrl.trim();
    if (!trimmed) {
      reposAbortRef.current?.abort();
      scanAbortRef.current?.abort();
      setRepos(null);
      setSelectedRepo("");
      setUser(null);
      setError(null);
      setPhase("idle");
      resetRunState();
      return;
    }
    const isGh = isMaybeUsernameInput(trimmed);
    const isSo = !isGh && isStackOverflowProfileUrl(trimmed);
    if (!isGh && !isSo) return;

    const handle = setTimeout(async () => {
      reposAbortRef.current?.abort();
      const controller = new AbortController();
      reposAbortRef.current = controller;

      resetRunState();
      setPhase("loading-repos");
      setRepos(null);
      setSelectedRepo("");
      setUser(null);

      // Stack Overflow path: resolve to a GitHub login first, then fall through
      // to the normal repos call below.
      let userParam = trimmed;
      if (isSo) {
        appendLog("info", "Resolving GitHub profile from Stack Overflow…");
        try {
          const r = await fetch(
            `/api/resolve-so?url=${encodeURIComponent(trimmed)}`,
            { signal: controller.signal },
          );
          const j = (await r.json()) as { login?: string; error?: string };
          if (!r.ok || !j.login) {
            throw new Error(
              j.error ?? "Could not find a GitHub link on that Stack Overflow profile.",
            );
          }
          userParam = j.login;
          appendLog("match", `Resolved: github.com/${j.login}`);
        } catch (err) {
          if ((err as { name?: string }).name === "AbortError") return;
          setError(
            err instanceof Error ? err.message : "Stack Overflow lookup failed.",
          );
          setPhase("error");
          return;
        }
      }

      try {
        const res = await fetch(
          `/api/repos?user=${encodeURIComponent(userParam)}`,
          { signal: controller.signal },
        );
        const data = (await res.json()) as {
          user?: string;
          repos?: Repo[];
          defaultRepo?: string | null;
          error?: string;
        };
        if (!res.ok || !data.repos) {
          throw new Error(data.error ?? "Failed to load repositories.");
        }
        setUser(data.user ?? null);
        setRepos(data.repos);
        setSelectedRepo(ALL_REPOS);
        setPhase("idle");
      } catch (err) {
        if ((err as { name?: string }).name === "AbortError") return;
        setRepos(null);
        setError(err instanceof Error ? err.message : "Failed to load repos.");
        setPhase("error");
      }
    }, 400);

    return () => clearTimeout(handle);
  }, [profileUrl]);

  // Poll the open-tracking service so History/Insights reflect opens. No-ops
  // when tracking isn't configured; the Worker retains opens so a poll always
  // catches up whatever happened while the app was closed.
  useEffect(() => {
    const tick = () => {
      void fetch("/api/sync-opens").catch(() => {});
    };
    tick();
    const id = window.setInterval(tick, 90_000);
    return () => window.clearInterval(id);
  }, []);

  // Load the configured + added sender identities so the Send modal's From:
  // dropdown is populated. Exposed as a callback so the Accounts modal can
  // refresh it after an account is added or removed.
  const refreshSenders = useCallback(async () => {
    try {
      const res = await fetch("/api/senders");
      if (!res.ok) return;
      const data = (await res.json()) as {
        smtpConfigured: boolean;
        sheetsConfigured?: boolean;
        identities: MailIdentity[];
      };
      setSenders(data.identities);
      setSmtpConfigured(data.smtpConfigured);
      setSheetsConfigured(!!data.sheetsConfigured);
    } catch {
      // ignore - modal still renders and shows a config warning
    }
  }, []);

  useEffect(() => {
    void refreshSenders();
  }, [refreshSenders]);

  // Discover emails from the user's profile fields, profile README, and blog
  // URL. Runs once per user and in parallel with the commit scan.
  useEffect(() => {
    if (!user) return;
    discoverAbortRef.current?.abort();
    const controller = new AbortController();
    discoverAbortRef.current = controller;

    setDiscoveryPhase("loading");
    setDiscovery(null);
    appendLog("info", `Discovering emails from profile/README/blog for ${user}…`);

    void (async () => {
      try {
        const res = await fetch(
          `/api/discover?user=${encodeURIComponent(user)}`,
          { signal: controller.signal },
        );
        const data = (await res.json()) as DiscoveryResult & { error?: string };
        if (!res.ok) throw new Error(data.error ?? `Discovery failed (${res.status}).`);
        setDiscovery(data);
        setDiscoveryPhase("done");
        const total = data.sources.reduce((n, s) => n + s.emails.length, 0);
        appendLog(
          total > 0 ? "match" : "info",
          `Discovery complete: ${total} email(s) across ${data.sources.length} source(s).`,
        );
      } catch (err) {
        if ((err as { name?: string }).name === "AbortError") return;
        const msg = err instanceof Error ? err.message : "Discovery failed.";
        appendLog("error", `Discovery: ${msg}`);
        setDiscoveryPhase("error");
      }
    })();

    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  // Auto-scan whenever we have a user + a mode selected. Mode is either a
  // single repo name or the ALL_REPOS sentinel - the server scans accordingly.
  useEffect(() => {
    if (!user || !selectedRepo) return;

    const controller = new AbortController();
    scanAbortRef.current?.abort();
    scanAbortRef.current = controller;

    const isAll = selectedRepo === ALL_REPOS;

    let cancelled = false;
    void (async () => {
      // Preserve discovery state - it's keyed off `user` and runs in parallel.
      const keepDiscovery = discovery;
      const keepDiscoveryPhase = discoveryPhase;
      resetRunState();
      if (keepDiscovery) setDiscovery(keepDiscovery);
      setDiscoveryPhase(keepDiscoveryPhase);

      setPhase("scanning");
      appendLog(
        "info",
        isAll
          ? `Scanning all repos for ${user} (${commitsPerRepo} commits per repo)…`
          : `Scanning ${user}/${selectedRepo} (${commitsPerRepo} commits)…`,
      );

      try {
        const res = await fetch("/api/scan", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            owner: user,
            repo: isAll ? undefined : selectedRepo,
            commitsPerRepo,
          }),
          signal: controller.signal,
        });

        if (!res.ok || !res.body) {
          const text = await res.text().catch(() => "");
          throw new Error(text || `Scan failed (${res.status}).`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (!cancelled) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (!line) continue;
            handleEvent(JSON.parse(line) as ScanEvent);
          }
        }
        if (!cancelled) setPhase("done");
      } catch (err) {
        if ((err as { name?: string }).name === "AbortError") return;
        const msg = err instanceof Error ? err.message : "Scan failed.";
        appendLog("error", msg);
        setError(msg);
        setPhase("error");
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, selectedRepo, commitsPerRepo]);

  const handleEvent = (event: ScanEvent) => {
    switch (event.type) {
      case "start":
        setProgress({ index: 0, total: event.totalCommits });
        appendLog(
          "info",
          `Plan: ${event.totalCommits} commit(s) across ${event.repoCount} repo(s).`,
        );
        break;
      case "repo-start":
        appendLog(
          "info",
          `→ ${event.repo} (${event.commitCount} commit${event.commitCount === 1 ? "" : "s"})`,
        );
        break;
      case "progress":
        setProgress({ index: event.index, total: event.total });
        appendLog(
          "info",
          `  [${event.index}/${event.total}] ${event.repo}@${shortSha(event.sha)}…`,
        );
        break;
      case "skipped":
        appendLog(
          "skip",
          `  skip ${event.repo}@${shortSha(event.sha)}: ${event.reason}.`,
        );
        break;
      case "match": {
        setMatches((prev) => [...prev, event.match]);
        const m = event.match;
        const parts: string[] = [];
        if (m.author) parts.push(`${m.author.name} <${m.author.email}>`);
        if (m.telegrams.length > 0)
          parts.push(`tg: ${m.telegrams.map((t) => `@${t}`).join(", ")}`);
        if (m.phones.length > 0) parts.push(`ph: ${m.phones.join(", ")}`);
        appendLog(
          "match",
          `  MATCH ${m.repo}@${shortSha(m.sha)} → ${parts.join("; ")}`,
        );
        break;
      }
      case "done":
        setScannedCount(event.scanned);
        appendLog(
          "done",
          `Done. Scanned ${event.scanned} commit(s) across ${event.repoCount} repo(s); ${event.matches} unique email(s).`,
        );
        break;
      case "error":
        appendLog("error", event.message);
        setError(event.message);
        break;
    }
  };

  // Auto-scroll the history log as new entries arrive.
  useEffect(() => {
    const el = logScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log]);

  const cancel = () => {
    scanAbortRef.current?.abort();
    setPhase("idle");
    setProgress(null);
    appendLog("info", "Scan cancelled by user.");
  };

  const progressLabel = useMemo(() => {
    if (!progress) return null;
    if (progress.index === 0) return `Preparing to scan ${progress.total} commits…`;
    return `Checking commit ${progress.index} of ${progress.total}…`;
  }, [progress]);

  // Merge profile-derived sources and commit matches into a single de-duped
  // list keyed by email. Both inputs change as data streams in, so this list
  // grows live in the UI without any explicit "refresh" step.
  const contacts = useMemo<Contact[]>(() => {
    const map = new Map<string, Contact>();

    const upsert = (
      kind: ContactKind,
      value: string,
      name: string | null,
      src: ContactSource,
    ) => {
      const normalized = kind === "phone" ? value : value.toLowerCase();
      const key = `${kind}:${normalized}`;
      const existing = map.get(key);
      if (existing) {
        if (
          name &&
          !existing.names.some((n) => n.toLowerCase() === name.toLowerCase())
        ) {
          existing.names.push(name);
        }
        if (
          !existing.sources.some(
            (s) => s.label === src.label && s.url === src.url,
          )
        ) {
          existing.sources.push(src);
        }
      } else {
        map.set(key, {
          kind,
          value: normalized,
          names: name ? [name] : [],
          sources: [src],
        });
      }
    };

    if (discovery) {
      for (const s of discovery.sources) {
        const src: ContactSource = { label: s.label, url: s.url, date: null };
        for (const e of s.emails) upsert("email", e, null, src);
        for (const t of s.telegrams ?? []) upsert("telegram", t, null, src);
        for (const p of s.phones ?? []) upsert("phone", p, null, src);
      }
    }
    for (const m of matches) {
      const src: ContactSource = {
        label: `Commit ${m.repo}@${shortSha(m.sha)}`,
        url: m.patchUrl,
        date: m.date,
      };
      if (m.author) {
        upsert("email", m.author.email, m.author.name, src);
      }
      for (const t of m.telegrams) upsert("telegram", t, null, src);
      for (const p of m.phones) upsert("phone", p, null, src);
    }

    // Stable order: emails first, then telegrams, then phones, then by value.
    const order: Record<ContactKind, number> = {
      email: 0,
      telegram: 1,
      phone: 2,
    };
    return [...map.values()].sort((a, b) =>
      order[a.kind] - order[b.kind] || a.value.localeCompare(b.value),
    );
  }, [discovery, matches]);

  const contactCounts = useMemo(() => {
    const counts: Record<ContactKind, number> = {
      email: 0,
      telegram: 0,
      phone: 0,
    };
    for (const c of contacts) counts[c.kind]++;
    return counts;
  }, [contacts]);

  // Location signals for the scanned profile: the author's commit UTC offset
  // (most recent commit with one) and every phone found — passed to sends so
  // the queue can schedule by the recipient's local time.
  const profileTzOffset = useMemo(() => {
    for (let i = matches.length - 1; i >= 0; i--) {
      const o = matches[i].tzOffsetMin;
      if (typeof o === "number") return o;
    }
    return null;
  }, [matches]);
  const profilePhones = useMemo(
    () => contacts.filter((c) => c.kind === "phone").map((c) => c.value),
    [contacts],
  );
  // Best-guess country + timezone for the scanned profile, combining all
  // signals: phone dial code / GitHub location, else the commit UTC offset
  // (which pins a working timezone and a rough country when the profile is
  // blank). Shown on each contact card so blank-location devs still get a flag.
  const profileLocation = useMemo(
    () =>
      resolveLocation({
        commitOffsetMin: profileTzOffset,
        phones: profilePhones,
        location: discovery?.location,
      }),
    [profileTzOffset, profilePhones, discovery?.location],
  );

  // Save the current profile's contact snapshot to the local database.
  // Called at send-success (with ONLY the emailed address) and by the ☆
  // direct-save button (no emails, direct flag). Phones and telegram handles
  // always go in full - they're the fallback channels this feature exists for.
  const saveContactSnapshot = (opts: {
    sentEmail?: string;
    attachedUrl?: string;
    direct?: boolean;
  }) => {
    if (!user) return;
    const phones = contacts.filter((c) => c.kind === "phone").map((c) => c.value);
    const telegrams = contacts
      .filter((c) => c.kind === "telegram")
      .map((c) => c.value);
    const name =
      contacts.find((c) => c.kind === "email" && c.names.length > 0)?.names[0] ??
      "";
    void fetch("/api/contacts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        key: user.toLowerCase(),
        login: user,
        profileUrl: `https://github.com/${user}`,
        name,
        country: extractCountry(discovery?.location),
        emails: opts.sentEmail ? [opts.sentEmail] : [],
        phones,
        telegrams,
        direct: opts.direct === true,
        attachedUrl: opts.attachedUrl,
      }),
    }).catch(() => {});
  };

  // Add found email addresses to the send queue, rendered from the currently
  // selected template with this profile's name and URL. The worker drips them
  // out on schedule; nothing sends immediately.
  const queueEmails = async (targets: { value: string; names: string[] }[]) => {
    const selectedId = loadSelectedTemplateIdRaw();
    const tpl =
      pageTemplates.find((t) => t.id === selectedId) ??
      pageTemplates[0] ??
      EMAIL_TEMPLATES[0];
    const cleanUrl = trimUrlAtQuery(profileUrl.trim());
    const country = extractCountry(discovery?.location);

    const items = targets
      .filter((t) => t.value.includes("@"))
      .map((t) => {
        const name = t.names[0]?.trim() || "";
        // Keep {{sender}} tokens so the server fills them from the sending account.
        const vars = {
          name: name || "there",
          url: cleanUrl,
          sender: "{{sender}}",
          sender_email: "{{sender_email}}",
        };
        return {
          toEmail: t.value,
          name,
          link: cleanUrl,
          username: user ?? "",
          country,
          subject: substitute(tpl.subject, vars),
          body: substitute(tpl.body, vars),
        };
      });
    if (items.length === 0) return;

    try {
      const res = await fetch("/api/queue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        added?: number;
        skipped?: { toEmail: string; reason: string }[];
      };
      if (res.ok && data.ok) {
        const added = data.added ?? 0;
        const skipped = data.skipped?.length ?? 0;
        // Mark queued on the cards for instant visible feedback.
        setQueuedEmails((prev) => {
          const next = new Set(prev);
          for (const it of items) next.add(it.toEmail.toLowerCase());
          return next;
        });
        toast.success(
          `Queued ${added} email${added === 1 ? "" : "s"}` +
            (skipped > 0 ? ` · ${skipped} skipped (already sent/queued)` : ""),
        );
        void refreshQueueCount();
      } else {
        toast.error("Failed to add to queue.");
      }
    } catch {
      toast.error("Failed to add to queue.");
    }
  };

  const refreshQueueCount = useCallback(async () => {
    try {
      const res = await fetch("/api/queue");
      const data = (await res.json()) as {
        ok?: boolean;
        counts?: Record<string, number>;
        items?: { toEmail: string; status: string }[];
      };
      if (res.ok && data.ok) {
        setQueuedCount(data.counts?.queued ?? 0);
        // Sync the on-card "Queued" markers to the server so they stay
        // accurate across reloads and reflect items queued from the modal.
        const active = new Set(
          (data.items ?? [])
            .filter((i) => i.status === "queued" || i.status === "sending")
            .map((i) => i.toEmail.toLowerCase()),
        );
        setQueuedEmails(active);
      }
    } catch {
      // best-effort badge
    }
  }, []);

  // Remove an email from the queue (the card toggle's "cancel" action).
  const dequeueEmail = async (email: string) => {
    // Optimistic: clear the marker immediately.
    setQueuedEmails((prev) => {
      const next = new Set(prev);
      next.delete(email.toLowerCase());
      return next;
    });
    try {
      const res = await fetch(
        `/api/queue?action=cancel-email&email=${encodeURIComponent(email)}`,
        { method: "PATCH" },
      );
      const data = (await res.json()) as { ok?: boolean; canceled?: number };
      if (res.ok && data.ok) {
        toast.success("Removed from queue.");
      } else {
        toast.message("Already sending or sent — cannot cancel.");
      }
    } catch {
      toast.error("Failed to remove from queue.");
    } finally {
      void refreshQueueCount();
    }
  };

  useEffect(() => {
    void refreshQueueCount();
    const id = window.setInterval(refreshQueueCount, 15000);
    return () => window.clearInterval(id);
  }, [refreshQueueCount]);

  // Live "just sent" notifications: poll the recent-sends feed and toast each
  // new send as it goes out (queue drip openers, follow-ups, manual sends).
  const lastSendIdRef = useRef(0);
  const sendFeedPrimedRef = useRef(false);
  useEffect(() => {
    const poll = async () => {
      try {
        const res = await fetch(
          `/api/queue/recent?after=${lastSendIdRef.current}`,
        );
        const data = (await res.json()) as {
          ok?: boolean;
          latestId?: number;
          events?: {
            id: number;
            email: string;
            kind: "opener" | "followup" | "single";
            sender: string;
            at: string;
          }[];
        };
        if (!res.ok || !data.ok) return;
        // First poll only primes the cursor (don't toast history on load).
        if (!sendFeedPrimedRef.current) {
          sendFeedPrimedRef.current = true;
          lastSendIdRef.current = data.latestId ?? 0;
          return;
        }
        for (const e of data.events ?? []) {
          const label =
            e.kind === "followup"
              ? "Follow-up sent"
              : e.kind === "opener"
                ? "Opener sent"
                : "Email sent";
          toast.success(`${label} to ${e.email}`, {
            description: `from ${e.sender} · just now`,
          });
        }
        if (typeof data.latestId === "number") {
          lastSendIdRef.current = data.latestId;
        }
        if ((data.events?.length ?? 0) > 0) void refreshQueueCount();
      } catch {
        // Best-effort notifications.
      }
    };
    void poll();
    const id = window.setInterval(poll, 8000);
    return () => window.clearInterval(id);
  }, [refreshQueueCount]);

  const noRepos =
    repos !== null && repos.length === 0 && phase !== "loading-repos";

  const progressPct =
    progress && progress.total > 0
      ? Math.min(100, (progress.index / progress.total) * 100)
      : 0;

  // Live last-7-days summary for the nav strip (rolling window incl. today).
  // Full breakdown lives in the dashboard.
  const sheetInsights = useMemo(() => {
    const now = new Date();
    const from = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    from.setDate(from.getDate() - 6); // 6 days back + today = 7 days
    return computeInsights(sheetHistory.rows, { fromMs: from.getTime() });
  }, [sheetHistory.rows]);

  // The right column only holds contacts, so it is empty until a scan finds
  // some — fill that space with the insights dashboard instead of nothing.
  // Hidden the moment a scan starts (not merely when results arrive) so the
  // column doesn't show a full dashboard that is about to be replaced, and
  // hidden with no rows so a fresh install gets clean space, not an empty
  // shell. Note rows stay [] unless sheetsConfigured — useSheetHistory is
  // gated on it — so this panel is absent until logging is set up.
  const showIdleInsights =
    contacts.length === 0 &&
    phase !== "loading-repos" &&
    phase !== "scanning" &&
    sheetHistory.rows.length > 0;

  return (
    <KnockAppShell
      onReplyNotification={() => {
        void sheetHistory.refresh();
      }}
    >
    <>
      {/* Backdrop is pure CSS (static gradient + starfield). The WebGL fluid
          simulation and particle field that used to live here ran two 60fps
          contexts for the whole session — all cost, no information. */}
      <div className="app-bg" />

      <div className="relative z-10 flex h-screen w-screen flex-col">
        {/* TOP NAV ----------------------------------------------------- */}
        <nav className="fade-in relative z-40 flex items-center justify-center px-4 pt-4 md:px-8 md:pt-6">
          {/* Flex (not grid) with explicit shrink rules: the brand and the action
              chips keep their intrinsic width, and only the middle stats block
              gives way. Previously a grid `auto 1fr auto` let the brand column be
              compressed until the title wrapped onto four lines. */}
          <div className="glass flex w-full items-center gap-3 rounded-full px-4 py-2.5 md:gap-4 md:px-7 md:py-3">
            <div className="flex shrink-0 items-center gap-2">
              <LogoMark className="h-5 w-5 shrink-0" />
              {/* Full name only where it actually fits; a short form otherwise;
                  the logo alone on narrow windows. All non-wrapping. */}
              <span className="hidden whitespace-nowrap text-sm font-semibold uppercase tracking-[0.24em] text-cyan-300 2xl:inline">
                Cold Outreach Command Center
              </span>
              <span className="hidden whitespace-nowrap text-sm font-semibold uppercase tracking-[0.24em] text-cyan-300 sm:inline 2xl:hidden">
                Command Center
              </span>
            </div>
            {sheetsConfigured && sheetInsights.sent > 0 ? (
              <button
                type="button"
                onClick={() => {
                  sheetHistory.refreshIfStale();
                  setInsightsOpen(true);
                }}
                title="Open insights — last 7 days"
                /* The only flexible item: min-w-0 lets it shrink and
                   overflow-hidden makes it clip rather than overlap the brand
                   or the chips if it ever runs out of room. */
                className="hidden min-w-0 flex-1 items-center justify-center gap-2.5 overflow-hidden text-xs text-slate-300 transition hover:text-white xl:flex min-[1800px]:gap-4"
              >
                <span className="hidden whitespace-nowrap text-[10px] uppercase tracking-[0.2em] text-slate-500 min-[1800px]:inline">
                  7&#8209;day
                </span>
                <NavStat value={sheetInsights.sent} label="sent" color="text-slate-100" />
                <span className="text-slate-700">·</span>
                <NavStat
                  value={sheetInsights.uniqueContacts}
                  label="contacts"
                  color="text-sky-300"
                />
                <span className="text-slate-700">·</span>
                <NavStat
                  value={sheetInsights.replied}
                  label="replied"
                  color="text-emerald-300"
                />
                <span className="text-slate-700">·</span>
                <NavStat
                  value={`${Math.round(sheetInsights.replyRate * 100)}%`}
                  label="reply rate"
                  color="text-cyan-300"
                />
              </button>
            ) : (
              <span className="hidden min-w-0 flex-1 truncate text-center text-xs text-slate-500 xl:block">
                Find every lead. Reach them right.
              </span>
            )}
            {/* shrink-0 + ml-auto: the controls always keep their full size and
                stay pinned right, whatever the middle does. */}
            <div className="ml-auto flex shrink-0 items-center justify-end gap-1.5 text-xs text-slate-400 md:gap-2">
              {sheetsConfigured && (
                <ReplyNotificationsBell
                  displayRows={newReplies.displayRows}
                  unseenCount={newReplies.unseenCount}
                  allCount={newReplies.allCount}
                  customTabCounts={newReplies.customTabCounts}
                  filter={newReplies.filter}
                  onFilterChange={newReplies.setFilter}
                  onMarkSeen={newReplies.markSeen}
                  onMarkAllSeen={newReplies.markAllSeen}
                  customTabs={replyCustomTabs.customTabs}
                  onCreateCustomTab={(name, icon, threadKey) => {
                    const tabId = replyCustomTabs.createTab(name, icon);
                    replyCustomTabs.addThreadToTab(tabId, threadKey);
                    newReplies.setFilter({ kind: "custom", tabId });
                  }}
                  onAddToCustomTab={replyCustomTabs.addThreadToTab}
                  inboxContextFor={newReplies.inboxContextFor}
                  isUnread={newReplies.isUnread}
                  messageIds={sheetHistory.messageIds}
                  syncing={sheetHistory.syncingReplies}
                  senders={senders}
                  smtpConfigured={smtpConfigured}
                />
              )}
              {/* Analytics group */}
              <div className="nav-segment">
                <button
                  type="button"
                  onClick={() => {
                    sheetHistory.refreshIfStale();
                    setInsightsOpen(true);
                  }}
                  disabled={!sheetsConfigured}
                  data-ripple
                  className="nav-chip"
                  title={
                    sheetsConfigured
                      ? "7-day outreach insights"
                      : "Set SHEETS_WEBHOOK_URL in .env.local to enable insights"
                  }
                >
                  <InsightsIcon className="h-3.5 w-3.5 shrink-0" />
                  <span className="hidden lg:inline">Insights</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    sheetHistory.refreshIfStale();
                    setHistoryOpen(true);
                  }}
                  disabled={!sheetsConfigured}
                  data-ripple
                  className="nav-chip"
                  title={
                    sheetsConfigured
                      ? sheetHistory.ready
                        ? "View sent email history from Google Sheet"
                        : sheetHistory.loading
                          ? "Loading history in background…"
                          : "View sent email history from Google Sheet"
                      : "Set SHEETS_WEBHOOK_URL in .env.local to enable history"
                  }
                >
                  <HistoryIcon className="h-3.5 w-3.5 shrink-0" />
                  <span className="hidden lg:inline">History</span>
                  {sheetHistory.loading && !sheetHistory.ready && (
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-cyan-300" />
                  )}
                </button>
              </div>

              <span className="hidden h-6 w-px bg-white/10 sm:block" aria-hidden />

              {/* Active-pipeline group */}
              <div className="nav-segment">
                <button
                  type="button"
                  onClick={() => setContactsOpen(true)}
                  data-ripple
                  className="nav-chip"
                  title="Special contacts — emailed or saved profiles with phone/telegram fallbacks"
                >
                  <ContactsStarIcon className="h-3.5 w-3.5 shrink-0" />
                  <span className="hidden lg:inline">Contacts</span>
                </button>
                <button
                  type="button"
                  onClick={() => setQueueOpen(true)}
                  data-ripple
                  className="nav-chip"
                  title="Scheduled send queue — drip emails out automatically"
                >
                  <QueueIcon className="h-3.5 w-3.5 shrink-0" />
                  <span className="hidden lg:inline">Queue</span>
                  {queuedCount > 0 && <span className="nav-badge">{queuedCount}</span>}
                </button>
                <button
                  type="button"
                  onClick={() => setImportOpen(true)}
                  data-ripple
                  className="nav-chip"
                  title="Import a CSV of leads — finds each contact's best email and queues a two-step sequence"
                >
                  <ImportIcon className="h-3.5 w-3.5 shrink-0" />
                  <span className="hidden lg:inline">Import CSV</span>
                </button>
              </div>

              <span className="hidden h-6 w-px bg-white/10 sm:block" aria-hidden />

              {/* Setup menu - templates, accounts, token */}
              <SetupMenu
                accountsCount={senders.length}
                onTemplates={() => setTemplatesOpen(true)}
                onAccounts={() => {
                  setSendersFocus(null);
                  setSendersOpen(true);
                }}
                onGithubToken={() => {
                  setSendersFocus("github");
                  setSendersOpen(true);
                }}
              />
            </div>
          </div>
        </nav>

        {/* PRIMARY ACTION STRIP - context on the left, Send promoted right --- */}
        <div className="fade-in flex justify-center px-4 pt-3 md:px-8">
          <div className="flex w-full items-center justify-between gap-3 px-5 md:px-7">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              {user && (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-slate-300">
                  <GitHubIcon className="h-3.5 w-3.5 text-slate-300" />
                  <span className="text-[10px] uppercase tracking-[0.2em] text-slate-500">
                    target
                  </span>
                  <span className="font-mono text-slate-100">{user}</span>
                </span>
              )}
              <button
                type="button"
                onClick={() => setSendersOpen(true)}
                className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-slate-300 transition hover:border-cyan-400/40 hover:text-white"
                title="Manage Gmail sending accounts"
              >
                <span
                  className={
                    "h-1.5 w-1.5 rounded-full " +
                    (senders.length > 0
                      ? "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)]"
                      : "bg-amber-400")
                  }
                />
                {senders.length > 0
                  ? `${senders.length} sending account${senders.length === 1 ? "" : "s"}`
                  : "No sending account"}
              </button>
            </div>
            <button
              type="button"
              onClick={() => {
                setSendToEditable(true);
                setSendTarget({
                  kind: "email",
                  value: "",
                  names: [],
                  sources: [],
                });
              }}
              data-ripple
              className="btn-send-primary"
              title="Compose and send a new email"
            >
              <SendIcon className="h-4 w-4" />
              Compose &amp; Send
            </button>
          </div>
        </div>

        <main className="flex min-h-0 flex-1 flex-col gap-4 p-4 md:flex-row md:gap-6 md:p-6">
        {/* LEFT - controls + activity log --------------------------- */}
        <section className="flex min-h-0 w-full flex-col gap-5 overflow-auto px-2 pb-2 pt-2 md:w-1/2 md:px-4">
          <header className="fade-in relative z-10 pt-2">
            <h1 className="hero-title text-[34px] font-bold leading-[1] tracking-tight text-slate-50 md:text-5xl">
              Cold Outreach Command Center
            </h1>
            <p className="mt-3 flex items-center gap-2 text-sm font-medium text-cyan-300/90">
              <PinIcon className="h-4 w-4" />
              GitHub · Stack Overflow · Personal sites
            </p>
          </header>

          <div className="slide-in relative z-10">
            <label className="mb-2 block text-[11px] font-medium uppercase tracking-[0.22em] text-slate-400">
              Profile URL
            </label>
            <div className="relative max-w-md">
              <SearchIcon className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
              <input
                type="text"
                value={profileUrl}
                onChange={(e) => setProfileUrl(e.target.value)}
                placeholder="github.com/user · stackoverflow.com/users/…"
                className="w-full rounded-full border border-white/10 bg-slate-950/70 py-2 pl-10 pr-4 text-sm text-slate-100 outline-none transition placeholder:text-slate-600 focus:border-cyan-400 focus:ring-2 focus:ring-cyan-400/30"
                spellCheck={false}
                autoComplete="off"
              />
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
              <span className="uppercase tracking-[0.22em] text-slate-500">
                Sources
              </span>
              <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-slate-200">
                <GitHubIcon className="h-3.5 w-3.5" />
                GitHub
              </span>
              <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-slate-200">
                <StackOverflowIcon className="h-3.5 w-3.5 text-[#F48024]" />
                Stack Overflow
              </span>
            </div>
            <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
              Paste a developer profile and the Command Center sweeps its fields, pinned
              README, personal site, linked URLs, and recent commit patches to
              surface every public email, phone, and handle - ready for two-step
              outreach in seconds.
            </p>
            {phase === "loading-repos" && (
              <p className="fade-in mt-3 flex items-center gap-2 text-xs text-slate-400">
                <SpinnerIcon className="h-3.5 w-3.5 animate-spin text-cyan-400" />
                Loading repositories…
              </p>
            )}

            {repos && repos.length > 0 && (
              <div className="slide-in mt-5 flex flex-wrap items-end gap-3">
                <div className="min-w-[180px] max-w-xs flex-1">
                  <label className="mb-1.5 block text-[11px] font-medium uppercase tracking-[0.22em] text-slate-400">
                    Repository
                  </label>
                  <select
                    value={selectedRepo}
                    onChange={(e) => setSelectedRepo(e.target.value)}
                    className="w-full truncate rounded-full border border-white/10 bg-slate-950/70 px-4 py-2 text-sm text-slate-100 outline-none transition focus:border-cyan-400 focus:ring-2 focus:ring-cyan-400/30"
                  >
                    <option value={ALL_REPOS}>
                      All repositories ({repos.length})
                    </option>
                    {repos.map((r) => (
                      <option key={r.name} value={r.name}>
                        {r.name}
                        {r.pushedAt
                          ? ` - ${new Date(r.pushedAt).toLocaleDateString()}`
                          : ""}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="mb-1.5 block text-[11px] font-medium uppercase tracking-[0.22em] text-slate-400">
                    Commits
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={100}
                    value={commitsPerRepo}
                    onChange={(e) =>
                      setCommitsPerRepo(Number(e.target.value) || 1)
                    }
                    className="w-20 rounded-full border border-white/10 bg-slate-950/70 px-4 py-2 text-center text-sm text-slate-100 outline-none transition focus:border-cyan-400 focus:ring-2 focus:ring-cyan-400/30"
                  />
                </div>
                {phase === "scanning" && (
                  <button
                    type="button"
                    onClick={cancel}
                    data-ripple
                    title="Stop scanning"
                    className="btn-press inline-flex items-center gap-2 rounded-full border border-rose-400/40 bg-rose-500/10 px-4 py-2 text-sm font-medium text-rose-200 transition hover:border-rose-300/70 hover:bg-rose-500/20 hover:text-white"
                  >
                    <StopIcon className="h-3.5 w-3.5" />
                    Stop
                  </button>
                )}
              </div>
            )}

            {phase === "scanning" && progress && progress.total > 0 && (
              <div className="fade-in mt-5">
                <div className="mb-1.5 flex items-center justify-between text-[11px] text-slate-400">
                  <span className="flex items-center gap-1.5">
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-cyan-400" />
                    {progressLabel}
                  </span>
                  <span className="font-mono text-cyan-300">
                    {progress.index}/{progress.total}
                  </span>
                </div>
                <div className="h-1 w-full overflow-hidden rounded-full bg-slate-800/60">
                  {/* scaleX, not width: this bar updates on every commit, and
                      animating width relayouts the row each time. */}
                  <div
                    className="h-full w-full origin-left bg-cyan-400 transition-transform duration-300"
                    style={{ transform: `scaleX(${progressPct / 100})` }}
                  />
                </div>
              </div>
            )}
          </div>

          {error && (
            <div className="fade-in relative z-10 rounded-lg border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
              {error}
            </div>
          )}

          {noRepos && (
            <div className="fade-in relative z-10 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
              No non-fork repositories found for{" "}
              <span className="font-mono">{user}</span>.
            </div>
          )}

          <div className="slide-in relative flex min-h-0 flex-1 flex-col overflow-hidden">
            {/* The scan's feedback is the streaming log below — the full-screen
                radar shader that used to overlay it was decoration on top of
                real information, running a per-pixel shader the whole scan. */}
            <div className="relative z-10 flex items-center justify-between border-b border-white/5 px-2 py-2 text-[11px] uppercase tracking-[0.22em] text-slate-400">
              <span className="flex items-center gap-2">
                <ActivityIcon className="h-3.5 w-3.5 text-cyan-400" />
                Activity log
              </span>
              <span className="font-mono normal-case tracking-normal">
                {log.length} event{log.length === 1 ? "" : "s"}
              </span>
            </div>
            <div
              ref={logScrollRef}
              className="relative z-10 flex-1 overflow-auto px-2 py-2 font-mono text-xs leading-relaxed"
            >
              {log.length === 0 ? (
                <p className="pt-6 text-center text-slate-500">
                  Waiting for a profile URL…
                </p>
              ) : (
                log.map((entry) => (
                  <div
                    key={entry.id}
                    className={
                      "fade-in " +
                      (entry.kind === "match"
                        ? "text-emerald-300"
                        : entry.kind === "skip"
                          ? "text-slate-500"
                          : entry.kind === "error"
                            ? "text-rose-300"
                            : entry.kind === "done"
                              ? "text-sky-300"
                              : "text-slate-300")
                    }
                  >
                    {entry.text}
                  </div>
                ))
              )}
            </div>
          </div>
        </section>

        {/* RIGHT - contacts (after a scan), or the insights dashboard while
            the column is otherwise idle. The same dashboard is still behind
            the nav button (InsightsModal) for on-demand use during a scan. */}
        <section className="no-scrollbar flex min-h-0 w-full flex-col overflow-y-auto overflow-x-hidden px-8 py-8 md:w-1/2 md:px-10">
          {contacts.length > 0 && (
            <div className="slide-in mb-5 flex flex-wrap items-center gap-2 text-[11px] uppercase tracking-[0.22em] text-slate-400">
              <span className="text-slate-500">Contacts</span>
              <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-2.5 py-1 normal-case tracking-normal text-slate-200">
                <MailIcon className="h-3.5 w-3.5 text-cyan-300" />
                {contactCounts.email} email{contactCounts.email === 1 ? "" : "s"}
              </span>
              <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-2.5 py-1 normal-case tracking-normal text-slate-200">
                <TelegramIcon className="h-3.5 w-3.5 text-cyan-300" />
                {contactCounts.telegram} telegram
              </span>
              <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-2.5 py-1 normal-case tracking-normal text-slate-200">
                <PhoneIcon className="h-3.5 w-3.5 text-cyan-300" />
                {contactCounts.phone} phone
              </span>
            </div>
          )}
          {contacts.length > 0 && (
            <ul className="slide-in space-y-5">
              {contacts.map((c) => {
                const isSent = c.kind === "email" && sentEmails.has(c.value);
                return (
                  <li key={`${c.kind}:${c.value}`}>
                    {/* Static card. This used to be an <ElectricBorder>, i.e. a
                        canvas + rAF noise loop and three glow layers PER
                        CONTACT — the cost scaled with the result count. */}
                    <div className="contact-card">
                      <div className="group px-5 py-4">
                    <div className="flex items-center gap-3">
                      <span className="relative shrink-0">
                        <ContactAvatar contact={c} />
                        {isSent && (
                          <span
                            className="absolute -bottom-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full border-2 border-slate-950 bg-emerald-500 text-slate-950 shadow-[0_0_10px_rgba(16,185,129,0.6)]"
                            title="Email sent"
                          >
                            <CheckIcon className="h-3 w-3" />
                          </span>
                        )}
                      </span>
                      <a
                        href={
                          c.kind === "email"
                            ? `mailto:${c.value}`
                            : c.kind === "telegram"
                              ? `https://t.me/${c.value}`
                              : `tel:${c.value}`
                        }
                        target={c.kind === "telegram" ? "_blank" : undefined}
                        rel={c.kind === "telegram" ? "noreferrer" : undefined}
                        className="flex-1 break-all font-mono text-[15px] text-slate-100 transition group-hover:text-cyan-200"
                      >
                        {c.kind === "telegram" ? `@${c.value}` : c.value}
                      </a>
                      {profileLocation.country && (
                        <span
                          className="inline-flex shrink-0 items-center gap-1"
                          title={
                            profileLocation.source === "commit" &&
                            profileLocation.confidence === "low"
                              ? `${profileLocation.country} — estimated from commit timezone (${prettyOffset(profileLocation.timezone)})`
                              : profileLocation.country
                          }
                        >
                          <CountryFlag
                            country={profileLocation.country}
                            size={13}
                            className="align-[-2px]"
                          />
                          {profileLocation.source === "commit" &&
                            profileLocation.confidence === "low" && (
                              <span className="text-[10px] text-slate-500">
                                {prettyOffset(profileLocation.timezone)}
                              </span>
                            )}
                        </span>
                      )}
                      {c.names.length > 0 && (
                        <span className="truncate text-xs text-slate-400">
                          {c.names.join(", ")}
                        </span>
                      )}
                      {c.kind === "email" ? (
                        <button
                          type="button"
                          onClick={() => {
                            setSendToEditable(false);
                            setSendTarget(c);
                          }}
                          data-ripple
                          className={
                            "btn-press shrink-0 inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition " +
                            (isSent
                              ? "border-emerald-400/40 bg-emerald-500/15 text-emerald-300 hover:border-emerald-300/70 hover:bg-emerald-500/25 hover:text-emerald-100"
                              : "border-cyan-400/30 bg-cyan-500/10 text-cyan-200 hover:border-cyan-300/80 hover:bg-cyan-400/20 hover:text-white")
                          }
                          title={isSent ? "Sent - click to send again" : "Compose and send email"}
                        >
                          {isSent ? (
                            <>
                              <CheckIcon className="h-3.5 w-3.5" />
                              Sent
                            </>
                          ) : (
                            <>
                              <SendIcon className="h-3.5 w-3.5" />
                              Send
                            </>
                          )}
                        </button>
                      ) : c.kind === "telegram" ? (
                        <span className="flex shrink-0 items-center gap-1.5">
                          <a
                            href={`https://t.me/${c.value}`}
                            target="_blank"
                            rel="noreferrer"
                            data-ripple
                            className="btn-press inline-flex items-center gap-1.5 rounded-full border border-cyan-400/30 bg-cyan-500/10 px-3 py-1 text-xs font-medium text-cyan-200 transition hover:border-cyan-300/80 hover:bg-cyan-400/20 hover:text-white"
                            title="Open in Telegram"
                          >
                            <TelegramIcon className="h-3.5 w-3.5" />
                            Open
                          </a>
                          <button
                            type="button"
                            onClick={() => setDirectSaveOpen(true)}
                            data-ripple
                            className="btn-press inline-flex items-center rounded-full border border-amber-400/30 bg-amber-500/10 px-2 py-1 text-xs font-medium text-amber-200 transition hover:border-amber-300/80 hover:bg-amber-400/20 hover:text-white"
                            title="Save this profile to contacts (no email needed)"
                          >
                            ☆
                          </button>
                        </span>
                      ) : (
                        <span className="flex shrink-0 items-center gap-1.5">
                          <a
                            href={`tel:${c.value}`}
                            data-ripple
                            className="btn-press inline-flex items-center gap-1.5 rounded-full border border-cyan-400/30 bg-cyan-500/10 px-3 py-1 text-xs font-medium text-cyan-200 transition hover:border-cyan-300/80 hover:bg-cyan-400/20 hover:text-white"
                            title="Call"
                          >
                            <PhoneIcon className="h-3.5 w-3.5" />
                            Call
                          </a>
                          <button
                            type="button"
                            onClick={() => setDirectSaveOpen(true)}
                            data-ripple
                            className="btn-press inline-flex items-center rounded-full border border-amber-400/30 bg-amber-500/10 px-2 py-1 text-xs font-medium text-amber-200 transition hover:border-amber-300/80 hover:bg-amber-400/20 hover:text-white"
                            title="Save this profile to contacts (no email needed)"
                          >
                            ☆
                          </button>
                        </span>
                      )}
                    </div>
                    {c.sources.length > 0 && (
                      <div className="mt-3 flex flex-wrap items-center gap-2 pl-12">
                        {c.sources.map((s, i) => {
                          const formatted = formatSourceDate(s.date);
                          const iso = s.date ?? "";
                          const tooltip = formatted
                            ? `${s.label} - ${iso}${s.url ? ` - ${s.url}` : ""}`
                            : s.url
                              ? `${s.label} - ${s.url}`
                              : s.label;
                          const content = (
                            <>
                              {s.url ? <LinkIcon className="h-3 w-3" /> : null}
                              <span>{s.label}</span>
                              {formatted && (
                                <span className="ml-0.5 inline-flex items-center gap-1 border-l border-white/10 pl-1.5 text-[10px] font-medium uppercase tracking-wider text-cyan-300/90">
                                  <ClockIcon className="h-3 w-3" />
                                  {formatted}
                                </span>
                              )}
                            </>
                          );
                          return s.url ? (
                            <a
                              key={`${s.label}-${i}`}
                              href={s.url}
                              target="_blank"
                              rel="noreferrer"
                              title={tooltip}
                              className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-2.5 py-0.5 text-[11px] text-slate-400 transition hover:border-cyan-400/40 hover:bg-cyan-400/10 hover:text-cyan-300"
                            >
                              {content}
                            </a>
                          ) : (
                            <span
                              key={`${s.label}-${i}`}
                              title={tooltip}
                              className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-2.5 py-0.5 text-[11px] text-slate-400"
                            >
                              {content}
                            </span>
                          );
                        })}
                      </div>
                    )}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          {showIdleInsights && (
            <InsightsDashboard
              className="fade-in"
              rows={sheetHistory.rows}
              replies={sheetHistory.replyNotifications}
              loading={sheetHistory.loading}
              onRefresh={() => void sheetHistory.refresh()}
              // All time, not today: an always-on panel must not open on an
              // empty window after a quiet week, and the nav strip already
              // carries the rolling 7-day numbers. Narrow with the picker.
              // No onClose — it isn't dismissible, it yields to scan results.
              initialPreset="all"
            />
          )}
        </section>

        </main>
      </div>

      {sendTarget && (
        <SendModal
          contact={sendTarget}
          editableTo={sendToEditable}
          prefill={sendPrefill ?? undefined}
          senders={senders}
          smtpConfigured={smtpConfigured}
          githubUser={user}
          country={
            sendPrefill?.country?.trim() ||
            extractCountry(discovery?.location)
          }
          commitOffsetMin={sendPrefill ? null : profileTzOffset}
          phones={sendPrefill ? [] : profilePhones}
          onClose={() => {
            setSendTarget(null);
            setSendToEditable(false);
            setSendPrefill(null);
          }}
          onSent={(email, link) => {
            // A send from the current scan's found results (not from
            // History or manual compose) records the special-contact
            // snapshot: this email + every phone/telegram found.
            if (email && user && !sendPrefill && !sendToEditable) {
              saveContactSnapshot({ sentEmail: email, attachedUrl: link });
            }
            if (email) {
              setSentEmails((prev) => {
                const next = new Set(prev);
                next.add(email.toLowerCase());
                return next;
              });
            }
            void sheetHistory.refresh();
          }}
          onQueued={(email) => {
            setQueuedEmails((prev) => {
              const next = new Set(prev);
              next.add(email.toLowerCase());
              return next;
            });
            void refreshQueueCount();
          }}
        />
      )}

      {historyOpen && (
        <HistoryModal
          rows={sheetHistory.rows}
          loading={sheetHistory.loading}
          error={sheetHistory.error}
          onRefresh={() => void sheetHistory.refresh()}
          onSendRow={(row) => {
            const email = primaryEmail(row.contact);
            if (!email.includes("@")) return;
            setSendPrefill({
              name: row.name?.trim() || undefined,
              url: row.link?.trim() || undefined,
              fromEmail: row.sender?.trim() || undefined,
              country: row.country?.trim() || undefined,
            });
            setSendToEditable(false);
            setSendTarget({
              kind: "email",
              value: email,
              names: row.name?.trim() ? [row.name.trim()] : [],
              sources: [],
            });
          }}
          onClose={() => setHistoryOpen(false)}
        />
      )}

      {insightsOpen && (
        <InsightsModal
          rows={sheetHistory.rows}
          replies={sheetHistory.replyNotifications}
          loading={sheetHistory.loading}
          onRefresh={() => void sheetHistory.refresh()}
          onClose={() => setInsightsOpen(false)}
        />
      )}

      {templatesOpen && (
        <TemplatesModal onClose={() => setTemplatesOpen(false)} />
      )}

      {queueOpen && (
        <QueueModal
          senders={senders}
          onClose={() => {
            setQueueOpen(false);
            void refreshQueueCount();
          }}
        />
      )}

      {importOpen && (
        <ImportCsvModal
          onQueued={() => void refreshQueueCount()}
          onClose={() => {
            setImportOpen(false);
            void refreshQueueCount();
          }}
        />
      )}

      {sendersOpen && (
        <SendersModal
          focusSection={sendersFocus}
          onClose={() => {
            setSendersOpen(false);
            setSendersFocus(null);
          }}
          onChanged={() => void refreshSenders()}
        />
      )}

      {directSaveOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/90 p-4"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) {
              setDirectSaveOpen(false);
              setDirectSaveDone(false);
            }
          }}
        >
          <div className="w-full max-w-md rounded-2xl border border-white/10 bg-slate-900 p-5 shadow-2xl">
            <h3 className="text-sm font-semibold uppercase tracking-[0.22em] text-slate-200">
              Save to contacts
            </h3>
            <p className="mt-2 text-xs text-slate-400">
              Saves{" "}
              <span className="text-cyan-300">{user ?? "this profile"}</span>{" "}
              with every phone number and telegram found - no email needed.
              It will appear under ★ special contacts.
            </p>
            <label className="mt-4 mb-1 block text-[11px] font-medium uppercase tracking-[0.22em] text-slate-400">
              Attach URL (optional)
            </label>
            <input
              type="text"
              value={directSaveUrl}
              onChange={(e) => setDirectSaveUrl(e.target.value)}
              placeholder="Upwork profile, website…"
              className="w-full rounded-lg border border-white/10 bg-slate-950/70 px-4 py-2.5 text-sm text-slate-100 outline-none transition focus:border-cyan-400 focus:ring-2 focus:ring-cyan-400/30"
            />
            <div className="mt-4 flex items-center gap-3">
              <button
                type="button"
                onClick={() => {
                  saveContactSnapshot({
                    direct: true,
                    attachedUrl: directSaveUrl.trim() || undefined,
                  });
                  setDirectSaveDone(true);
                  window.setTimeout(() => {
                    setDirectSaveOpen(false);
                    setDirectSaveDone(false);
                    setDirectSaveUrl("");
                  }, 1200);
                }}
                data-ripple
                className="btn-press rounded-full border border-amber-400/40 bg-amber-500/15 px-4 py-1.5 text-sm font-medium text-amber-100 transition hover:border-amber-300 hover:bg-amber-400/25 hover:text-white"
              >
                {directSaveDone ? "✓ Saved" : "☆ Save contact"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setDirectSaveOpen(false);
                  setDirectSaveDone(false);
                }}
                className="rounded-full px-3 py-1.5 text-sm text-slate-400 transition hover:text-white"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {contactsOpen && (
        <ContactsModal
          onClose={() => setContactsOpen(false)}
          onSendEmail={(email, contact) => {
            setContactsOpen(false);
            setSendPrefill({
              name: contact.name || undefined,
              url: contact.attachedUrl || contact.profileUrl || undefined,
              country: contact.country || undefined,
            });
            setSendToEditable(false);
            setSendTarget({
              kind: "email",
              value: email,
              names: contact.name ? [contact.name] : [],
              sources: [],
            });
          }}
        />
      )}

    </>
    </KnockAppShell>
  );
}

// --- Inline icons (no runtime dep) ------------------------------------

type IconProps = { className?: string };

function SearchIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}

function MailIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m3 7 9 7 9-7" />
    </svg>
  );
}

function TelegramIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0Zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635Z" />
    </svg>
  );
}

function PhoneIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.79 19.79 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92Z" />
    </svg>
  );
}

function LinkIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M10 13a5 5 0 0 0 7.07 0l2.83-2.83a5 5 0 0 0-7.07-7.07l-1.41 1.41" />
      <path d="M14 11a5 5 0 0 0-7.07 0L4.1 13.83a5 5 0 0 0 7.07 7.07l1.41-1.41" />
    </svg>
  );
}

function ActivityIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M3 12h4l3-8 4 16 3-8h4" />
    </svg>
  );
}

function SpinnerIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" className={className}>
      <path d="M21 12a9 9 0 1 1-6.22-8.56" />
    </svg>
  );
}

function StopIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  );
}

function SparkIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M12 2 13.8 8.2 20 10 13.8 11.8 12 18 10.2 11.8 4 10 10.2 8.2 12 2Z" />
      <path d="M19 14 19.7 16.3 22 17 19.7 17.7 19 20 18.3 17.7 16 17 18.3 16.3 19 14Z" />
    </svg>
  );
}

function PinIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M12 2C8.13 2 5 5.13 5 9c0 4.63 5.5 11.33 6.42 12.43a.74.74 0 0 0 1.16 0C13.5 20.33 19 13.63 19 9c0-3.87-3.13-7-7-7Zm0 9.5A2.5 2.5 0 1 1 12 6a2.5 2.5 0 0 1 0 5Z" />
    </svg>
  );
}

function LogoMark({ className }: IconProps) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden>
      <rect width="32" height="32" rx="7" fill="#0a1222" />
      <g
        transform="translate(6 9)"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="text-cyan-400"
      >
        <rect x="0" y="1" width="20" height="14" rx="2" />
        <path d="M0 3 L10 10 L20 3" />
      </g>
      <circle cx="25.5" cy="7.5" r="2.5" className="fill-cyan-400" />
    </svg>
  );
}


function SendIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="m3 11 18-8-8 18-2-8z" />
    </svg>
  );
}

function HistoryIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

function CheckIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function InsightsIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M21 12a9 9 0 1 1-9-9v9z" />
      <path d="M21 12a9 9 0 0 0-9-9" opacity="0.5" />
    </svg>
  );
}

function NavStat({
  value,
  label,
  color,
}: {
  value: string | number;
  label: string;
  color: string;
}) {
  // Below 2xl only the number shows (the word label roughly doubles this
  // stat's width, and four of them together were enough to push the nav into
  // overlapping itself). The title keeps the meaning available on hover.
  return (
    <span className="inline-flex items-baseline gap-1.5 whitespace-nowrap" title={label}>
      <span className={"text-sm font-bold " + color}>{value}</span>
      <span className="hidden text-[10px] uppercase tracking-wider text-slate-500 min-[1800px]:inline">
        {label}
      </span>
    </span>
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

function GitHubIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M12 0C5.373 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.6.111.82-.26.82-.577 0-.286-.011-1.231-.016-2.234-3.338.726-4.043-1.416-4.043-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.085 1.838 1.237 1.838 1.237 1.07 1.834 2.809 1.304 3.493.997.108-.776.419-1.305.762-1.605-2.665-.303-5.467-1.332-5.467-5.932 0-1.31.469-2.381 1.237-3.221-.124-.303-.536-1.524.117-3.176 0 0 1.008-.323 3.301 1.23A11.49 11.49 0 0 1 12 5.803a11.47 11.47 0 0 1 3.003.404c2.291-1.553 3.297-1.23 3.297-1.23.655 1.652.243 2.873.119 3.176.77.84 1.235 1.911 1.235 3.221 0 4.612-2.807 5.625-5.48 5.922.43.371.813 1.102.813 2.222 0 1.606-.014 2.898-.014 3.293 0 .32.217.694.825.576C20.565 21.796 24 17.3 24 12c0-6.627-5.373-12-12-12Z"
      />
    </svg>
  );
}

function StackOverflowIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path
        d="M18.986 21.865v-6.404h2.134V24H1.844v-8.539h2.13v6.404H18.985ZM6.111 19.731H16.76v-2.13H6.111v2.13Zm.259-4.852 10.43 2.187.452-2.064-10.48-2.196-.402 2.073Zm1.373-4.955 9.671 4.491.935-1.95-9.685-4.505-.921 1.964Zm2.715-4.748 8.19 6.82 1.36-1.635-8.197-6.826-1.353 1.641ZM15.787 0l-1.735 1.287 6.437 8.6 1.725-1.281L15.787 0Z"
      />
    </svg>
  );
}

function ClockIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

function EyeIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function SettingsIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function ChevronDownIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function TemplateIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 9h18M8 9v11" />
    </svg>
  );
}

function ContactsStarIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d="M12 2.5l2.9 5.88 6.49.94-4.7 4.58 1.11 6.46L12 17.3l-5.8 3.06 1.11-6.46-4.7-4.58 6.49-.94L12 2.5z" />
    </svg>
  );
}

function QueueIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
    </svg>
  );
}

function ImportIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="M17 8l-5-5-5 5" />
      <path d="M12 3v12" />
    </svg>
  );
}

function AccountsIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <circle cx="12" cy="12" r="4" />
      <path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-3.92 7.94" />
    </svg>
  );
}

function KeyIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <circle cx="7.5" cy="15.5" r="3.5" />
      <path d="m10 13 8-8M15 5l2 2M18 8l2-2" />
    </svg>
  );
}

function ExternalIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    </svg>
  );
}

// Setup dropdown - groups the low-frequency config actions (templates,
// sending accounts, GitHub token) behind a single ⚙ trigger so the nav bar
// stays focused on daily analytics + pipeline actions.
function SetupMenu({
  accountsCount,
  onTemplates,
  onAccounts,
  onGithubToken,
}: {
  accountsCount: number;
  onTemplates: () => void;
  onAccounts: () => void;
  onGithubToken: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        data-ripple
        aria-haspopup="menu"
        aria-expanded={open}
        className={"nav-chip" + (open ? " nav-chip-active" : "")}
        title="Setup - templates, sending accounts, GitHub token"
      >
        <SettingsIcon className="h-3.5 w-3.5 shrink-0" />
        <span className="hidden lg:inline">Setup</span>
        <ChevronDownIcon
          className={"h-3 w-3 transition-transform " + (open ? "rotate-180" : "")}
        />
      </button>
      {open && (
        <div
          role="menu"
          className="fade-in absolute right-0 top-[calc(100%+0.7rem)] z-50 w-60 rounded-2xl border border-white/10 bg-slate-900 p-1.5 shadow-[0_24px_70px_-12px_rgba(0,0,0,0.9)] ring-1 ring-black/40"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onTemplates();
            }}
            className="menu-item"
          >
            <TemplateIcon className="h-4 w-4 text-cyan-300" />
            <span>Templates</span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onAccounts();
            }}
            className="menu-item"
          >
            <AccountsIcon className="h-4 w-4 text-cyan-300" />
            <span>Accounts</span>
            {accountsCount > 0 && (
              <span className="nav-badge ml-auto">{accountsCount}</span>
            )}
          </button>
          <div className="my-1 h-px bg-white/10" />
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onGithubToken();
            }}
            className="menu-item"
          >
            <KeyIcon className="h-4 w-4 text-slate-400" />
            <span>GitHub token</span>
          </button>
        </div>
      )}
    </div>
  );
}

// --- Contact avatar (provider-aware) ----------------------------------

type EmailProvider =
  | "gmail"
  | "proton"
  | "outlook"
  | "icloud"
  | "yahoo"
  | "yandex"
  | "generic";

function detectEmailProvider(email: string): EmailProvider {
  const domain = (email.split("@")[1] ?? "").toLowerCase();
  if (domain === "gmail.com" || domain === "googlemail.com") return "gmail";
  if (
    domain === "proton.me" ||
    domain === "protonmail.com" ||
    domain === "protonmail.ch" ||
    domain === "pm.me"
  )
    return "proton";
  if (/^(outlook|hotmail|live|msn)\.[a-z.]+$/.test(domain)) return "outlook";
  if (domain === "icloud.com" || domain === "me.com" || domain === "mac.com")
    return "icloud";
  if (
    /^yahoo\.[a-z.]+$/.test(domain) ||
    domain === "ymail.com" ||
    domain === "rocketmail.com"
  )
    return "yahoo";
  if (/^yandex\.[a-z.]+$/.test(domain) || domain === "ya.ru")
    return "yandex";
  return "generic";
}

// Brand colour + short label shown as a tooltip on the avatar. Keeps the
// visual language consistent: bright branded glyph in a tinted rounded tile.
const EMAIL_PROVIDER_META: Record<
  EmailProvider,
  { color: string; label: string }
> = {
  gmail: { color: "#ea4335", label: "Gmail" },
  proton: { color: "#6d4aff", label: "Proton Mail" },
  outlook: { color: "#0078d4", label: "Outlook" },
  icloud: { color: "#3693f3", label: "iCloud Mail" },
  yahoo: { color: "#6001d2", label: "Yahoo Mail" },
  yandex: { color: "#ff3333", label: "Yandex Mail" },
  generic: { color: "#22d3ee", label: "Email" },
};

function GmailGlyph({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d="M24 5.457v13.909c0 .904-.732 1.636-1.636 1.636h-3.819V11.73L12 16.64l-6.545-4.91v9.273H1.636A1.636 1.636 0 0 1 0 19.366V5.457c0-2.023 2.309-3.178 3.927-1.964L5.455 4.64 12 9.548l6.545-4.91 1.528-1.145C21.69 2.28 24 3.434 24 5.457z" />
    </svg>
  );
}

function ProtonGlyph({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden>
      <rect
        x="2.5"
        y="5"
        width="19"
        height="14"
        rx="2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <path d="M6 16 L12 8 L18 16 Z" fill="currentColor" />
    </svg>
  );
}

function OutlookGlyph({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden>
      <rect
        x="3"
        y="5"
        width="18"
        height="14"
        rx="2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <ellipse
        cx="9"
        cy="12"
        rx="3.4"
        ry="3.8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <path
        d="M15 10 L15 14 L18 14"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}

function ICloudGlyph({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d="M17.7 11.1a5.5 5.5 0 0 0-10.9-.9 4.2 4.2 0 0 0-1.5-.3A4.3 4.3 0 0 0 1 14.2 4.3 4.3 0 0 0 5.3 18.5h13a3.75 3.75 0 0 0 .4-7.48 5.55 5.55 0 0 0-1-.05z" />
    </svg>
  );
}

function YahooGlyph({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d="M3 4.5h4.1l2.9 4.9 2.9-4.9h3.9l-4.8 8v6.6h-4v-6.6L3 4.5z" />
      <rect x="18.5" y="5" width="2.8" height="7.2" rx="0.8" />
      <circle cx="19.9" cy="14.8" r="1.6" />
    </svg>
  );
}

function YandexGlyph({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d="M14.1 3.5h-2.7C7.6 3.5 4.9 6.1 4.9 9.8c0 2.6 1.3 4.5 3.3 5.5L4.5 20.5h3l3.6-5.7h.9v5.7h2.1V3.5zm-2.1 9.6h-.4c-2 0-3.5-1.3-3.5-3.4 0-2.4 1.6-3.5 3.6-3.5h.3v6.9z" />
    </svg>
  );
}

function ContactAvatar({ contact }: { contact: Contact }) {
  let color = EMAIL_PROVIDER_META.generic.color;
  let label = "Email";
  let Glyph: (p: IconProps) => ReactElement = MailIcon;

  if (contact.kind === "telegram") {
    color = "#229ed9";
    label = "Telegram";
    Glyph = TelegramIcon;
  } else if (contact.kind === "phone") {
    color = "#10b981";
    label = "Phone";
    Glyph = PhoneIcon;
  } else {
    const provider = detectEmailProvider(contact.value);
    color = EMAIL_PROVIDER_META[provider].color;
    label = EMAIL_PROVIDER_META[provider].label;
    switch (provider) {
      case "gmail":
        Glyph = GmailGlyph;
        break;
      case "proton":
        Glyph = ProtonGlyph;
        break;
      case "outlook":
        Glyph = OutlookGlyph;
        break;
      case "icloud":
        Glyph = ICloudGlyph;
        break;
      case "yahoo":
        Glyph = YahooGlyph;
        break;
      case "yandex":
        Glyph = YandexGlyph;
        break;
      default:
        Glyph = MailIcon;
    }
  }

  const glyphTile = (
    <div
      title={label}
      aria-label={label}
      className="relative flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border transition-transform duration-200 group-hover:scale-[1.04]"
      style={{
        color,
        borderColor: `${color}66`,
        background: `linear-gradient(135deg, ${color}24 0%, ${color}0d 100%)`,
        boxShadow: `0 0 22px -10px ${color}, inset 0 0 0 1px ${color}1a`,
      }}
    >
      <Glyph className="h-[26px] w-[26px]" />
    </div>
  );

  // For emails, try the person's real avatar (Gravatar) and fall back to the
  // provider-tinted glyph tile when they have none.
  if (contact.kind === "email") {
    return (
      <GmailAvatar
        email={contact.value}
        size={48}
        className="rounded-2xl border border-white/10 transition-transform duration-200 group-hover:scale-[1.04]"
        fallback={glyphTile}
      />
    );
  }

  return glyphTile;
}

// --- Send modal -------------------------------------------------------

function trimUrlAtQuery(url: string): string {
  const q = url.indexOf("?");
  return q >= 0 ? url.slice(0, q) : url;
}

function substitute(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => vars[k] ?? "");
}

function isValidEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

function SendModal({
  contact,
  editableTo = false,
  prefill,
  senders,
  smtpConfigured,
  githubUser,
  country,
  commitOffsetMin,
  phones,
  onClose,
  onSent,
  onQueued,
}: {
  contact: Contact;
  editableTo?: boolean;
  prefill?: {
    name?: string;
    url?: string;
    fromEmail?: string;
    country?: string;
  };
  senders: MailIdentity[];
  smtpConfigured: boolean;
  githubUser: string | null;
  country: string;
  commitOffsetMin?: number | null;
  phones?: string[];
  onClose: () => void;
  onSent?: (email: string, link?: string) => void;
  onQueued?: (email: string) => void;
}) {
  const [fromEmail, setFromEmail] = useState<string>(() => {
    const fromPrefill = prefill?.fromEmail?.trim();
    if (
      fromPrefill &&
      senders.some((s) => s.email.toLowerCase() === fromPrefill.toLowerCase())
    ) {
      return fromPrefill;
    }
    return (
      (typeof window !== "undefined" && localStorage.getItem("mail.from")) ||
      senders[0]?.email ||
      ""
    );
  });
  const [toEmail, setToEmail] = useState(contact.value);
  const [name, setName] = useState(prefill?.name?.trim() ?? "");
  const [url, setUrl] = useState(prefill?.url?.trim() ?? "");
  const [urlLinkedin, setUrlLinkedin] = useState("");
  const [urlGithub, setUrlGithub] = useState(() =>
    githubUser ? `https://github.com/${githubUser}` : "",
  );
  const { templates, openers, followups, templatesLoaded, saveContentDebounced } =
    useTemplates();
  const lsGet = (k: string) =>
    typeof window !== "undefined" ? localStorage.getItem(k) : null;

  // Auto-rotate the sending account: immediate sends pick a random account, and
  // queued items are stored with no fixed sender so the queue worker rotates
  // them (honouring the sender pool / rotate settings).
  const [autoRotateSender, setAutoRotateSender] = useState(
    () => lsGet("mail.autoRotateSender") === "1",
  );

  // Per-account daily cap usage (from the queue worker status) so auto-rotate
  // steers away from capped accounts and a warning shows when the chosen
  // account is at its cap. Manual sends are never blocked.
  const [capStatus, setCapStatus] = useState<{
    sentBySender: Record<string, number>;
    capBySender: Record<string, number>;
    blocked: Set<string>;
  } | null>(null);
  useEffect(() => {
    let alive = true;
    void fetch("/api/queue")
      .then((r) => r.json())
      .then(
        (d: {
          status?: {
            sentBySender?: Record<string, number>;
            capBySender?: Record<string, number>;
            blockedSenders?: { sender: string }[];
          };
        }) => {
          if (!alive) return;
          setCapStatus({
            sentBySender: d.status?.sentBySender ?? {},
            capBySender: d.status?.capBySender ?? {},
            blocked: new Set(
              (d.status?.blockedSenders ?? []).map((b) => b.sender),
            ),
          });
        },
      )
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  const capInfoFor = (email: string) => {
    if (!capStatus) return null;
    const e = email.trim().toLowerCase();
    const cap = capStatus.capBySender[e] ?? 0;
    const used = capStatus.sentBySender[e] ?? 0;
    const blocked = capStatus.blocked.has(e);
    return { cap, used, blocked, atCap: cap > 0 && used >= cap };
  };
  // Auto-rotation steers away from accounts that are at cap OR Gmail-blocked.
  // A manual send is still ALLOWED from either (the user is deliberate here) —
  // it just isn't chosen for them.
  const underCapSenders = senders.filter((s) => {
    const info = capInfoFor(s.email);
    return !info?.atCap && !info?.blocked;
  });

  // Mode: "single" = one plain email (normal send); "twostep" = cold-email
  // opener + threaded follow-up. Manual compose (editable recipient, e.g. the
  // toolbar Send) defaults to a normal single email; sending to a scanned
  // contact defaults to the two-step outreach.
  const [mode, setMode] = useState<"single" | "twostep">(
    editableTo ? "single" : "twostep",
  );

  // Message 1 (opener / the message in single mode) — the main compose area.
  const [opId, setOpId] = useState(() => lsGet("mail.openerId") ?? "");
  const [opSubject, setOpSubject] = useState(() => openers[0]?.subject ?? "");
  const [opBody, setOpBody] = useState(() => openers[0]?.body ?? "");
  // Message 2 (follow-up) — "" means none (single send).
  const [fuId, setFuId] = useState(
    () => lsGet("mail.followupId") ?? followups[0]?.id ?? "",
  );
  const [fuSubject, setFuSubject] = useState(() => followups[0]?.subject ?? "");
  const [fuBody, setFuBody] = useState(() => followups[0]?.body ?? "");
  const [fuDelayMin, setFuDelayMin] = useState(30);
  const [showFollowEditor, setShowFollowEditor] = useState(false);

  // Auto-rotate opener: when on, each time the Send window opens it advances to
  // the next opener template (round-robin, remembered in localStorage), so
  // one-off sends don't keep reusing the same opener.
  const [autoRotate, setAutoRotate] = useState(
    () => lsGet("mail.autoRotateOpener") === "1",
  );
  const applyRotatedOpener = useCallback(() => {
    if (openers.length === 0) return;
    let idx = 0;
    try {
      idx = parseInt(localStorage.getItem("mail.openerRotateIndex") ?? "0", 10) || 0;
    } catch {
      idx = 0;
    }
    const op = openers[((idx % openers.length) + openers.length) % openers.length];
    setOpId(op.id);
    setOpSubject(op.subject);
    setOpBody(op.body);
    try {
      localStorage.setItem("mail.openerRotateIndex", String(idx + 1));
    } catch {
      // ignore storage failures
    }
  }, [openers]);
  const toggleAutoRotate = () => {
    setAutoRotate((v) => {
      const next = !v;
      try {
        localStorage.setItem("mail.autoRotateOpener", next ? "1" : "0");
      } catch {
        // ignore
      }
      if (next) applyRotatedOpener();
      return next;
    });
  };

  // Swap in the database copies once loaded. With auto-rotate on, pick the next
  // opener in the rotation instead of the last-used one.
  const dbSyncedRef = useRef(false);
  useEffect(() => {
    if (!templatesLoaded || dbSyncedRef.current || openers.length === 0) return;
    dbSyncedRef.current = true;
    if (autoRotate) {
      applyRotatedOpener();
    } else {
      const op = openers.find((o) => o.id === opId) ?? openers[0];
      setOpId(op.id);
      setOpSubject(op.subject);
      setOpBody(op.body);
    }
    const fu = followups.find((f) => f.id === fuId) ?? followups[0];
    if (fu) {
      setFuId(fu.id);
      setFuSubject(fu.subject);
      setFuBody(fu.body);
    }
  }, [templatesLoaded, openers, followups, opId, fuId, autoRotate, applyRotatedOpener]);

  const [showPreview, setShowPreview] = useState(false);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<
    { ok: true; message: string } | { ok: false; message: string } | null
  >(null);
  const closeTimerRef = useRef<number | null>(null);

  // In single mode the Message-1 dropdown lists ALL templates (pick any as the
  // one message); in two-step mode it lists openers only.
  const msg1Templates = mode === "single" ? templates : openers;
  const applyOpener = (id: string) => {
    const t =
      msg1Templates.find((x) => x.id === id) ??
      templates.find((x) => x.id === id);
    if (!t) return;
    setOpId(id);
    setOpSubject(t.subject);
    setOpBody(t.body);
    // Only remember it as the default opener when it actually is one.
    if (typeof window !== "undefined" && t.kind === "opener") {
      localStorage.setItem("mail.openerId", id);
    }
  };
  const applyFollowup = (id: string) => {
    if (id === "") {
      setFuId("");
      return;
    }
    const t = followups.find((x) => x.id === id);
    if (!t) return;
    setFuId(id);
    setFuSubject(t.subject);
    setFuBody(t.body);
    if (typeof window !== "undefined")
      localStorage.setItem("mail.followupId", id);
  };

  // Persist edits per template (debounced).
  useEffect(() => {
    if (!templatesLoaded || !dbSyncedRef.current || !opId) return;
    saveContentDebounced(opId, opSubject, opBody);
  }, [opId, opSubject, opBody, templatesLoaded, saveContentDebounced]);
  useEffect(() => {
    if (!templatesLoaded || !dbSyncedRef.current || !fuId) return;
    saveContentDebounced(fuId, fuSubject, fuBody);
  }, [fuId, fuSubject, fuBody, templatesLoaded, saveContentDebounced]);
  useEffect(() => {
    if (fromEmail) localStorage.setItem("mail.from", fromEmail);
  }, [fromEmail]);

  // Pick a default sender when the list arrives.
  useEffect(() => {
    const fromPrefill = prefill?.fromEmail?.trim();
    if (
      fromPrefill &&
      senders.some((s) => s.email.toLowerCase() === fromPrefill.toLowerCase())
    ) {
      setFromEmail(fromPrefill);
      return;
    }
    if (!fromEmail && senders.length > 0) setFromEmail(senders[0].email);
  }, [senders, fromEmail, prefill?.fromEmail]);

  useEffect(() => {
    setToEmail(contact.value);
  }, [contact.value]);

  // ESC closes, clicking the backdrop closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Clear any pending auto-close timer on unmount so we don't fire onClose
  // after the modal is already gone.
  useEffect(() => {
    return () => {
      if (closeTimerRef.current) {
        window.clearTimeout(closeTimerRef.current);
      }
    };
  }, []);

  const cleanUrl = trimUrlAtQuery(url.trim());
  const cleanLinkedin = trimUrlAtQuery(urlLinkedin.trim());
  const cleanGithub = trimUrlAtQuery(urlGithub.trim());
  // When auto-rotating, the preview just uses the first account for {{sender}};
  // the server fills it with whichever account actually sends.
  const pickedSender = autoRotateSender
    ? senders[0]
    : senders.find((s) => s.email === fromEmail);
  // Preview shows the chosen account's name/email. Stored & sent copies keep the
  // {{sender}} tokens so the SERVER fills them from the account that actually
  // sends — correct even when the queue rotates senders.
  // {{url}} stays an alias of the Upwork URL so older templates keep working.
  const urlPlaceholderVars = {
    url: cleanUrl || "",
    url_upwork: cleanUrl || "",
    url_linkedin: cleanLinkedin || "",
    url_github: cleanGithub || "",
  };
  const previewVars = {
    name: name.trim() || "there",
    ...urlPlaceholderVars,
    sender: pickedSender?.name || "",
    sender_email: pickedSender?.email || fromEmail || "",
  };
  const storeVars = {
    name: name.trim() || "there",
    ...urlPlaceholderVars,
    sender: "{{sender}}",
    sender_email: "{{sender_email}}",
  };
  const renderedSubject = substitute(opSubject, previewVars);
  const renderedBody = substitute(opBody, previewVars);
  const sendSubject = substitute(opSubject, storeVars);
  const sendBody = substitute(opBody, storeVars);
  // Follow-up subject is auto-derived (Re: opener), so only the body matters.
  const hasFollow = mode === "twostep" && fuId !== "" && !!fuBody.trim();
  const renderedFuSubject = substitute(fuSubject, previewVars);
  const renderedFuBody = substitute(fuBody, previewVars);
  const followUpPayload = hasFollow
    ? {
        subject: substitute(fuSubject, storeVars),
        body: substitute(fuBody, storeVars),
        delayMin: fuDelayMin,
      }
    : undefined;

  const recipientEmail = editableTo ? toEmail.trim() : contact.value;

  const canSend =
    smtpConfigured &&
    senders.length > 0 &&
    !!fromEmail &&
    isValidEmail(recipientEmail) &&
    !!renderedSubject.trim() &&
    !!renderedBody.trim() &&
    !sending;

  const send = async () => {
    if (!canSend) return;
    // Immediate send needs a concrete account; auto-rotate picks one at random
    // so consecutive manual sends spread across accounts — skipping accounts
    // at their daily cap (all-capped falls back to all, send never blocked).
    const rotatePool = underCapSenders.length > 0 ? underCapSenders : senders;
    const picked = autoRotateSender
      ? rotatePool[Math.floor(Math.random() * rotatePool.length)]
      : senders.find((s) => s.email === fromEmail);
    if (!picked) return;
    setSending(true);
    setResult(null);
    try {
      const res = await fetch("/api/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from: picked,
          to: recipientEmail,
          subject: sendSubject,
          body: sendBody,
          // Context for the Google Sheet log - the server uses these for the
          // Name, Link, Username, Country and Site columns. `link` is the
          // modal field (Upwork profile, etc.), *not* the GitHub profile URL.
          name: name.trim(),
          link: cleanUrl,
          linkLinkedin: cleanLinkedin,
          linkGithub: cleanGithub,
          username: githubUser ?? "",
          country,
          commitOffsetMin,
          phones,
          followUp: followUpPayload,
        }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        messageId?: string;
        followUpScheduled?: boolean;
        error?: string;
      };
      if (!res.ok || !data.ok) {
        throw new Error(data.error ?? `Send failed (${res.status}).`);
      }
      setResult({
        ok: true,
        message: data.followUpScheduled
          ? `Opener sent. Follow-up in ${fuDelayMin} min. Closing…`
          : `Email sent successfully. Closing in 3s…`,
      });
      onSent?.(recipientEmail, cleanUrl);
      closeTimerRef.current = window.setTimeout(() => {
        onClose();
      }, 3000);
    } catch (err) {
      setResult({
        ok: false,
        message: err instanceof Error ? err.message : "Send failed.",
      });
    } finally {
      setSending(false);
    }
  };

  // Add the full sequence (opener + optional follow-up) to the scheduled
  // queue, rendered from this modal's name + URL fields, plus the sender.
  const queueThis = async () => {
    const picked = senders.find((s) => s.email === fromEmail);
    // Auto-rotate: queue with no fixed sender ('') so the worker rotates.
    if (
      (!autoRotateSender && !picked) ||
      !isValidEmail(recipientEmail) ||
      !renderedSubject.trim()
    ) {
      return;
    }
    setSending(true);
    setResult(null);
    try {
      const res = await fetch("/api/queue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: [
            {
              toEmail: recipientEmail,
              fromEmail: autoRotateSender ? "" : picked?.email ?? "",
              name: name.trim(),
              link: cleanUrl,
              linkLinkedin: cleanLinkedin,
              linkGithub: cleanGithub,
              username: githubUser ?? "",
              country,
              commitOffsetMin,
              phones,
              subject: sendSubject,
              body: sendBody,
              followUp: followUpPayload,
            },
          ],
        }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        added?: number;
        skipped?: { reason: string }[];
      };
      if (!res.ok || !data.ok) throw new Error("Failed to add to queue.");
      const added = data.added ?? 0;
      if (added > 0) {
        setResult({ ok: true, message: "Added to queue. Closing in 2s…" });
        onQueued?.(recipientEmail);
      } else {
        const reason = data.skipped?.[0]?.reason ?? "already sent or queued";
        setResult({ ok: false, message: `Not queued — ${reason}.` });
      }
      if (added > 0) {
        closeTimerRef.current = window.setTimeout(() => onClose(), 2000);
      }
    } catch (err) {
      setResult({
        ok: false,
        message: err instanceof Error ? err.message : "Failed to add to queue.",
      });
    } finally {
      setSending(false);
    }
  };

  return (
    <div
      className="fade-in fixed inset-0 z-[70] flex items-center justify-center bg-black/75 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="glass slide-in relative flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl shadow-2xl shadow-black/50">
        {/* Header */}
        <div className="flex items-start justify-between gap-4 border-b border-white/5 px-6 py-4">
          <div className="flex min-w-0 items-center gap-3">
            <GmailAvatar
              email={recipientEmail}
              size={40}
              className="rounded-xl border border-white/10"
              fallback={
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-cyan-500/30 to-slate-700 text-sm font-semibold text-cyan-100">
                  {(contact.names[0] || recipientEmail || contact.value || "?")
                    .trim()
                    .charAt(0)
                    .toUpperCase() || "?"}
                </span>
              }
            />
            <div className="min-w-0">
              <h3 className="text-lg font-semibold text-slate-100">Send email</h3>
              {editableTo ? (
                <p className="mt-1 text-xs text-slate-400">
                  Enter the recipient&apos;s email address below.
                </p>
              ) : (
                <p className="mt-1 truncate text-xs text-slate-400">
                  To:{" "}
                  <span className="font-mono text-cyan-300">{contact.value}</span>
                  {contact.names.length > 0 && (
                    <span className="ml-2 text-slate-500">
                      ({contact.names.join(", ")})
                    </span>
                  )}
                </p>
              )}
            </div>
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

        {/* Body */}
        <div className="flex-1 space-y-3 overflow-auto p-4">
          {!smtpConfigured && (
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-xs text-amber-200">
              SMTP isn&apos;t configured. Add <code>SMTP_HOST</code>,{" "}
              <code>SMTP_USER</code>, <code>SMTP_PASS</code> to{" "}
              <code>.env.local</code> and restart the dev server.
            </div>
          )}
          {smtpConfigured && senders.length === 0 && (
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-xs text-amber-200">
              No sender identities configured. Set <code>SMTP_USER</code> or{" "}
              <code>MAIL_IDENTITIES</code> in <code>.env.local</code>.
            </div>
          )}

          {editableTo && (
            <div>
              <label className="mb-1 block text-[11px] font-medium uppercase tracking-[0.22em] text-slate-400">
                To
              </label>
              <input
                type="email"
                value={toEmail}
                onChange={(e) => setToEmail(e.target.value)}
                placeholder="recipient@example.com"
                autoFocus
                className="w-full rounded-full border border-white/10 bg-slate-950/70 px-4 py-2.5 text-sm text-slate-100 outline-none transition focus:border-cyan-400 focus:ring-2 focus:ring-cyan-400/30"
              />
            </div>
          )}

          <div>
            <div className="mb-1 flex items-center justify-between gap-2">
              <label className="block text-[11px] font-medium uppercase tracking-[0.22em] text-slate-400">
                From
              </label>
              {senders.length > 1 && (
                <label className="flex cursor-pointer items-center gap-1.5 text-[11px] font-medium text-slate-400 hover:text-slate-200">
                  <input
                    type="checkbox"
                    checked={autoRotateSender}
                    onChange={(e) => {
                      setAutoRotateSender(e.target.checked);
                      if (typeof window !== "undefined")
                        localStorage.setItem("mail.autoRotateSender", e.target.checked ? "1" : "0");
                    }}
                    className="h-3.5 w-3.5 accent-cyan-500"
                  />
                  Auto-rotate sender
                </label>
              )}
            </div>
            {autoRotateSender ? (
              <div className="w-full rounded-full border border-cyan-400/30 bg-cyan-500/5 px-4 py-2.5 text-sm text-cyan-200">
                Auto-rotating across{" "}
                {underCapSenders.length || senders.length} account
                {(underCapSenders.length || senders.length) === 1 ? "" : "s"} —
                one is chosen per send.
              </div>
            ) : (
              <select
                value={fromEmail}
                onChange={(e) => setFromEmail(e.target.value)}
                className="w-full rounded-full border border-white/10 bg-slate-950/70 px-4 py-2.5 text-sm text-slate-100 outline-none transition focus:border-cyan-400 focus:ring-2 focus:ring-cyan-400/30"
              >
                {senders.map((s) => (
                  <option key={s.email} value={s.email}>
                    {s.name} &lt;{s.email}&gt;
                  </option>
                ))}
              </select>
            )}
            {(() => {
              // Amber cap warning: informs, never blocks. Auto-rotate already
              // steers to under-cap accounts, so warn only when ALL are capped
              // (rotate mode) or when the picked account itself is capped.
              if (autoRotateSender) {
                if (senders.length === 0 || underCapSenders.length > 0)
                  return null;
                return (
                  <p className="mt-1.5 rounded-lg border border-amber-400/30 bg-amber-500/10 px-3 py-1.5 text-[11px] text-amber-200">
                    ⚠ Every account is at its daily cap or blocked by Gmail —
                    sending anyway exceeds warm-up limits.
                  </p>
                );
              }
              const info = capInfoFor(fromEmail);
              if (info?.blocked) {
                return (
                  <p className="mt-1.5 rounded-lg border border-amber-400/30 bg-amber-500/10 px-3 py-1.5 text-[11px] text-amber-200">
                    ⚠ Gmail blocked {fromEmail} today — the queue has stopped
                    using it. Sending now will likely bounce.
                  </p>
                );
              }
              if (!info?.atCap) return null;
              return (
                <p className="mt-1.5 rounded-lg border border-amber-400/30 bg-amber-500/10 px-3 py-1.5 text-[11px] text-amber-200">
                  ⚠ {fromEmail} reached its daily cap ({info.used}/{info.cap})
                  — sending anyway exceeds its warm-up limit.
                </p>
              );
            })()}
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-[11px] font-medium uppercase tracking-[0.22em] text-slate-400">
                Name
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Recipient name (e.g. Yassine)"
                className="w-full rounded-full border border-white/10 bg-slate-950/70 px-4 py-2.5 text-sm text-slate-100 outline-none transition focus:border-cyan-400 focus:ring-2 focus:ring-cyan-400/30"
              />
            </div>
            <div>
              <label className="mb-1 block text-[11px] font-medium uppercase tracking-[0.22em] text-slate-400">
                Upwork URL
              </label>
              <input
                type="text"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://www.upwork.com/freelancers/~0123…"
                className="w-full rounded-full border border-white/10 bg-slate-950/70 px-4 py-2.5 text-sm text-slate-100 outline-none transition focus:border-cyan-400 focus:ring-2 focus:ring-cyan-400/30"
              />
              {url.trim() && cleanUrl !== url.trim() && (
                <p className="mt-1 text-[11px] text-slate-500">
                  Will send as:{" "}
                  <span className="break-all font-mono text-cyan-300">
                    {cleanUrl}
                  </span>
                </p>
              )}
            </div>
            <div>
              <label className="mb-1 block text-[11px] font-medium uppercase tracking-[0.22em] text-slate-400">
                LinkedIn URL
              </label>
              <input
                type="text"
                value={urlLinkedin}
                onChange={(e) => setUrlLinkedin(e.target.value)}
                placeholder="https://www.linkedin.com/in/…"
                className="w-full rounded-full border border-white/10 bg-slate-950/70 px-4 py-2.5 text-sm text-slate-100 outline-none transition focus:border-cyan-400 focus:ring-2 focus:ring-cyan-400/30"
              />
            </div>
            <div>
              <label className="mb-1 block text-[11px] font-medium uppercase tracking-[0.22em] text-slate-400">
                GitHub URL
              </label>
              <input
                type="text"
                value={urlGithub}
                onChange={(e) => setUrlGithub(e.target.value)}
                placeholder="https://github.com/…"
                className="w-full rounded-full border border-white/10 bg-slate-950/70 px-4 py-2.5 text-sm text-slate-100 outline-none transition focus:border-cyan-400 focus:ring-2 focus:ring-cyan-400/30"
              />
            </div>
          </div>

          {/* Mode: normal single email vs cold two-step */}
          <div className="flex items-center gap-1 rounded-full border border-white/10 bg-slate-950/60 p-1 text-xs">
            <button
              type="button"
              onClick={() => setMode("single")}
              className={
                "flex-1 rounded-full px-3 py-1.5 font-medium transition " +
                (mode === "single"
                  ? "bg-cyan-500/20 text-cyan-100"
                  : "text-slate-400 hover:text-white")
              }
            >
              Single message
            </button>
            <button
              type="button"
              onClick={() => setMode("twostep")}
              className={
                "flex-1 rounded-full px-3 py-1.5 font-medium transition " +
                (mode === "twostep"
                  ? "bg-indigo-500/25 text-indigo-100"
                  : "text-slate-400 hover:text-white")
              }
            >
              2-step (opener + follow-up)
            </button>
          </div>

          {/* Message 1 — the message (single) or the opener (two-step) */}
          <div className="rounded-xl border border-cyan-400/20 bg-cyan-500/[0.03] p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-cyan-300/80">
                {mode === "single" ? "Message" : "Message 1 · Opener (sent now)"}
              </p>
              <label
                className="flex shrink-0 items-center gap-1.5 text-[10px] text-slate-400"
                title="Automatically pick the next opener each time you open this window, so you don't reuse one template too often"
              >
                <input
                  type="checkbox"
                  checked={autoRotate}
                  onChange={toggleAutoRotate}
                  className="accent-cyan-500"
                />
                Auto-rotate opener
              </label>
            </div>
            <select
              value={opId}
              onChange={(e) => applyOpener(e.target.value)}
              disabled={autoRotate}
              className="mb-2 w-full rounded-full border border-white/10 bg-slate-950/70 px-4 py-2 text-sm text-slate-100 outline-none transition focus:border-cyan-400 focus:ring-2 focus:ring-cyan-400/30 disabled:opacity-60"
            >
              {msg1Templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                  {mode === "single"
                    ? t.kind === "opener"
                      ? " (opener)"
                      : " (pitch)"
                    : ""}
                </option>
              ))}
            </select>
            {autoRotate && (
              <p className="mb-2 text-[10px] text-cyan-300/70">
                Auto-rotating across {openers.length} openers — this one was
                picked automatically; edit below if you like.
              </p>
            )}
            <input
              type="text"
              value={opSubject}
              onChange={(e) => setOpSubject(e.target.value)}
              placeholder="Subject"
              className="mb-2 w-full rounded-lg border border-white/10 bg-slate-950/70 px-4 py-2 text-sm text-slate-100 outline-none transition focus:border-cyan-400 focus:ring-2 focus:ring-cyan-400/30"
            />
            <textarea
              value={opBody}
              onChange={(e) => setOpBody(e.target.value)}
              rows={5}
              className="w-full resize-y rounded-lg border border-white/10 bg-slate-950/70 px-4 py-3 font-mono text-[13px] leading-relaxed text-slate-100 outline-none transition focus:border-cyan-400 focus:ring-2 focus:ring-cyan-400/30"
            />
          </div>

          {/* Message 2 — Follow-up (two-step only) */}
          {mode === "twostep" && (
          <div className="rounded-xl border border-indigo-400/20 bg-indigo-500/[0.03] p-3">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-indigo-300/80">
                Message 2 · Follow-up
              </p>
              <span className="text-[11px] text-slate-500">
                sent as a reply after
              </span>
              <select
                value={fuDelayMin}
                onChange={(e) => setFuDelayMin(Number(e.target.value))}
                disabled={fuId === ""}
                className="rounded-md border border-white/10 bg-slate-950 px-2 py-0.5 text-xs text-slate-200 outline-none focus:border-indigo-400/40 disabled:opacity-40"
              >
                <option value={15}>15 min</option>
                <option value={30}>30 min</option>
                <option value={60}>60 min</option>
                <option value={120}>2 hours</option>
                <option value={1440}>Next day</option>
              </select>
            </div>
            <select
              value={fuId}
              onChange={(e) => applyFollowup(e.target.value)}
              className="w-full rounded-full border border-white/10 bg-slate-950/70 px-4 py-2 text-sm text-slate-100 outline-none transition focus:border-indigo-400 focus:ring-2 focus:ring-indigo-400/30"
            >
              <option value="">None — send opener only</option>
              {followups.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
            {fuId !== "" && (
              <>
                <button
                  type="button"
                  onClick={() => setShowFollowEditor((v) => !v)}
                  className="mt-2 text-[11px] text-indigo-300 transition hover:text-indigo-100"
                >
                  {showFollowEditor ? "Hide follow-up text" : "Edit follow-up text"}
                </button>
                {showFollowEditor && (
                  <div className="mt-2">
                    <p className="mb-1.5 text-[11px] text-slate-500">
                      Sent as a reply in the opener&apos;s thread — subject is
                      automatically{" "}
                      <span className="font-mono text-indigo-300">Re: {opSubject}</span>
                    </p>
                    <textarea
                      value={fuBody}
                      onChange={(e) => setFuBody(e.target.value)}
                      rows={8}
                      className="w-full resize-y rounded-lg border border-white/10 bg-slate-950/70 px-4 py-3 font-mono text-[13px] leading-relaxed text-slate-100 outline-none transition focus:border-indigo-400"
                    />
                  </div>
                )}
              </>
            )}
            <p className="mt-2 text-[11px] text-slate-500">
              Placeholders:{" "}
              <code className="text-cyan-300">{"{{name}}"}</code>{" "}
              <code className="text-cyan-300">{"{{url_upwork}}"}</code>{" "}
              <code className="text-cyan-300">{"{{url_linkedin}}"}</code>{" "}
              <code className="text-cyan-300">{"{{url_github}}"}</code>{" "}
              <code className="text-cyan-300">{"{{sender}}"}</code>{" "}
              <code className="text-cyan-300">{"{{sender_email}}"}</code>{" "}
              — <code className="text-cyan-300">{"{{url}}"}</code> ={" "}
              <code className="text-cyan-300">{"{{url_upwork}}"}</code>
            </p>
          </div>
          )}

          <button
            type="button"
            onClick={() => setShowPreview((v) => !v)}
            className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-slate-300 transition hover:border-cyan-400/40 hover:text-cyan-300"
          >
            <EyeIcon className="h-3.5 w-3.5" />
            {showPreview ? "Hide preview" : "Show preview"}
          </button>

          {showPreview && (
            <div className="fade-in rounded-lg border border-white/5 bg-slate-950/40 p-4">
              <p className="mb-2 text-xs text-slate-400">
                <span className="uppercase tracking-[0.22em] text-slate-500">
                  Subject
                </span>
                <br />
                <span className="text-slate-100">{renderedSubject}</span>
              </p>
              <hr className="my-2 border-white/5" />
              <pre className="whitespace-pre-wrap font-mono text-[13px] leading-relaxed text-slate-100">
                {renderedBody}
              </pre>
            </div>
          )}

          {result && (
            <div
              className={
                "fade-in rounded-lg border px-4 py-3 text-xs " +
                (result.ok
                  ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200"
                  : "border-rose-500/40 bg-rose-500/10 text-rose-200")
              }
            >
              {result.message}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-white/5 bg-slate-950/40 px-4 py-4 sm:px-6">
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-white/10 px-4 py-2 text-sm text-slate-300 transition hover:bg-white/5"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void queueThis()}
            disabled={!canSend}
            data-ripple
            className="btn-press inline-flex items-center gap-2 rounded-full border border-indigo-400/40 bg-indigo-500/15 px-4 py-2 text-sm font-semibold text-indigo-200 transition hover:border-indigo-300 hover:bg-indigo-400/25 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
            title="Add to the scheduled send queue with these details"
          >
            ＋ Add to queue
          </button>
          <button
            type="button"
            onClick={send}
            disabled={!canSend}
            data-ripple
            className="btn-press inline-flex items-center gap-2 rounded-full bg-cyan-500 px-5 py-2 text-sm font-semibold text-slate-950 shadow-lg shadow-cyan-500/30 transition hover:bg-cyan-400 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {sending ? (
              <>
                <SpinnerIcon className="h-4 w-4 animate-spin" />
                Sending…
              </>
            ) : (
              <>
                <SendIcon className="h-4 w-4" />
                Send
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

