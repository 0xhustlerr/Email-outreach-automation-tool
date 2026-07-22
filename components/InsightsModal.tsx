"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { SheetHistoryRow } from "@/lib/sheets";
import type { ReplyNotification } from "@/lib/reply-alerts";
import { CountryFlag } from "@/components/CountryFlag";

// Outreach dashboard for a selectable time range: totals, reply status, the
// list of who replied (with good/neutral/bad sentiment), and breakdowns.
// Reads the same sheet history the History table uses, enriched with the
// reply snippets captured by the reply sync so replies can be graded.
//
// Reply rate is measured by DISTINCT CONTACT, not by email: a two-step
// sequence sends two emails (opener + follow-up) to the same person, so
// counting emails would halve the true reply rate.

const MAX_BARS = 14;

// Hex palette for SVG/inline-styled charts (tailwind classes can't be used in
// SVG strokes). Kept in the app's cyan-forward family.
const SEGMENT_COLORS = [
  "#22d3ee",
  "#a78bfa",
  "#34d399",
  "#fbbf24",
  "#fb7185",
  "#38bdf8",
  "#f472b6",
  "#2dd4bf",
];
const POSITIVE_COLOR = "#34d399";
const NEUTRAL_COLOR = "#38bdf8";
const NEGATIVE_COLOR = "#fb7185";
const NOREPLY_COLOR = "rgba(148,163,184,0.28)";

function isYes(value: string | undefined): boolean {
  const v = (value ?? "").trim().toLowerCase();
  return v === "yes" || v === "y" || v === "true" || v === "1";
}

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function endOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
}

function parseRowDateMs(iso: string): number | null {
  if (!iso || !iso.trim()) return null;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : t;
}

function senderLocalPart(email: string): string {
  const at = email.indexOf("@");
  return at > 0 ? email.slice(0, at) : email;
}

// One entry per address, even when a contact string packs several.
function primaryEmail(contact: string): string {
  const part = contact.split(/[/,;]/)[0]?.trim() ?? "";
  const m = part.match(/[^\s@]+@[^\s@]+\.[^\s@]+/i);
  return m ? m[0].toLowerCase() : part.toLowerCase();
}

function fmtDay(d: Date): string {
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

function fmtWhen(ms: number | null): string {
  if (ms === null) return "—";
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// --- Reply sentiment ---------------------------------------------------
// Grades a reply from its subject + snippet. Automatic out-of-office and
// "no longer here" bounces are treated as neutral so they don't inflate
// either side. Negative is checked before positive so "no thanks, but this
// looks great" is scored as a decline.

export type Sentiment = "positive" | "neutral" | "negative";

const AUTO_RE =
  /(out of office|automatic reply|auto-?reply|away from|on vacation|annual leave|maternity leave|currently away|will be back|no longer (with|at)|has left)/;
const NEGATIVE_RE =
  /(not interested|no,? thank|no thanks|unsubscribe|opt[- ]?out|remove me|take me off|stop (emailing|contacting|sending)|do ?n'?t (contact|email)|please stop|not a (good )?fit|already (have|working|using)|not looking|leave me alone|\bspam\b|reported|\bcease\b)/;
const POSITIVE_RE =
  /(interested|would love|i'?d love|sounds (good|great|interesting)|happy to|glad to|let'?s (chat|talk|connect|schedule|set up|hop)|schedule a|book a call|set up a call|hop on|\bavailable\b|absolutely|definitely|count me in|works for me|looking forward|tell me more|more (info|details)|send (me|over|us)|\bpricing\b|how much|\bquote\b|get started|sign me up|\byes\b|\bsure\b|\bgreat\b|\bperfect\b)/;

export function classifyReply(subject: string, snippet: string): Sentiment {
  const t = `${subject} ${snippet}`.toLowerCase();
  if (AUTO_RE.test(t)) return "neutral";
  if (NEGATIVE_RE.test(t)) return "negative";
  if (POSITIVE_RE.test(t)) return "positive";
  return "neutral";
}

// --- Types -------------------------------------------------------------

export type Replier = {
  email: string;
  name: string;
  site: string;
  country: string;
  sender: string;
  whenMs: number | null;
  sends: number;
  sentiment: Sentiment;
  snippet: string;
  subject: string;
};

type Insights = {
  rangeLabel: string;
  sent: number; // emails (rows) in range
  uniqueContacts: number; // distinct addresses
  replied: number; // distinct contacts who replied
  pending: number; // uniqueContacts - replied
  opened: number; // distinct contacts who opened (tracked)
  openedEmails: number; // emails (rows) opened at least once (by-email view)
  replyRate: number; // replied / uniqueContacts  ← by contact, not by email
  positive: number;
  neutral: number;
  negative: number;
  repliers: Replier[];
  perDay: {
    label: string;
    count: number;
    contacts: number;
    opened: number;
    replied: number;
  }[];
  bySender: { label: string; value: number; color: string }[];
  bySite: { label: string; value: number; color: string }[];
  byCountry: { label: string; value: number; color: string }[];
  senderStats: SenderStat[];
};

export type SenderStat = {
  email: string;
  label: string;
  sent: number; // emails
  contacts: number; // distinct people
  opened: number; // distinct people who opened
  replied: number; // distinct people who replied
  replyRate: number; // replied / contacts
};

type Contact = {
  email: string;
  name: string;
  site: string;
  country: string;
  sender: string;
  sends: number;
  latestSendMs: number | null;
  replied: boolean;
  repliedAtMs: number | null;
  snippet: string;
  subject: string;
  opened: boolean;
};

export function computeInsights(
  rows: SheetHistoryRow[],
  opts: { fromMs?: number; toMs?: number; replies?: ReplyNotification[] } = {},
): Insights {
  const fromMs = opts.fromMs ?? -Infinity;
  const toMs = opts.toMs ?? Infinity;
  const replies = opts.replies ?? [];

  // Index reply snippets so a contact can be graded. Key by sheet row and by
  // address; the sheet-row match is exact, the address match is the fallback.
  const notifByRow = new Map<number, ReplyNotification>();
  const notifByEmail = new Map<string, ReplyNotification>();
  for (const n of replies) {
    if (typeof n._row === "number") notifByRow.set(n._row, n);
    const e = primaryEmail(n.contact ?? "");
    if (e.includes("@") && !notifByEmail.has(e)) notifByEmail.set(e, n);
  }

  const inRange = rows.filter((r) => {
    const ms = parseRowDateMs(r.date);
    return ms !== null && ms >= fromMs && ms <= toMs;
  });

  // Collapse to one record per address (a contact may have 2+ rows).
  const contacts = new Map<string, Contact>();
  for (const r of inRange) {
    const email = primaryEmail(r.contact ?? "");
    if (!email) continue;
    const ms = parseRowDateMs(r.date);
    let c = contacts.get(email);
    if (!c) {
      c = {
        email,
        name: (r.name ?? "").trim(),
        site: (r.site ?? "").trim(),
        country: (r.country ?? "").trim(),
        sender: (r.sender ?? "").trim(),
        sends: 0,
        latestSendMs: null,
        replied: false,
        repliedAtMs: null,
        snippet: "",
        subject: "",
        opened: false,
      };
      contacts.set(email, c);
    }
    c.sends += 1;
    if ((r.openedAt ?? "").trim()) c.opened = true;
    if (ms !== null && (c.latestSendMs === null || ms > c.latestSendMs)) {
      c.latestSendMs = ms;
      // Prefer the freshest non-empty descriptors.
      if ((r.name ?? "").trim()) c.name = (r.name ?? "").trim();
      if ((r.site ?? "").trim()) c.site = (r.site ?? "").trim();
      if ((r.country ?? "").trim()) c.country = (r.country ?? "").trim();
      if ((r.sender ?? "").trim()) c.sender = (r.sender ?? "").trim();
    }
    if (isYes(r.active) || isYes(r.replied)) {
      c.replied = true;
      const at = parseRowDateMs(r.repliedAt ?? "");
      if (at !== null && (c.repliedAtMs === null || at > c.repliedAtMs)) {
        c.repliedAtMs = at;
      }
      // Attach a snippet for grading, matching by sheet row first.
      const n =
        (typeof r._row === "number" ? notifByRow.get(r._row) : undefined) ??
        notifByEmail.get(email);
      if (n && !c.snippet) {
        c.snippet = (n.snippet ?? "").trim();
        c.subject = (n.subject ?? "").trim();
      }
    }
  }

  const all = [...contacts.values()];
  const uniqueContacts = all.length;
  const repliedContacts = all.filter((c) => c.replied);

  const repliers: Replier[] = repliedContacts
    .map((c) => ({
      email: c.email,
      name: c.name,
      site: c.site,
      country: c.country,
      sender: c.sender,
      whenMs: c.repliedAtMs ?? c.latestSendMs,
      sends: c.sends,
      sentiment: classifyReply(c.subject, c.snippet),
      snippet: c.snippet,
      subject: c.subject,
    }))
    .sort((a, b) => (b.whenMs ?? 0) - (a.whenMs ?? 0));

  const positive = repliers.filter((r) => r.sentiment === "positive").length;
  const negative = repliers.filter((r) => r.sentiment === "negative").length;
  const neutral = repliers.length - positive - negative;

  // Activity chart spans the actual send window inside the range so it stays
  // legible for very wide presets (e.g. "All time").
  const rowMs = inRange
    .map((r) => parseRowDateMs(r.date))
    .filter((n): n is number => n !== null);
  const now = new Date();
  const spanStart = rowMs.length ? Math.min(...rowMs) : startOfDay(now).getTime();
  const spanEnd = rowMs.length ? Math.max(...rowMs) : now.getTime();
  const start = startOfDay(new Date(spanStart));
  const startMs = start.getTime();
  const totalDays = Math.max(
    1,
    Math.round((endOfDay(new Date(spanEnd)).getTime() - startMs) / 86_400_000),
  );
  const bucketCount = Math.min(totalDays, MAX_BARS);
  const bucketDays = Math.ceil(totalDays / bucketCount);
  const buckets = Array.from({ length: bucketCount }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i * bucketDays);
    return {
      label: d.toLocaleDateString(undefined, { day: "numeric", month: "short" }),
      count: 0, // emails
      contacts: 0, // distinct people mailed
      opened: 0, // distinct people who opened (tracked)
      replied: 0, // distinct people who answered
    };
  });
  const bucketFor = (ms: number) => {
    const off = Math.max(0, Math.floor((startOfDay(new Date(ms)).getTime() - startMs) / 86_400_000));
    return Math.min(bucketCount - 1, Math.floor(off / bucketDays));
  };
  const bucketContacts = Array.from({ length: bucketCount }, () => new Set<string>());
  const bucketOpened = Array.from({ length: bucketCount }, () => new Set<string>());
  for (const r of inRange) {
    const ms = parseRowDateMs(r.date);
    if (ms === null) continue;
    const bi = bucketFor(ms);
    buckets[bi].count++;
    const email = primaryEmail(r.contact ?? "");
    if (email) {
      bucketContacts[bi].add(email);
      if ((r.openedAt ?? "").trim()) bucketOpened[bi].add(email);
    }
  }
  for (let i = 0; i < bucketCount; i++) {
    buckets[i].contacts = bucketContacts[i].size;
    buckets[i].opened = bucketOpened[i].size;
  }
  for (const r of repliers) {
    if (r.whenMs !== null) buckets[bucketFor(r.whenMs)].replied++;
  }

  // Contact-level breakdowns (distinct people, not emails).
  const senderCount = new Map<string, number>();
  const siteCount = new Map<string, number>();
  const countryCount = new Map<string, number>();
  for (const c of all) {
    const s = c.sender.toLowerCase();
    if (s) senderCount.set(s, (senderCount.get(s) ?? 0) + 1);
    const site = c.site || "Unknown";
    siteCount.set(site, (siteCount.get(site) ?? 0) + 1);
    if (c.country) countryCount.set(c.country, (countryCount.get(c.country) ?? 0) + 1);
  }

  const toRanked = (
    m: Map<string, number>,
    transform: (k: string) => string,
    limit: number,
  ) =>
    [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([k, v], i) => ({
        label: transform(k),
        value: v,
        color: SEGMENT_COLORS[i % SEGMENT_COLORS.length],
      }));

  // Per-sender performance (drives the sender tabs + "highest reply rate").
  const senderMap = new Map<
    string,
    { sent: number; contacts: number; opened: number; replied: number }
  >();
  for (const c of all) {
    const s = (c.sender ?? "").trim().toLowerCase();
    if (!s) continue;
    let a = senderMap.get(s);
    if (!a) {
      a = { sent: 0, contacts: 0, opened: 0, replied: 0 };
      senderMap.set(s, a);
    }
    a.sent += c.sends;
    a.contacts += 1;
    if (c.opened) a.opened += 1;
    if (c.replied) a.replied += 1;
  }
  const senderStats: SenderStat[] = [...senderMap.entries()]
    .map(([email, a]) => ({
      email,
      label: senderLocalPart(email),
      sent: a.sent,
      contacts: a.contacts,
      opened: a.opened,
      replied: a.replied,
      replyRate: a.contacts > 0 ? a.replied / a.contacts : 0,
    }))
    .sort((x, y) => y.contacts - x.contacts || y.sent - x.sent);

  return {
    rangeLabel: `${fmtDay(new Date(spanStart))} – ${fmtDay(new Date(spanEnd))}`,
    sent: inRange.length,
    uniqueContacts,
    replied: repliedContacts.length,
    pending: uniqueContacts - repliedContacts.length,
    opened: all.filter((c) => c.opened).length,
    openedEmails: inRange.filter((r) => (r.openedAt ?? "").trim()).length,
    replyRate: uniqueContacts > 0 ? repliedContacts.length / uniqueContacts : 0,
    positive,
    neutral,
    negative,
    repliers,
    perDay: buckets,
    bySender: toRanked(senderCount, senderLocalPart, 6),
    bySite: toRanked(siteCount, (k) => k, 6),
    byCountry: toRanked(countryCount, (k) => k, 6),
    senderStats,
  };
}

// --- Date range ------------------------------------------------------

type PresetId =
  | "today"
  | "yesterday"
  | "last7"
  | "last14"
  | "last30"
  | "last90"
  | "all"
  | "custom";

type RangeState = { preset: PresetId; from: Date; to: Date };

const RANGE_PRESETS: { id: Exclude<PresetId, "custom">; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "yesterday", label: "Yesterday" },
  { id: "last7", label: "Last 7 days" },
  { id: "last14", label: "Last 14 days" },
  { id: "last30", label: "Last 30 days" },
  { id: "last90", label: "Last 90 days" },
  { id: "all", label: "All time" },
];

function presetRange(id: Exclude<PresetId, "custom">): { from: Date; to: Date } {
  const now = new Date();
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  switch (id) {
    case "today":
      return { from: startOfDay(now), to: endOfDay(now) };
    case "yesterday":
      return { from: startOfDay(y), to: endOfDay(y) };
    case "all":
      return { from: new Date(0), to: endOfDay(now) };
    default: {
      const days =
        id === "last7" ? 7 : id === "last14" ? 14 : id === "last30" ? 30 : 90;
      const from = startOfDay(now);
      from.setDate(from.getDate() - (days - 1));
      return { from, to: endOfDay(now) };
    }
  }
}

function toDateInput(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function fromDateInput(v: string): Date | null {
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function rangeButtonLabel(r: RangeState): string {
  const preset = RANGE_PRESETS.find((p) => p.id === r.preset);
  if (r.preset === "today") return "Today";
  if (r.preset === "all") return "All time";
  const dates = `${fmtDay(r.from)} – ${fmtDay(r.to)}`;
  return preset ? `${preset.label} · ${dates}` : `${dates}`;
}

function RangePicker({
  value,
  onChange,
}: {
  value: RangeState;
  onChange: (r: RangeState) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const pick = (id: Exclude<PresetId, "custom">) => {
    const r = presetRange(id);
    onChange({ preset: id, from: r.from, to: r.to });
  };

  const setFrom = (v: string) => {
    const d = fromDateInput(v);
    if (d) onChange({ preset: "custom", from: startOfDay(d), to: value.to });
  };
  const setTo = (v: string) => {
    const d = fromDateInput(v);
    if (d) onChange({ preset: "custom", from: value.from, to: endOfDay(d) });
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex max-w-[240px] items-center gap-2 rounded-full border border-white/10 bg-slate-950/70 py-1.5 pl-3 pr-2.5 text-xs font-medium text-slate-200 transition hover:border-cyan-400/40"
        title="Select time range"
      >
        <CalendarIcon className="h-3.5 w-3.5 shrink-0 text-cyan-300" />
        <span className="truncate">{rangeButtonLabel(value)}</span>
        <ChevronIcon
          className={"h-3.5 w-3.5 shrink-0 text-slate-400 transition " + (open ? "rotate-180" : "")}
        />
      </button>

      {open && (
        <div className="absolute right-0 top-full z-30 mt-2 w-[260px] overflow-hidden rounded-xl border border-white/10 bg-slate-950 p-3 shadow-2xl shadow-black/60">
          <div className="flex flex-wrap gap-1.5">
            {RANGE_PRESETS.map((p) => {
              const active = value.preset === p.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => pick(p.id)}
                  className={
                    "rounded-full px-2.5 py-1 text-[11px] font-medium transition " +
                    (active
                      ? "bg-cyan-500/20 text-cyan-200 ring-1 ring-cyan-400/40"
                      : "bg-white/5 text-slate-300 hover:bg-white/10")
                  }
                >
                  {p.label}
                </button>
              );
            })}
          </div>
          <div className="mt-3 border-t border-white/5 pt-3">
            <div className="mb-1.5 text-[10px] font-medium uppercase tracking-[0.18em] text-slate-500">
              Custom range
            </div>
            <div className="flex items-center gap-2">
              <input
                type="date"
                value={toDateInput(value.from)}
                max={toDateInput(value.to)}
                onChange={(e) => setFrom(e.target.value)}
                className="min-w-0 flex-1 rounded-lg border border-white/10 bg-slate-900/70 px-2 py-1 text-xs text-slate-200 outline-none [color-scheme:dark] focus:border-cyan-400/50"
              />
              <span className="text-xs text-slate-500">→</span>
              <input
                type="date"
                value={toDateInput(value.to)}
                min={toDateInput(value.from)}
                onChange={(e) => setTo(e.target.value)}
                className="min-w-0 flex-1 rounded-lg border border-white/10 bg-slate-900/70 px-2 py-1 text-xs text-slate-200 outline-none [color-scheme:dark] focus:border-cyan-400/50"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// --- Dashboard ---------------------------------------------------------

export function InsightsDashboard({
  rows,
  replies = [],
  loading = false,
  onRefresh,
  onClose,
  className = "",
}: {
  rows: SheetHistoryRow[];
  replies?: ReplyNotification[];
  loading?: boolean;
  onRefresh?: () => void;
  onClose?: () => void;
  className?: string;
}) {
  const [range, setRange] = useState<RangeState>(() => {
    const r = presetRange("today");
    return { preset: "today", from: r.from, to: r.to };
  });

  const data = useMemo(
    () =>
      computeInsights(rows, {
        fromMs: range.from.getTime(),
        toMs: range.to.getTime(),
        replies,
      }),
    [rows, range.from, range.to, replies],
  );
  const replyPct = Math.round(data.replyRate * 100);
  const viewedPct = data.sent > 0 ? Math.round((data.openedEmails / data.sent) * 100) : 0;

  // Per-sender view for the performance panel. "all" = every account.
  const [sender, setSender] = useState<string>("all");
  useEffect(() => {
    if (sender !== "all" && !data.senderStats.some((s) => s.email === sender)) {
      setSender("all"); // chosen account left the dataset (e.g. range change)
    }
  }, [data.senderStats, sender]);
  const view = useMemo(() => {
    if (sender === "all") return data;
    const filtered = rows.filter(
      (r) => (r.sender ?? "").trim().toLowerCase() === sender,
    );
    return computeInsights(filtered, {
      fromMs: range.from.getTime(),
      toMs: range.to.getTime(),
      replies,
    });
  }, [sender, data, rows, range.from, range.to, replies]);

  return (
    <div className={className}>
      {/* Header */}
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 text-lg font-semibold text-slate-100">
            <ChartIcon className="h-5 w-5 text-cyan-300" />
            Insights
          </h3>
          <p className="mt-1 truncate text-xs text-slate-400">
            {data.sent > 0 ? (
              <>
                <span className="font-medium text-cyan-300">{data.rangeLabel}</span>
                <span className="text-slate-600"> · </span>
                {data.uniqueContacts} contact{data.uniqueContacts === 1 ? "" : "s"} ·{" "}
                {data.sent} email{data.sent === 1 ? "" : "s"}
              </>
            ) : (
              <span className="text-slate-500">No activity in range</span>
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <RangePicker value={range} onChange={setRange} />
          {onRefresh && (
            <button
              type="button"
              onClick={onRefresh}
              disabled={loading}
              className="rounded-full border border-white/10 p-2 text-slate-300 transition hover:border-cyan-400/40 hover:text-cyan-300 disabled:opacity-40"
              title="Refresh from sheet"
            >
              <RefreshIcon className={"h-4 w-4 " + (loading ? "animate-spin" : "")} />
            </button>
          )}
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="rounded-full p-2 text-slate-400 transition hover:bg-white/5 hover:text-slate-100"
              aria-label="Close"
            >
              <CloseIcon className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      {data.sent === 0 ? (
        <p className="py-16 text-center text-sm text-slate-500">
          {loading ? "Loading insights…" : "No emails sent in the selected range."}
        </p>
      ) : (
        <div className="space-y-2.5">
          {/* Stat cards */}
          <div className="grid grid-cols-2 gap-2 xl:grid-cols-3">
            <StatCard label="Contacts" value={data.uniqueContacts} accent="#38bdf8" />
            <StatCard label="Emails sent" value={data.sent} accent="#e8edf5" />
            <StatCard
              label="Replied"
              value={data.replied}
              sub={`of ${data.uniqueContacts} contacts`}
              accent={POSITIVE_COLOR}
            />
            <StatCard
              label="Reply rate"
              value={`${replyPct}%`}
              sub="by contact"
              accent="#22d3ee"
            />
            <StatCard
              label="Viewed"
              value={data.openedEmails}
              sub={`of ${data.sent} emails`}
              accent="#a78bfa"
            />
            <StatCard
              label="Viewed rate"
              value={`${viewedPct}%`}
              sub="by email"
              accent="#c4b5fd"
            />
          </div>

          {/* Performance over time, per sending account */}
          <PerformancePanel
            view={view}
            allData={data}
            sender={sender}
            onSender={setSender}
          />

          {/* Who replied */}
          <Panel
            title={`Who replied · ${data.replied}`}
            action={
              data.replied > 0 ? (
                <div className="flex items-center gap-3 text-[10px]">
                  <Legend color={POSITIVE_COLOR} label={`${data.positive}`} small />
                  <Legend color={NEUTRAL_COLOR} label={`${data.neutral}`} small />
                  <Legend color={NEGATIVE_COLOR} label={`${data.negative}`} small />
                </div>
              ) : null
            }
          >
            <RepliersList repliers={data.repliers} />
          </Panel>

          {/* Breakdowns */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            <Panel title="By sender">
              <Breakdown items={data.bySender} />
            </Panel>
            <Panel title="By site">
              <Breakdown items={data.bySite} />
            </Panel>
            <Panel title="Top countries">
              <Breakdown items={data.byCountry} />
            </Panel>
          </div>
        </div>
      )}
    </div>
  );
}

export default function InsightsModal({
  rows,
  replies = [],
  loading,
  onRefresh,
  onClose,
}: {
  rows: SheetHistoryRow[];
  replies?: ReplyNotification[];
  loading: boolean;
  onRefresh: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fade-in fixed inset-0 z-[70] flex items-center justify-center bg-black/75 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="glass slide-in relative flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl shadow-2xl shadow-black/50">
        <div className="flex-1 overflow-auto p-4">
          <InsightsDashboard
            rows={rows}
            replies={replies}
            loading={loading}
            onRefresh={onRefresh}
            onClose={onClose}
          />
        </div>
      </div>
    </div>
  );
}

// --- Pieces -----------------------------------------------------------

function Panel({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h4 className="text-[11px] font-medium uppercase tracking-[0.22em] text-slate-400">
          {title}
        </h4>
        {action}
      </div>
      {children}
    </div>
  );
}

function StatCard({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string | number;
  sub?: string;
  accent: string;
}) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.04] px-3 py-2.5">
      <div className="text-[10px] font-medium uppercase tracking-[0.18em] text-slate-400">
        {label}
      </div>
      <div className="mt-0.5 text-xl font-bold sm:text-2xl" style={{ color: accent }}>
        {value}
      </div>
      {sub && <div className="mt-0.5 text-[10px] text-slate-500">{sub}</div>}
    </div>
  );
}

// Timeline line colours (distinct, in the app palette).
const LINE_CONTACTS = "#38bdf8";
const LINE_VIEWED = "#a78bfa";
const LINE_REPLIED = POSITIVE_COLOR;

function pctOf(n: number, d: number): number {
  return d > 0 ? Math.round((n / d) * 100) : 0;
}

function SenderTab({
  active,
  label,
  rate,
  title,
  onClick,
}: {
  active: boolean;
  label: string;
  rate: number;
  title?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium transition " +
        (active
          ? "bg-cyan-500/20 text-cyan-100 ring-1 ring-cyan-400/40"
          : "bg-white/5 text-slate-300 hover:bg-white/10")
      }
    >
      <span className="max-w-[120px] truncate">{label}</span>
      <span className={"tabular-nums " + (active ? "text-cyan-300" : "text-slate-500")}>
        {rate}%
      </span>
    </button>
  );
}

function MiniStat({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string | number;
  sub?: string;
  accent: string;
}) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] px-2.5 py-2">
      <div className="text-[9px] font-medium uppercase tracking-[0.14em] text-slate-400">
        {label}
      </div>
      <div className="mt-0.5 flex items-baseline gap-1.5">
        <span className="text-lg font-bold" style={{ color: accent }}>
          {value}
        </span>
        {sub && <span className="text-[10px] text-slate-500">{sub}</span>}
      </div>
    </div>
  );
}

// Performance-over-time panel: pick a sending account (or all) and see its
// totals + a Contacts / Viewed / Replied timeline. The reply-rate on each tab
// answers "which account replies best". The timeline starts at the first day of
// data (open-tracking began recently) and extends a point per day.
function PerformancePanel({
  view,
  allData,
  sender,
  onSender,
}: {
  view: Insights;
  allData: Insights;
  sender: string;
  onSender: (s: string) => void;
}) {
  const stats = allData.senderStats;
  const multiDay = view.perDay.length > 1;
  return (
    <Panel
      title="Performance"
      action={
        <div className="flex items-center gap-3 text-[10px]">
          <Legend color={LINE_CONTACTS} label="Contacts" small />
          <Legend color={LINE_VIEWED} label="Viewed" small />
          <Legend color={LINE_REPLIED} label="Replied" small />
        </div>
      }
    >
      {stats.length > 1 && (
        <div className="mb-3 flex flex-wrap gap-1.5">
          <SenderTab
            active={sender === "all"}
            label="All accounts"
            rate={Math.round(allData.replyRate * 100)}
            onClick={() => onSender("all")}
          />
          {stats.map((s) => (
            <SenderTab
              key={s.email}
              active={sender === s.email}
              label={s.label}
              title={`${s.email} · ${s.contacts} contacts · ${s.replied} replied · ${Math.round(s.replyRate * 100)}% reply`}
              rate={Math.round(s.replyRate * 100)}
              onClick={() => onSender(s.email)}
            />
          ))}
        </div>
      )}

      <div className="mb-3 grid grid-cols-3 gap-2">
        <MiniStat label="Sent" value={view.sent} accent="#e8edf5" />
        <MiniStat
          label="Viewed"
          value={view.openedEmails}
          sub={`${pctOf(view.openedEmails, view.sent)}%`}
          accent={LINE_VIEWED}
        />
        <MiniStat
          label="Replied"
          value={view.replied}
          sub={`${pctOf(view.replied, view.uniqueContacts)}%`}
          accent={LINE_REPLIED}
        />
      </div>

      <TrendChart
        labels={view.perDay.map((d) => d.label)}
        series={[
          { label: "Contacts", color: LINE_CONTACTS, points: view.perDay.map((d) => d.contacts) },
          { label: "Viewed", color: LINE_VIEWED, points: view.perDay.map((d) => d.opened) },
          { label: "Replied", color: LINE_REPLIED, points: view.perDay.map((d) => d.replied) },
        ]}
      />
      {!multiDay && (
        <p className="mt-2 text-center text-[10px] text-slate-500">
          Day one of tracking — the timeline fills in as more days pass.
        </p>
      )}
    </Panel>
  );
}

const SENTIMENT_META: Record<Sentiment, { label: string; color: string; dot: string }> = {
  positive: { label: "Positive", color: "text-emerald-300", dot: POSITIVE_COLOR },
  neutral: { label: "Neutral", color: "text-sky-300", dot: NEUTRAL_COLOR },
  negative: { label: "Negative", color: "text-rose-300", dot: NEGATIVE_COLOR },
};

function SentimentBadge({ sentiment }: { sentiment: Sentiment }) {
  const m = SENTIMENT_META[sentiment];
  return (
    <span
      className={
        "inline-flex shrink-0 items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[10px] font-semibold " +
        m.color
      }
    >
      <span
        className="h-1.5 w-1.5 rounded-full"
        style={{ backgroundColor: m.dot }}
        aria-hidden
      />
      {m.label}
    </span>
  );
}

function RepliersList({ repliers }: { repliers: Replier[] }) {
  if (repliers.length === 0) {
    return <p className="text-xs text-slate-500">No replies in this range yet.</p>;
  }
  return (
    <ul className="-mr-1 max-h-52 space-y-1.5 overflow-y-auto pr-1">
      {repliers.map((r) => (
        <li
          key={r.email}
          className="rounded-xl border border-white/5 bg-white/[0.02] px-3 py-2 transition hover:border-white/10 hover:bg-white/[0.04]"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-medium text-slate-100">
                  {r.name || r.email}
                </span>
                <SentimentBadge sentiment={r.sentiment} />
              </div>
              <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-slate-400">
                {r.name && <span className="truncate">{r.email}</span>}
                {r.site && (
                  <>
                    <span className="text-slate-600">·</span>
                    <span className="truncate">{r.site}</span>
                  </>
                )}
                {r.country && (
                  <>
                    <span className="text-slate-600">·</span>
                    <span className="inline-flex items-center gap-1 truncate">
                      <CountryFlag country={r.country} size={11} />
                      {r.country}
                    </span>
                  </>
                )}
              </div>
            </div>
            <span className="shrink-0 whitespace-nowrap text-[10px] text-slate-500">
              {fmtWhen(r.whenMs)}
            </span>
          </div>
          {r.snippet && (
            <p className="mt-1.5 line-clamp-2 text-[11px] italic text-slate-400">
              “{r.snippet}”
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}

function Legend({
  color,
  label,
  value,
  small,
}: {
  color: string;
  label: string;
  value?: number;
  small?: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      <span
        className={"inline-block rounded-full " + (small ? "h-2 w-2" : "h-2.5 w-2.5")}
        style={{ backgroundColor: color }}
      />
      <span className={small ? "text-slate-400" : "text-slate-300"}>{label}</span>
      {value !== undefined && (
        <span className="font-mono text-slate-100">{value}</span>
      )}
    </div>
  );
}

function Donut({
  segments,
  size,
  thickness,
  center,
}: {
  segments: { value: number; color: string }[];
  size: number;
  thickness: number;
  center?: ReactNode;
}) {
  const total = segments.reduce((s, x) => s + x.value, 0) || 1;
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  let acc = 0;

  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke="rgba(255,255,255,0.05)"
            strokeWidth={thickness}
          />
          {segments.map((s, i) => {
            const len = (s.value / total) * c;
            const el = (
              <circle
                key={i}
                cx={size / 2}
                cy={size / 2}
                r={r}
                fill="none"
                stroke={s.color}
                strokeWidth={thickness}
                strokeDasharray={`${len} ${c - len}`}
                strokeDashoffset={-acc}
                style={{ transition: "stroke-dasharray 0.5s ease" }}
              />
            );
            acc += len;
            return el;
          })}
        </g>
      </svg>
      {center && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          {center}
        </div>
      )}
    </div>
  );
}

// Reply-sentiment stack: one wide bar with a 2px surface gap between fills and
// a labeled legend below, so the full positive/neutral/negative/no-reply split
// reads in a single glance without the vertical bulk of a donut. Status colors
// always ship with the legend labels + gaps (never color alone).
function SentimentBar({
  positive,
  neutral,
  negative,
  pending,
}: {
  positive: number;
  neutral: number;
  negative: number;
  pending: number;
}) {
  const total = Math.max(1, positive + neutral + negative + pending);
  const segs = [
    { key: "Positive", value: positive, color: POSITIVE_COLOR },
    { key: "Neutral", value: neutral, color: NEUTRAL_COLOR },
    { key: "Negative", value: negative, color: NEGATIVE_COLOR },
    { key: "No reply", value: pending, color: "#64748b" },
  ].filter((s) => s.value > 0);
  return (
    <div className="flex h-3 w-full items-stretch gap-[2px] overflow-hidden rounded-full bg-slate-800/50">
      {segs.map((s) => (
        <div
          key={s.key}
          className="h-full rounded-[3px] transition-[width] duration-500"
          style={{ width: `${(s.value / total) * 100}%`, backgroundColor: s.color }}
          title={`${s.key}: ${s.value}`}
        />
      ))}
    </div>
  );
}

// Outreach funnel: emails sent → unique contacts → replied → positive, as
// proportional horizontal bars. Works for any range (a single day or many),
// unlike a daily bar chart which collapses to one block for "Today".
function Funnel({
  sent,
  contacts,
  opened,
  replied,
  positive,
}: {
  sent: number;
  contacts: number;
  opened: number;
  replied: number;
  positive: number;
}) {
  const base = Math.max(1, sent, contacts, opened, replied, positive);
  const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 100) : 0);
  const rows = [
    { label: "Emails sent", value: sent, color: "#94a3b8", rate: "" },
    { label: "Contacts", value: contacts, color: "#38bdf8", rate: "" },
    {
      label: "Opened",
      value: opened,
      color: "#a78bfa",
      rate: contacts > 0 ? `${pct(opened, contacts)}% open` : "",
    },
    {
      label: "Replied",
      value: replied,
      color: POSITIVE_COLOR,
      rate: contacts > 0 ? `${pct(replied, contacts)}% reply` : "",
    },
    {
      label: "Positive",
      value: positive,
      color: "#22d3ee",
      rate: replied > 0 ? `${pct(positive, replied)}% of repl.` : "",
    },
  ];
  return (
    <div className="space-y-2.5">
      {rows.map((r) => (
        <div key={r.label} className="flex items-center gap-2.5">
          <span className="w-[68px] shrink-0 text-[11px] text-slate-300">
            {r.label}
          </span>
          <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-800/60">
            <div
              className="h-full rounded-full transition-[width] duration-500"
              style={{ width: `${(r.value / base) * 100}%`, backgroundColor: r.color }}
            />
          </div>
          <span className="w-9 shrink-0 text-right font-mono text-xs font-semibold text-slate-100">
            {r.value}
          </span>
          <span className="w-[74px] shrink-0 text-right text-[10px] text-slate-500">
            {r.rate}
          </span>
        </div>
      ))}
    </div>
  );
}

// Tracks a container's pixel width so the chart can be drawn at 1:1 scale
// (uniform SVG scaling would shrink the axis text on narrow panels).
function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setW(e.contentRect.width);
    });
    ro.observe(el);
    setW(el.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

// Catmull-Rom → cubic Bézier: a smooth curve through every point (the ROAS
// look), with the endpoints clamped so the line doesn't fly off the edges.
function smoothPath(pts: { x: number; y: number }[]): string {
  if (pts.length === 0) return "";
  if (pts.length === 1) return `M${pts[0].x},${pts[0].y}`;
  let d = `M${pts[0].x},${pts[0].y}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C${cp1x},${cp1y} ${cp2x},${cp2y} ${p2.x},${p2.y}`;
  }
  return d;
}

function niceCeil(v: number): number {
  if (v <= 4) return 4;
  const pow = Math.pow(10, Math.floor(Math.log10(v)));
  for (const s of [1, 2, 4, 5, 10]) {
    if (s * pow >= v) return s * pow;
  }
  return 10 * pow;
}

function fmtTick(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

// Smooth multi-series trend line: several metrics on a shared count axis with
// gridlines, y-ticks and a date axis. Replaces the single-block daily bars.
function TrendChart({
  labels,
  series,
}: {
  labels: string[];
  series: { label: string; color: string; points: number[] }[];
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const H = 150;
  const padL = 34;
  const padR = 12;
  const padT = 12;
  const padB = 26;
  const n = labels.length;
  const W = Math.max(width, 240);
  const maxVal = Math.max(1, ...series.flatMap((s) => s.points));
  const niceMax = niceCeil(maxVal);
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const baseline = padT + plotH;
  const xAt = (i: number) => padL + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const yAt = (v: number) => padT + plotH - (v / niceMax) * plotH;

  const TICKS = 4;
  const tickVals = Array.from({ length: TICKS + 1 }, (_, i) => (niceMax / TICKS) * i);
  const labelStep = Math.max(1, Math.ceil(n / 6));

  return (
    <div ref={ref} className="w-full">
      {width > 0 && (
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
          <defs>
            <linearGradient id="trend-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={series[0]?.color ?? "#22d3ee"} stopOpacity="0.22" />
              <stop offset="100%" stopColor={series[0]?.color ?? "#22d3ee"} stopOpacity="0" />
            </linearGradient>
          </defs>

          {/* gridlines + y-axis ticks */}
          {tickVals.map((tv, i) => {
            const y = yAt(tv);
            return (
              <g key={i}>
                <line
                  x1={padL}
                  y1={y}
                  x2={W - padR}
                  y2={y}
                  stroke="rgba(148,163,184,0.12)"
                  strokeWidth={1}
                />
                <text
                  x={padL - 7}
                  y={y + 3}
                  textAnchor="end"
                  fontSize={9}
                  fill="rgba(148,163,184,0.75)"
                >
                  {fmtTick(tv)}
                </text>
              </g>
            );
          })}

          {/* area under the primary series */}
          {series[0] && series[0].points.length > 0 && (
            <path
              d={
                smoothPath(series[0].points.map((v, i) => ({ x: xAt(i), y: yAt(v) }))) +
                ` L${xAt(n - 1)},${baseline} L${xAt(0)},${baseline} Z`
              }
              fill="url(#trend-fill)"
              stroke="none"
            />
          )}

          {/* series lines */}
          {series.map((s, si) => (
            <path
              key={si}
              d={smoothPath(s.points.map((v, i) => ({ x: xAt(i), y: yAt(v) })))}
              fill="none"
              stroke={s.color}
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ))}

          {/* point markers — so a single day (e.g. the first day of tracking)
              still shows as a visible dot, and each day reads clearly */}
          {series.map((s, si) =>
            s.points.map((v, i) => (
              <circle
                key={`${si}-${i}`}
                cx={xAt(i)}
                cy={yAt(v)}
                r={n <= 1 ? 3.5 : 2.5}
                fill="#0b1220"
                stroke={s.color}
                strokeWidth={1.75}
              />
            )),
          )}

          {/* x-axis date labels */}
          {labels.map((lb, i) =>
            i % labelStep === 0 || i === n - 1 ? (
              <text
                key={i}
                x={xAt(i)}
                y={H - 8}
                textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"}
                fontSize={9}
                fill="rgba(148,163,184,0.75)"
              >
                {lb}
              </text>
            ) : null,
          )}
        </svg>
      )}
    </div>
  );
}

function Breakdown({
  items,
}: {
  items: { label: string; value: number; color: string }[];
}) {
  if (items.length === 0) {
    return <p className="text-xs text-slate-500">No data.</p>;
  }
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <div className="space-y-2">
      {items.map((it, i) => (
        <div key={i} className="flex items-center gap-2">
          <span
            className="w-16 shrink-0 truncate text-[11px] text-slate-300"
            title={it.label}
          >
            {it.label}
          </span>
          <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-800/60">
            <div
              className="h-full rounded-full transition-[width]"
              style={{
                width: `${(it.value / max) * 100}%`,
                backgroundColor: it.color,
              }}
            />
          </div>
          <span className="w-6 shrink-0 text-right font-mono text-[11px] text-slate-200">
            {it.value}
          </span>
        </div>
      ))}
    </div>
  );
}

// --- Icons ------------------------------------------------------------

type IconProps = { className?: string };

function ChartIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M3 3v18h18" />
      <rect x="7" y="11" width="3" height="6" rx="1" fill="currentColor" stroke="none" />
      <rect x="12" y="7" width="3" height="10" rx="1" fill="currentColor" stroke="none" />
      <rect x="17" y="13" width="3" height="4" rx="1" fill="currentColor" stroke="none" />
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

function RefreshIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
      <path d="M3 21v-5h5" />
    </svg>
  );
}

function CalendarIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <rect x="3" y="4" width="18" height="17" rx="2" />
      <path d="M3 9h18M8 2v4M16 2v4" />
    </svg>
  );
}

function ChevronIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}
