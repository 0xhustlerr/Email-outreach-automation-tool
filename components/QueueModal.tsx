"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { CountryFlag } from "@/components/CountryFlag";
import { useTemplates } from "@/hooks/useTemplates";
import type { MailIdentity } from "@/lib/types";

// Send-queue browser: shows the drip status, per-item state, and the worker
// settings (window, interval, jitter, daily cap, sender rotation).

type StepStatus =
  | "pending"
  | "sending"
  | "sent"
  | "failed"
  | "scheduled"
  | "waiting"
  | "skipped";

export type QueueItem = {
  id: number;
  lane: "send" | "queue";
  toEmail: string;
  /** Second recipient the CSV import CC'd (near-tie on the email score). */
  ccEmail: string;
  name: string;
  countryStd: string;
  timezone: string;
  tzSource: string;
  opSubject: string;
  opStatus: StepStatus;
  opSentAt: string | null;
  opSendAfter: string | null;
  hasFollow: boolean;
  fuStatus: StepStatus;
  /** When the link-free bump went out. Null = not bumped (it fires once, ever). */
  bumpSentAt: string | null;
  lastError: string;
};

type QueueSettings = {
  enabled: boolean;
  windowStart: string;
  windowEnd: string;
  intervalSec: number;
  jitterSec: number;
  dailyCap: number;
  rotateSenders: boolean;
  startAt: string | null;
  localTimeSend: boolean;
  localStart: string;
  localEnd: string;
  senderPool: string[];
  // Each account's daily cap (lowercased email -> cap). Absent = uncapped.
  // A patch replaces the whole map.
  senderCaps: Record<string, number>;
  bumpEnabled: boolean;
  bumpAfterDays: number;
};

// An account Gmail policy-blocked ("Message blocked" bounce). Mirrors
// SenderBlock in lib/sender-blocks.ts — `sender` is always lowercased.
type SenderBlock = {
  sender: string;
  reason: string;
  detail: string;
  blockedDay: string;
  detectedAt: string;
  /** ISO of the next local midnight, when the block lifts itself. */
  until: string;
  source: string;
  statusCode: string;
  recipient: string;
};

type QueueStatus = {
  enabled: boolean;
  withinWindow: boolean;
  sentToday: number;
  dailyCap: number;
  capReached: boolean;
  nextInSec: number | null;
  startAt: string | null;
  lastError: string;
  lastSentAt: string | null;
  senderPool?: string[];
  sentBySender?: Record<string, number>;
  // Resolved daily cap per pooled account (0 = unlimited).
  capBySender?: Record<string, number>;
  waitingForSender?: number;
  // Accounts paused for today by a Gmail block; they resume on their own.
  blockedSenders?: SenderBlock[];
  // Every eligible account is blocked — nothing can send until tomorrow.
  allSendersBlocked?: boolean;
};

// An account's own daily cap from senderCaps. 0 = unlimited.
function effCapFor(s: QueueSettings, email: string): number {
  return s.senderCaps?.[email] ?? 0;
}

// When this item's link-free bump becomes eligible, or null if it can never get
// one (bumps off, already bumped, opener not sent, or the pitch already moved on
// from 'scheduled'). Mirrors claimDueBump in lib/sequences-store.ts, minus the
// "has this contact replied?" test — only the server can answer that, so a row
// may show a bump ETA that a reply quietly cancels.
function bumpDueAt(item: QueueItem, s: QueueSettings): number | null {
  if (!s.bumpEnabled) return null;
  if (item.fuStatus !== "scheduled" || item.bumpSentAt || !item.opSentAt) return null;
  return new Date(item.opSentAt).getTime() + s.bumpAfterDays * 86_400_000;
}

// Overall day ceiling = sum of each active account's cap; legacy total
// dailyCap when any active account is uncapped. Mirrors the server's
// effectiveDailyCap in lib/queue-worker.ts.
function computeTotalDailyCap(s: QueueSettings, activeEmails: string[]): number {
  const caps = activeEmails.map((e) => effCapFor(s, e));
  return caps.length > 0 && caps.every((c) => c > 0)
    ? caps.reduce((a, b) => a + b, 0)
    : s.dailyCap;
}

// Order-insensitive form of a settings value, for the "did the user change
// this?" diff. senderPool is a set and senderCaps a map, so unchecking and
// re-checking a sender (or clearing and retyping the same cap) reorders them
// without changing anything — a plain JSON.stringify would call that an edit.
function canonical(v: unknown): string {
  if (Array.isArray(v)) return JSON.stringify([...v].sort());
  if (v !== null && typeof v === "object") {
    return JSON.stringify(
      Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0,
      ),
    );
  }
  return JSON.stringify(v);
}

// "12:00 AM" from a block's ISO `until`. label12h below only takes "HH:MM".
function resumeAt(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "tomorrow"
    : d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

// 12-hour label for an "HH:MM" 24h value.
function label12h(hhmm: string): string {
  const [h, m] = hhmm.split(":").map((n) => parseInt(n, 10));
  const hour = Number.isFinite(h) ? h : 0;
  const min = Number.isFinite(m) ? m : 0;
  const ampm = hour < 12 ? "AM" : "PM";
  const h12 = hour % 12 || 12;
  return `${h12}:${String(min).padStart(2, "0")} ${ampm}`;
}

// Dropdown of half-hour slots (12:00 AM … 11:30 PM). Far easier to pick than a
// native time spinner. Off-grid values (e.g. an old 02:03) are kept as an
// extra option so nothing is silently lost.
function TimeSelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const slots: string[] = [];
  for (let h = 0; h < 24; h++) {
    for (const m of [0, 30]) {
      slots.push(`${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
    }
  }
  if (!slots.includes(value)) slots.unshift(value);

  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="mt-1 w-full rounded-md border border-white/10 bg-slate-950 px-2 py-1.5 text-xs text-slate-100 outline-none focus:border-cyan-400/40"
    >
      {slots.map((s) => (
        <option key={s} value={s}>
          {label12h(s)}
        </option>
      ))}
    </select>
  );
}

// Small caps header that groups a block of settings.
function SectionHead({ children }: { children: ReactNode }) {
  return (
    <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">
      {children}
    </div>
  );
}

function GearIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

// Remembers which openers are ticked in the rotation picker across reopens.
const ROTATE_KEY = "mail.queue.rotateOpenerIds.v2";

// <input type="datetime-local"> wants "YYYY-MM-DDTHH:MM" in local time.
function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
function fromLocalInput(v: string): string | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// Current local time (HH:MM) in a resolved timezone (IANA name or "UTC±HH:MM").
function localClock(timezone: string): string | null {
  if (!timezone) return null;
  try {
    if (timezone.startsWith("UTC")) {
      const m = /UTC([+-])(\d{2}):(\d{2})/.exec(timezone);
      if (!m) return null;
      const off = (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
      const d = new Date(Date.now() + off * 60000);
      const p = (n: number) => String(n).padStart(2, "0");
      return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
    }
    return new Intl.DateTimeFormat(undefined, {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date());
  } catch {
    return null;
  }
}

function fmtCountdown(sec: number): string {
  if (sec <= 0) return "any moment";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}m ${String(s).padStart(2, "0")}s` : `${s}s`;
}

// Wall-clock label for a send ETA, in this machine's timezone: "11:42" when it
// lands today, "Aug 15, 11:42" when it spills past midnight. No zone suffix —
// the tooltip carries the full timestamp if anyone needs to be sure.
function fmtClock(ms: number, nowMs: number): string {
  const d = new Date(ms);
  const time = d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  if (new Date(nowMs).toDateString() === d.toDateString()) return time;
  const day = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `${day}, ${time}`;
}

// "HH:MM" -> minutes past midnight. Mirrors parseHm in lib/queue-worker.ts.
function parseHm(hm: string): number {
  const [h, m] = (hm || "").split(":").map((n) => parseInt(n, 10));
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
}

// Mirrors withinWindow (lib/queue-worker.ts) and withinLocalWindow
// (lib/country.ts): start === end means "always on", and an end before the
// start wraps midnight.
function inHmWindow(minutes: number, startMin: number, endMin: number): boolean {
  if (startMin === endMin) return true;
  if (startMin < endMin) return minutes >= startMin && minutes < endMin;
  return minutes >= startMin || minutes < endMin;
}

// Minutes past midnight right now in a timezone; null when it's unknown or
// unparseable — the same contacts the worker lets through the local gate.
function tzMinutesNow(timezone: string): number | null {
  const hm = localClock(timezone);
  if (!hm) return null;
  const [h, m] = hm.split(":").map((n) => parseInt(n, 10));
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return (h % 24) * 60 + m;
}

// With local-time sending on, a contact outside its own window can't be claimed
// however short the queue is (localEligible, lib/queue-worker.ts). Returns the
// instant that window opens, or null when the contact is already inside it (or
// has no usable timezone, which the worker treats as always eligible).
function localWindowOpensAt(
  timezone: string,
  startMin: number,
  endMin: number,
  nowMs: number,
): number | null {
  const mins = tzMinutesNow(timezone);
  if (mins === null || startMin === endMin) return null;
  if (inHmWindow(mins, startMin, endMin)) return null;
  let wait = startMin - mins;
  if (wait < 0) wait += 1440;
  return nowMs + wait * 60000;
}

function CloseIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}

function PauseIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <rect x="6" y="5" width="4" height="14" rx="1" />
      <rect x="14" y="5" width="4" height="14" rx="1" />
    </svg>
  );
}

function RetryIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 3v6h-6" />
    </svg>
  );
}

function MailIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m3 7 9 7 9-7" />
    </svg>
  );
}

// Is there a failed step a retry could actually restart? Mirrors the server
// rule in retrySequence (lib/sequences-store.ts) — keep the two in step, or the
// button appears on rows the API will refuse.
function canRetry(item: QueueItem): boolean {
  if (item.opStatus === "failed") return true;
  return item.opStatus === "sent" && item.fuStatus === "failed";
}

// One compact pill summarising an item's overall state (replaces the two
// uppercase "1 pending / 2 pending" chips). Mirrors the History status pill.
function QueueStatusPill({ item }: { item: QueueItem }) {
  const pill = (text: string, cls: string, title: string) => (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${cls}`}
      title={title}
    >
      {text}
    </span>
  );
  const { opStatus, fuStatus, hasFollow } = item;
  if (opStatus === "failed" || (hasFollow && fuStatus === "failed")) {
    return pill(
      "⚠ Failed",
      "border-rose-400/30 bg-rose-500/15 text-rose-300",
      item.lastError || "A send step failed",
    );
  }
  if (opStatus === "sending") {
    return pill("Sending", "border-amber-400/30 bg-amber-500/15 text-amber-300", "Opener sending now");
  }
  if (opStatus === "pending") {
    return pill("Queued", "border-cyan-400/30 bg-cyan-500/15 text-cyan-200", "Opener queued");
  }
  if (opStatus === "skipped") {
    return pill("Skipped", "border-white/10 bg-white/5 text-slate-500", "Skipped");
  }
  // Opener sent from here on.
  if (hasFollow) {
    if (fuStatus === "sent") {
      return pill("✓✓ 2-step", "border-cyan-400/30 bg-cyan-500/15 text-cyan-200", "Opener + follow-up sent");
    }
    if (fuStatus === "sending") {
      return pill("Sending 2", "border-amber-400/30 bg-amber-500/15 text-amber-300", "Follow-up sending");
    }
    if (fuStatus === "scheduled") {
      return pill(
        "⏳ Follow-up",
        "border-indigo-400/30 bg-indigo-500/15 text-indigo-200",
        "Opener sent · the pitch waits for a reply (a link-free bump may go out first)",
      );
    }
    return pill(
      "Awaiting reply",
      "border-white/10 bg-white/5 text-slate-400",
      "Opener sent · follow-up sends after a reply",
    );
  }
  return pill("✓ Sent", "border-emerald-400/30 bg-emerald-500/15 text-emerald-300", "Opener sent");
}

export default function QueueModal({
  onClose,
  senders = [],
}: {
  onClose: () => void;
  senders?: MailIdentity[];
}) {
  const [items, setItems] = useState<QueueItem[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [settings, setSettings] = useState<QueueSettings | null>(null);
  const [status, setStatus] = useState<QueueStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // Interval input unit — display in seconds or minutes; stored as seconds.
  const [intervalUnit, setIntervalUnit] = useState<"sec" | "min">("sec");
  // Settings are collapsed by default so the queued contacts stay visible.
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Working copy of the settings while the settings modal is open. Every edit
  // in there goes here, never straight to the server — nothing is applied until
  // the user clicks OK. Also means the 5s refresh can't clobber a live edit.
  const [draft, setDraft] = useState<QueueSettings | null>(null);
  // What the settings were when the modal opened. The diff sent on OK is
  // draft-vs-baseline, so a concurrent change from another window isn't
  // reverted by fields this user never touched.
  const [baseline, setBaseline] = useState<QueueSettings | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);
  // Whether "Rotate queued" ran this visit. That one writes to the server
  // immediately (it rewrites queue items, not settings), so the footer must not
  // claim "No changes" afterwards.
  const [rotatedQueued, setRotatedQueued] = useState(false);
  // In-progress per-account cap edits, kept as raw strings so a half-typed or
  // cleared box isn't coerced to a number mid-keystroke.
  const [capDrafts, setCapDrafts] = useState<Record<string, string>>({});
  // Opener rotation: rewrite the queued items' openers in place, round-robin
  // across the selected templates (no items removed).
  const { openers, templatesLoaded } = useTemplates();
  const [rotateIds, setRotateIds] = useState<string[]>([]);
  const [rotating, setRotating] = useState(false);
  const rotateInited = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/queue");
      const data = (await res.json()) as {
        ok?: boolean;
        items?: QueueItem[];
        counts?: Record<string, number>;
        settings?: QueueSettings;
        status?: QueueStatus;
      };
      if (res.ok && data.ok) {
        setItems(data.items ?? []);
        setCounts(data.counts ?? {});
        setSettings(data.settings ?? null);
        setStatus(data.status ?? null);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(refresh, 5000); // live status while open
    return () => window.clearInterval(id);
  }, [refresh]);

  // Sync the countdown from the server on each status poll…
  useEffect(() => {
    if (
      status &&
      status.enabled &&
      !status.capReached &&
      !status.allSendersBlocked &&
      status.nextInSec !== null
    ) {
      setCountdown(status.nextInSec);
    } else {
      setCountdown(null);
    }
  }, [status]);

  // ONE display clock drives both the next-send countdown and the per-item
  // ETAs. These were two separate 1s intervals, so every second cost two full
  // re-renders of this modal (and its whole queue list) instead of one.
  // Display-only — this never touches the running queue worker.
  useEffect(() => {
    const id = window.setInterval(() => {
      setNow(Date.now());
      // Unchanged when null, so React bails out instead of re-rendering.
      setCountdown((c) => (c === null ? null : Math.max(0, c - 1)));
    }, 1000);
    return () => window.clearInterval(id);
  }, []);

  const blocks = status?.blockedSenders ?? [];
  const blockByEmail = new Map(blocks.map((b) => [b.sender, b]));

  // Precompute drip order for the estimate.
  const pendingOpenerIds = items
    .filter((it) => it.opStatus === "pending")
    .map((it) => it.id)
    .sort((a, b) => a - b);
  // Due BUMPS, not due follow-ups: the timed follow-up lane is not wired into
  // the worker (claimDueFollowup is exported but never imported), so a scheduled
  // pitch waits on a reply and never claims a drip slot. The bump lane does —
  // it runs ahead of the openers and `continue`s (lib/queue-worker.ts:422).
  const dueBumpCount = !settings
    ? 0
    : items.filter((it) => {
        const due = bumpDueAt(it, settings);
        return due !== null && due <= now;
      }).length;

  // When each remaining drip slot actually fires. A flat `now + rank ×
  // interval` over-promises: it hands out clock times past the window end and
  // past the daily cap, both of which the worker enforces (withinWindow /
  // effectiveDailyCap in lib/queue-worker.ts) — with an 18:00 window end and a
  // long queue it would print "sends at 19:00" for a lane that stops at 18:00.
  // Walk the worker's rules instead. Slots 0..dueBumpCount-1 are the due bumps
  // that jump the line; the rest are pending openers in id order.
  const slotTimes = useMemo<number[]>(() => {
    if (!settings || !status) return [];
    const total = dueBumpCount + pendingOpenerIds.length;
    if (total === 0) return [];
    const intervalMs = Math.max(5, settings.intervalSec) * 1000;
    const startMin = parseHm(settings.windowStart);
    const endMin = parseHm(settings.windowEnd);
    // Local-time mode bypasses the global window entirely (queue-worker.ts:445)
    // — each contact is gated by its own local window instead, per item below.
    const windowed = !settings.localTimeSend && startMin !== endMin;
    const nextWindowStart = (ms: number) => {
      const d = new Date(ms);
      d.setHours(Math.floor(startMin / 60), startMin % 60, 0, 0);
      if (d.getTime() <= ms) d.setDate(d.getDate() + 1);
      return d.getTime();
    };
    const nextMidnight = (ms: number) => {
      const d = new Date(ms);
      d.setHours(0, 0, 0, 0);
      d.setDate(d.getDate() + 1);
      return d.getTime();
    };
    const dayKey = (ms: number) => new Date(ms).toDateString();
    const minutesOf = (ms: number) => {
      const d = new Date(ms);
      return d.getHours() * 60 + d.getMinutes();
    };
    // dailyCap counts distinct CONTACTS per day. A bump spends one too: its
    // opener went out days ago, so the contact isn't in today's send_log yet
    // (distinctClientsToday in lib/sequences-store.ts). 0 = no ceiling.
    const capPerDay = status.dailyCap > 0 ? status.dailyCap : Infinity;

    // Start from the end of the current send-spacing gap, not from `now`: the
    // first slot isn't due until the interval since the last send elapses. Both
    // terms tick once a second in opposite directions, so the projected clock
    // times hold still instead of creeping forward every render.
    let t = now + Math.max(0, countdown ?? 0) * 1000;
    if (status.startAt) t = Math.max(t, new Date(status.startAt).getTime());
    let day = dayKey(t);
    let capLeft = Math.max(0, capPerDay - status.sentToday);
    const times: number[] = [];
    for (let k = 0; k < total; k++) {
      // Push t forward until it lands on a moment the worker would send in:
      // inside the window, and on a day with cap headroom left. Neither gate
      // applies to the bump slots (k < dueBumpCount) — the bump lane runs above
      // both checks in lib/queue-worker.ts, so a due bump goes out off-window
      // and over cap. It still SPENDS cap, which is why capLeft drops below for
      // every slot.
      const gated = k >= dueBumpCount;
      for (let guard = 0; guard < 400; guard++) {
        if (gated && windowed && !inHmWindow(minutesOf(t), startMin, endMin)) {
          t = nextWindowStart(t);
        }
        if (dayKey(t) !== day) {
          day = dayKey(t);
          capLeft = capPerDay;
        }
        if (gated && capLeft <= 0) {
          t = nextMidnight(t); // cap resets at local midnight; re-check window
          continue;
        }
        break;
      }
      times.push(t);
      capLeft -= 1;
      t += intervalMs;
    }
    return times;
  }, [settings, status, dueBumpCount, pendingOpenerIds.length, now, countdown]);

  // Per-item send time, as a clock time rather than a countdown — "any moment"
  // told nobody anything. A sent opener reads its bump ETA (the only thing left
  // on a timer); pending openers read their projected slot above.
  const itemEta = (
    item: QueueItem,
    openerRank: number,
    dueBumps: number,
  ): { text: string; title: string } | null => {
    if (!status || !settings) return null;
    // Absolute stamp for the hover, with NO live countdown in it: this list
    // re-renders every second, and a title string that changes each tick makes
    // the browser dismiss the tooltip mid-read and restart the hover delay.
    const stamp = (ms: number) =>
      new Date(ms).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      });

    // Opener sent, pitch still pending. The pitch is reply-triggered — the
    // worker only runs claimRepliedFollowup, which ignores fu_send_after — so
    // there is no timed send to promise here. The one thing still on a clock is
    // the link-free bump, when it's turned on.
    if (item.fuStatus === "scheduled") {
      const base = "pitch on reply";
      const baseTitle =
        "Pitch (message 2) sends in-thread within minutes of a reply — there is no timed send.";
      if (item.bumpSentAt) {
        return {
          text: `${base} · bumped`,
          title: `${baseTitle}\nLink-free bump sent ${stamp(new Date(item.bumpSentAt).getTime())}.`,
        };
      }
      const due = bumpDueAt(item, settings);
      if (due === null) {
        return { text: base, title: `${baseTitle}\nBumps are off — nothing else is scheduled.` };
      }
      return due > now
        ? {
            text: `${base} · bump ${fmtClock(due, now)}`,
            title: `${baseTitle}\nLink-free bump due ${stamp(due)} if they stay quiet.`,
          }
        : {
            text: `${base} · bump due`,
            title: `${baseTitle}\nLink-free bump was due ${stamp(due)} — sends on the next pass.`,
          };
    }

    if (item.opStatus === "pending") {
      // When paused, the header already says so — don't repeat it on every row.
      if (!status.enabled) return null;
      const slot = slotTimes[dueBumps + openerRank];
      if (slot === undefined) return null;
      let eta = Math.max(
        slot,
        item.opSendAfter ? new Date(item.opSendAfter).getTime() : 0,
      );
      const why: string[] = [];
      if (status.capReached)
        why.push(
          `daily cap reached (${status.sentToday}/${status.dailyCap} contacts today)`,
        );
      if (!settings.localTimeSend && !status.withinWindow)
        why.push(
          `outside the ${settings.windowStart}–${settings.windowEnd} window`,
        );
      if (settings.localTimeSend) {
        const opensAt = localWindowOpensAt(
          item.timezone,
          parseHm(settings.localStart),
          parseHm(settings.localEnd),
          now,
        );
        if (opensAt !== null) {
          eta = Math.max(eta, opensAt);
          why.push(
            `outside ${settings.localStart}–${settings.localEnd} for ${item.timezone}`,
          );
        }
      }
      if (status.allSendersBlocked) {
        // Nothing can leave until the earliest block lifts (local midnight).
        const lifts = blocks
          .map((b) => new Date(b.until).getTime())
          .filter((ms) => Number.isFinite(ms));
        if (lifts.length > 0) eta = Math.max(eta, Math.min(...lifts));
        why.push("every sender is blocked");
      }
      return {
        text: `~ sends at ${fmtClock(eta, now)}`,
        title:
          `Estimated from queue position — ${stamp(eta)}` +
          (why.length > 0 ? ` (${why.join("; ")})` : ""),
      };
    }
    return null;
  };

  // Emails the drip will actually send on its own: every pending opener, plus
  // one link-free bump for each sent opener still owed one. A scheduled PITCH
  // is deliberately not counted — it only fires if the contact replies, so
  // counting it inflated both this number and the finish estimate below with
  // sends that may never happen.
  const remainingSends = useMemo(() => {
    let n = 0;
    for (const it of items) {
      if (it.opStatus === "pending") n += 1;
      else if (settings && bumpDueAt(it, settings) !== null) n += 1;
    }
    return n;
  }, [items, settings]);

  // Estimate when the whole queue finishes: walk day-by-day respecting the
  // window hours, one send per interval, and the daily cap (by client).
  const finishEstimate = useMemo(() => {
    if (!settings || !status || remainingSends === 0) return null;
    const intervalSec = Math.max(5, settings.intervalSec);
    const startMin = parseHm(settings.windowStart);
    const endMin = parseHm(settings.windowEnd);
    const winStartOf = (d: Date) => {
      const x = new Date(d);
      x.setHours(Math.floor(startMin / 60), startMin % 60, 0, 0);
      return x;
    };
    const winEndOf = (d: Date) => {
      const x = new Date(d);
      x.setHours(Math.floor(endMin / 60), endMin % 60, 0, 0);
      return x;
    };

    let t = new Date(now);
    if (status.startAt) {
      const s = new Date(status.startAt);
      if (s.getTime() > t.getTime()) t = s;
    }
    const advance = (d: Date) => {
      const ws = winStartOf(d);
      const we = winEndOf(d);
      if (d.getTime() < ws.getTime()) return new Date(ws);
      if (d.getTime() >= we.getTime()) {
        const nd = new Date(d);
        nd.setDate(nd.getDate() + 1);
        return winStartOf(nd);
      }
      return d;
    };

    let remaining = remainingSends;
    // Cap headroom in sends = headroom in clients, 1:1. The cap counts distinct
    // contacts per day, and every send left in the pool above goes to a contact
    // not yet counted today — an opener to a new one, a bump to one whose opener
    // went out days ago. status.dailyCap is the effective total (per-sender cap
    // × active accounts).
    let capSendsToday = Math.max(0, status.dailyCap - status.sentToday);
    let guard = 0;
    while (remaining > 0 && guard++ < 400) {
      t = advance(t);
      const secsLeft = Math.max(0, (winEndOf(t).getTime() - t.getTime()) / 1000);
      const slots = Math.min(Math.floor(secsLeft / intervalSec), capSendsToday);
      if (slots <= 0) {
        const nd = new Date(t);
        nd.setDate(nd.getDate() + 1);
        t = winStartOf(nd);
        capSendsToday = status.dailyCap;
        continue;
      }
      if (remaining <= slots) {
        t = new Date(t.getTime() + remaining * intervalSec * 1000);
        remaining = 0;
        break;
      }
      remaining -= slots;
      const nd = new Date(t);
      nd.setDate(nd.getDate() + 1);
      t = winStartOf(nd);
      capSendsToday = status.dailyCap;
    }
    if (remaining > 0) return null;
    // A bump owed for a date still ahead can't leave early however idle the
    // drip goes, so the queue isn't drained until the last one is due. No
    // window snap: the bump lane runs above the window check.
    let lastBumpDue = 0;
    for (const it of items) {
      const due = bumpDueAt(it, settings);
      if (due !== null) lastBumpDue = Math.max(lastBumpDue, due);
    }
    return lastBumpDue > t.getTime() ? new Date(lastBumpDue) : t;
  }, [items, settings, status, remainingSends, now]);

  const finishLabel = useMemo(() => {
    if (!finishEstimate) return null;
    const timeStr = finishEstimate.toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
    const sameDay =
      finishEstimate.toDateString() === new Date(now).toDateString();
    if (sameDay) return `~${timeStr} today`;
    return `${finishEstimate.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    })}, ~${timeStr}`;
  }, [finishEstimate, now]);

  // One-line digest shown next to the "Settings" bar.
  const settingsSummary = useMemo(() => {
    if (!settings) return "";
    const poolCount = settings.senderPool?.length ?? 0;
    const emails =
      poolCount > 0
        ? settings.senderPool
        : senders.map((x) => x.email.toLowerCase());
    const hasCaps = emails.some((e) => (settings.senderCaps?.[e] ?? 0) > 0);
    const cap = hasCaps
      ? `per-account caps · ${computeTotalDailyCap(settings, emails)}/day`
      : `${settings.dailyCap}/day`;
    return [
      `${label12h(settings.windowStart)}–${label12h(settings.windowEnd)}`,
      `${settings.intervalSec}s`,
      cap,
      settings.localTimeSend ? "local time" : null,
    ]
      .filter(Boolean)
      .join("  ·  ");
  }, [settings, senders]);

  // Immediate save — only for controls outside the settings modal (the
  // Running/Paused toggle). Everything inside the modal edits `draft` instead.
  const patchSettings = async (patch: Partial<QueueSettings>) => {
    setSettings((s) => (s ? { ...s, ...patch } : s));
    await fetch("/api/queue", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }).catch(() => {});
    void refresh();
  };

  // Edit the working copy. Nothing leaves the browser until OK.
  const editDraft = (patch: Partial<QueueSettings>) =>
    setDraft((d) => (d ? { ...d, ...patch } : d));

  // Fold any cap box the user is still typing in into a senderCaps map, so OK
  // applies it even if the input never blurred. Blank/0/invalid = uncapped.
  const mergeCapDrafts = useCallback(
    (caps: Record<string, number>) => {
      const next = { ...caps };
      for (const [email, raw] of Object.entries(capDrafts)) {
        const v = Math.round(Number(raw));
        if (raw.trim() !== "" && Number.isFinite(v) && v > 0) next[email] = v;
        else delete next[email];
      }
      return next;
    },
    [capDrafts],
  );

  // Only the fields the user actually changed — a patch merges over the stored
  // row, so sending the whole draft would also re-write untouched fields (and
  // `enabled`, which the Running/Paused toggle owns).
  //
  // The diff is against `baseline` (the snapshot taken when the modal opened),
  // NOT the live 5s-polled `settings`: another window editing the same local
  // app would otherwise show up as a "change" here and get reverted by fields
  // this user never touched.
  const draftPatch = useMemo(() => {
    if (!baseline || !draft) return null;
    const merged: QueueSettings = {
      ...draft,
      senderCaps: mergeCapDrafts(draft.senderCaps ?? {}),
    };
    const patch: Partial<QueueSettings> = {};
    for (const key of Object.keys(merged) as (keyof QueueSettings)[]) {
      if (canonical(merged[key]) !== canonical(baseline[key])) {
        (patch as Record<string, unknown>)[key] = merged[key];
      }
    }
    return patch;
  }, [baseline, draft, mergeCapDrafts]);

  const settingsDirty = !!draftPatch && Object.keys(draftPatch).length > 0;

  const closeSettings = () => {
    setSettingsOpen(false);
    setDraft(null);
    setBaseline(null);
    setCapDrafts({});
    setRotatedQueued(false);
  };

  const openSettings = () => {
    if (!settings) return;
    setDraft(settings);
    setBaseline(settings);
    setCapDrafts({});
    setRotatedQueued(false);
    setSettingsOpen(true);
  };

  const discardSettings = () => {
    // An apply is already in flight — its own PATCH will land regardless, so
    // don't offer to "discard" what is being written.
    if (savingSettings) return;
    if (
      settingsDirty &&
      !window.confirm("Discard the unsaved settings changes?")
    )
      return;
    closeSettings();
  };

  // OK — apply every edit in one PATCH, then close.
  const applySettings = async () => {
    if (savingSettings) return;
    if (!settingsDirty) {
      closeSettings();
      return;
    }
    setSavingSettings(true);
    try {
      const res = await fetch("/api/queue", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draftPatch),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        settings?: QueueSettings;
      };
      if (!res.ok || !data.ok) {
        toast.error("Couldn't apply the queue settings.");
        return;
      }
      // The server clamps values (interval, caps, …) — show what it stored.
      if (data.settings) setSettings(data.settings);
      toast.success("Queue settings applied.");
      closeSettings();
      void refresh();
    } catch {
      toast.error("Couldn't apply the queue settings.");
    } finally {
      setSavingSettings(false);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Esc closes the settings modal first if it's open, else the queue.
      if (!settingsOpen) {
        onClose();
        return;
      }
      // Mid-apply Esc is a no-op: the PATCH lands either way.
      if (savingSettings) return;
      if (
        settingsDirty &&
        !window.confirm("Discard the unsaved settings changes?")
      )
        return;
      setSettingsOpen(false);
      setDraft(null);
      setBaseline(null);
      setCapDrafts({});
      setRotatedQueued(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, settingsOpen, settingsDirty, savingSettings]);

  const itemAction = async (id: number, action: "cancel" | "retry") => {
    try {
      const res = await fetch(`/api/queue?action=${action}&id=${id}`, {
        method: "PATCH",
      });
      const data = (await res.json()) as {
        ok?: boolean;
        step?: "opener" | "followup";
        error?: string;
      };
      // A retry can legitimately do nothing (the contact got re-queued by
      // another route), so report the server's reason instead of a silent no-op.
      if (action === "retry") {
        if (!res.ok || !data.ok) {
          toast.error(`Couldn't retry — ${data.error ?? "request failed"}.`);
        } else {
          toast.success(
            data.step === "followup"
              ? "Follow-up re-scheduled."
              : "Back in the queue — it sends on the next drip slot.",
          );
        }
      }
    } catch {
      if (action === "retry") toast.error("Couldn't retry — request failed.");
    }
    void refresh();
  };

  // Retry every failed item. No confirm: it only ever puts sends BACK, and the
  // drip/cap rules still gate what actually goes out.
  const retryAllFailed = async () => {
    if (num("failed") === 0) return;
    try {
      const res = await fetch("/api/queue?action=retry-all-failed", {
        method: "PATCH",
      });
      const data = (await res.json()) as {
        ok?: boolean;
        openers?: number;
        followups?: number;
        skipped?: number;
      };
      if (!res.ok || !data.ok) {
        toast.error("Couldn't retry the failed items.");
      } else {
        const moved = (data.openers ?? 0) + (data.followups ?? 0);
        const skipped = data.skipped ?? 0;
        // "Nothing moved" and "nothing was eligible" are different outcomes —
        // when every candidate hit the server's dup guard, saying "nothing to
        // retry" next to a non-zero Failed counter reads as a broken button.
        toast[moved > 0 ? "success" : "info"](
          moved > 0
            ? `${moved} item(s) back in the queue${
                skipped > 0 ? ` · ${skipped} skipped (already queued)` : ""
              }.`
            : skipped > 0
              ? `Nothing moved — ${skipped} item(s) are already queued.`
              : "Nothing to retry.",
        );
      }
    } catch {
      toast.error("Couldn't retry the failed items.");
    }
    void refresh();
  };

  const clearFinished = async () => {
    await fetch("/api/queue?action=clear-finished", { method: "PATCH" }).catch(
      () => {},
    );
    void refresh();
  };

  const num = (v: string) => (counts[v] ?? 0);

  // Lift a Gmail block early. The server keeps the resume for the rest of the
  // local day, so this can't flap back on the next bounce.
  const resumeSender = async (email: string) => {
    try {
      const res = await fetch(
        `/api/queue?action=resume-sender&email=${encodeURIComponent(email)}`,
        { method: "PATCH" },
      );
      const data = (await res.json()) as { ok?: boolean; resumed?: boolean };
      if (!res.ok || !data.ok) {
        toast.error(`Couldn't resume ${email}.`);
      } else if (data.resumed) {
        toast.success(`${email} resumed — the queue can send from it again.`);
      } else {
        // Nothing to lift (already resumed, or the block expired between the
        // render and the click) — don't claim we did something.
        toast.info(`${email} wasn't blocked.`);
      }
    } catch {
      toast.error(`Couldn't resume ${email}.`);
    }
    void refresh();
  };

  const cancelAllQueued = async () => {
    const n = num("queued");
    if (n === 0) return;
    if (!window.confirm(`Cancel all ${n} queued opener(s)? This can't be undone.`))
      return;
    await fetch("/api/queue?action=cancel-all-queued", { method: "PATCH" }).catch(
      () => {},
    );
    void refresh();
  };

  const cancelAllFollowups = async () => {
    const n = num("followupsPending");
    if (n === 0) return;
    if (
      !window.confirm(
        `Stop all ${n} scheduled follow-up(s)? Openers already sent stay sent; only the pending replies are skipped.`,
      )
    )
      return;
    await fetch("/api/queue?action=cancel-all-followups", { method: "PATCH" }).catch(
      () => {},
    );
    void refresh();
  };

  // Restore the saved rotation selection once the REAL templates have loaded
  // (useTemplates returns a 1-item placeholder first — initializing against that
  // would lock the selection to a single opener and clobber the saved value).
  // Default to all the first time. Persisted so it survives reopening.
  useEffect(() => {
    if (rotateInited.current || !templatesLoaded || openers.length === 0) return;
    rotateInited.current = true;
    const validIds = new Set(openers.map((o) => o.id));
    let saved: string[] | null = null;
    try {
      const raw = localStorage.getItem(ROTATE_KEY);
      if (raw) saved = JSON.parse(raw) as string[];
    } catch {
      saved = null;
    }
    const filtered = Array.isArray(saved)
      ? saved.filter((id) => validIds.has(id))
      : null;
    setRotateIds(filtered && filtered.length ? filtered : openers.map((o) => o.id));
  }, [openers, templatesLoaded]);

  // Persist the selection whenever it changes (after the initial restore).
  useEffect(() => {
    if (!rotateInited.current) return;
    try {
      localStorage.setItem(ROTATE_KEY, JSON.stringify(rotateIds));
    } catch {
      // ignore storage failures
    }
  }, [rotateIds]);

  // Active sending accounts (the selected pool, or all identities if none).
  // Reads the draft while the settings modal is open, so the rotation estimate
  // below tracks the pool/caps being edited.
  const capSource = draft ?? settings;
  const activeEmails = useMemo(() => {
    const pool = capSource?.senderPool ?? [];
    return pool.length > 0
      ? pool
      : senders.map((s) => s.email.toLowerCase());
  }, [capSource?.senderPool, senders]);
  // The overall day ceiling = sum of each active account's own cap (legacy
  // total when any account is uncapped).
  const totalDailyCap = capSource
    ? computeTotalDailyCap(capSource, activeEmails)
    : 0;

  const selectedRotate = openers.filter((o) => rotateIds.includes(o.id));
  const allRotateOn =
    openers.length > 0 && selectedRotate.length === openers.length;
  const rotatePerDay =
    selectedRotate.length > 0 ? totalDailyCap / selectedRotate.length : 0;

  const toggleRotate = (id: string) =>
    setRotateIds((cur) =>
      cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id],
    );

  const applyOpenerRotation = async () => {
    const n = num("queued");
    if (selectedRotate.length === 0 || n === 0 || rotating) return;
    if (
      !window.confirm(
        `Rewrite the openers of all ${n} queued item(s), rotating ${selectedRotate.length} template(s)? Items and follow-ups stay; only the opener text changes.`,
      )
    )
      return;
    setRotating(true);
    try {
      const res = await fetch("/api/queue?action=rotate-openers", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          openers: selectedRotate.map((o) => ({
            subject: o.subject,
            body: o.body,
          })),
        }),
      });
      const data = (await res.json()) as { ok?: boolean; updated?: number };
      if (res.ok && data.ok) {
        setRotatedQueued(true);
        toast.success(`Rotated openers across ${data.updated ?? 0} queued item(s).`);
      } else {
        toast.error("Could not rotate openers.");
      }
    } catch {
      toast.error("Could not rotate openers.");
    } finally {
      setRotating(false);
      void refresh();
    }
  };

  return (
    <div
      className="fade-in fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="glass slide-in relative flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl shadow-2xl shadow-black/50">
        {/* Header + live status */}
        <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
          <div className="flex items-center gap-3">
            <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.22em] text-slate-200">
              <MailIcon className="h-4 w-4 text-cyan-300" />
              Send queue
            </h2>
            {settings && (
              <button
                type="button"
                onClick={() => void patchSettings({ enabled: !settings.enabled })}
                title={settings.enabled ? "Click to pause sending" : "Click to resume sending"}
                className={
                  "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition " +
                  (settings.enabled
                    ? "border-emerald-400/50 bg-emerald-500/15 text-emerald-200 hover:bg-emerald-500/25"
                    : "border-white/15 bg-slate-950/50 text-slate-300 hover:border-white/30")
                }
              >
                {settings.enabled ? (
                  <>
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.9)]" />
                    Running
                  </>
                ) : (
                  <>
                    <PauseIcon className="h-3 w-3" />
                    Paused
                  </>
                )}
              </button>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-2 text-slate-400 transition hover:bg-white/5 hover:text-white"
            title="Close"
            aria-label="Close"
          >
            <CloseIcon className="h-4 w-4" />
          </button>
        </div>

        {/* Stat strip */}
        {status && (
          <div className="flex flex-wrap items-center gap-x-6 gap-y-1 border-b border-white/10 px-5 py-2.5 text-xs text-slate-400">
            <span>
              Queued <b className="text-cyan-300">{num("queued")}</b>
            </span>
            <span>
              Openers sent <b className="text-emerald-300">{num("openersSent")}</b>
            </span>
            <span>
              Follow-ups due{" "}
              <b className="text-indigo-300">{num("followupsPending")}</b>
            </span>
            {num("failed") > 0 && (
              <span>
                Failed <b className="text-rose-300">{num("failed")}</b>
              </span>
            )}
            {(status.waitingForSender ?? 0) > 0 && (
              <span
                title="Openers whose original sender is the only account still free today. They wait (hard rule) until a different account has budget — add more Gmail accounts to clear this."
              >
                Waiting for sender{" "}
                <b className="text-amber-300">{status.waitingForSender}</b>
              </span>
            )}
            {blocks.length > 0 && (
              <span
                title={
                  "Gmail bounced these accounts with a policy/reputation block, so the queue skips them for the rest of today:\n" +
                  blocks
                    .map((b) => `• ${b.sender} — ${b.detail || b.reason}`)
                    .join("\n") +
                  `\n\nThey resume automatically at ${resumeAt(blocks[0].until)}.`
                }
              >
                Blocked accounts <b className="text-amber-300">{blocks.length}</b>
              </span>
            )}
            <span className="ml-auto tabular-nums">
              {!status.enabled
                ? "Paused"
                : status.allSendersBlocked
                  ? `Paused — Gmail block · resumes ${resumeAt(blocks[0]?.until ?? "")}`
                  : status.capReached
                  ? "Daily cap reached — resumes tomorrow"
                  : status.startAt && new Date(status.startAt) > new Date()
                    ? `Starts ${new Date(status.startAt).toLocaleString()}`
                    : !status.withinWindow
                      ? "Outside sending window — waiting"
                      : countdown !== null && countdown > 0
                        ? `Next send in ${fmtCountdown(countdown)}`
                        : num("queued") > 0
                          ? "Sending…"
                          : "Idle — queue empty"}
            </span>
          </div>
        )}

        {/* Today-cap meter + whole-queue finish estimate */}
        {status && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-b border-white/10 bg-white/[0.02] px-5 py-2.5 text-xs text-slate-400">
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-medium uppercase tracking-[0.18em] text-slate-500">
                Today
              </span>
              <div className="h-1.5 w-28 overflow-hidden rounded-full bg-slate-800/70">
                <div
                  className={
                    "h-full rounded-full transition-[width] duration-500 " +
                    (status.capReached ? "bg-amber-400" : "bg-cyan-400")
                  }
                  style={{
                    width: `${
                      status.dailyCap > 0
                        ? Math.min(100, (status.sentToday / status.dailyCap) * 100)
                        : 0
                    }%`,
                  }}
                />
              </div>
              <span className="font-mono tabular-nums text-[11px] text-slate-300">
                {status.sentToday}/{status.dailyCap}
              </span>
              <span className="text-slate-500">clients</span>
            </div>
            {remainingSends > 0 && (
              <>
                <span className="text-slate-700">·</span>
                <span title="Pending openers + link-free bumps still owed. The pitch isn't counted — it only sends if the contact replies.">
                  <b className="text-slate-200">{remainingSends}</b> left to send
                </span>
                {finishLabel && (
                  <span title="Estimate — depends on window, interval, daily cap & when the last bump comes due">
                    · all sent <b className="text-cyan-300">{finishLabel}</b>
                  </span>
                )}
              </>
            )}
          </div>
        )}

        {status?.lastError && (
          <p className="border-b border-white/10 bg-rose-500/10 px-5 py-2 text-xs text-rose-300">
            Last error: {status.lastError}
          </p>
        )}

        {/* Gmail blocks. Lives here rather than only on the per-account rows
            because the settings panel is collapsed by default. */}
        {blocks.length > 0 && (
          <div className="border-b border-white/10 bg-amber-500/10 px-5 py-2 text-xs text-amber-200">
            <p className="mb-1">
              Gmail blocked{" "}
              {blocks.length === 1 ? "an account" : `${blocks.length} accounts`} —
              the queue skips {blocks.length === 1 ? "it" : "them"} until tomorrow.
            </p>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              {blocks.map((b) => (
                <span key={b.sender} className="inline-flex items-center gap-1.5">
                  <span
                    className="font-mono text-[11px] text-amber-100"
                    title={b.detail || b.reason}
                  >
                    {b.sender}
                  </span>
                  <span className="text-amber-300/60">
                    · resumes {resumeAt(b.until)}
                  </span>
                  <button
                    type="button"
                    onClick={() => void resumeSender(b.sender)}
                    title={`Let the queue use ${b.sender} again right away. The resume holds for the rest of today — a further bounce won't silently re-pause it.`}
                    className="rounded-lg border border-amber-400/40 px-2 py-0.5 text-[10px] font-medium text-amber-200 transition hover:bg-amber-400/15"
                  >
                    Resume now
                  </button>
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Settings — opens a modal so the queued contacts stay in view */}
        {settings && (
          <button
            type="button"
            onClick={openSettings}
            className="flex w-full items-center gap-2 border-b border-white/10 px-5 py-2 text-left text-xs text-slate-300 transition hover:bg-white/[0.03]"
          >
            <GearIcon className="h-3.5 w-3.5 shrink-0 text-slate-400" />
            <span className="shrink-0 font-medium">Settings</span>
            <span className="min-w-0 flex-1 truncate text-[10px] text-slate-500">
              {settingsSummary}
            </span>
            <span className="shrink-0 rounded-full border border-white/10 px-2 py-0.5 text-[10px] text-cyan-300">
              Edit
            </span>
          </button>
        )}
        {draft && settingsOpen && (
          <div
            className="fade-in fixed inset-0 z-[60] flex items-center justify-center bg-black/75 p-4"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) discardSettings();
            }}
          >
            <div className="glass slide-in flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl shadow-2xl shadow-black/50">
              <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
                <h3 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.22em] text-slate-200">
                  <GearIcon className="h-4 w-4 text-cyan-300" />
                  Queue settings
                </h3>
                <button
                  type="button"
                  onClick={discardSettings}
                  className="rounded-full p-2 text-slate-400 transition hover:bg-white/5 hover:text-white"
                  title="Discard changes and close"
                  aria-label="Discard changes and close"
                >
                  <CloseIcon className="h-4 w-4" />
                </button>
              </div>
              <div className="space-y-4 overflow-y-auto px-5 py-4">
                {/* Schedule & window */}
            <div>
              <SectionHead>Schedule &amp; window</SectionHead>
              <div className="grid grid-cols-2 gap-x-3 gap-y-2.5 sm:grid-cols-4">
                <label className="col-span-2 text-[11px] text-slate-400">
                  Start sending at
                  <input
                    type="datetime-local"
                    value={toLocalInput(draft.startAt)}
                    onChange={(e) =>
                      editDraft({ startAt: fromLocalInput(e.target.value) })
                    }
                    className="mt-1 w-full rounded-md border border-white/10 bg-slate-950 px-2 py-1 text-xs text-slate-100 outline-none focus:border-cyan-400/40"
                  />
                  <span className="mt-0.5 block text-[10px] text-slate-600">
                    Blank = start as soon as the queue is running.
                  </span>
                </label>
                <label className="text-[11px] text-slate-400">
                  Window start
                  <TimeSelect
                    value={draft.windowStart}
                    onChange={(v) => editDraft({ windowStart: v })}
                  />
                </label>
                <label className="text-[11px] text-slate-400">
                  Window end
                  <TimeSelect
                    value={draft.windowEnd}
                    onChange={(v) => editDraft({ windowEnd: v })}
                  />
                </label>
                <label className="col-span-2 flex flex-col text-[11px] text-slate-300 sm:col-span-4">
                  <span className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={draft.localTimeSend}
                      onChange={(e) =>
                        editDraft({ localTimeSend: e.target.checked })
                      }
                      className="accent-cyan-500"
                    />
                    Send by each recipient&apos;s local time
                  </span>
                  <span className="ml-6 mt-0.5 text-[10px] text-slate-600">
                    Uses their resolved timezone; unknown ones use the window above.
                  </span>
                </label>
                {draft.localTimeSend && (
                  <>
                    <label className="col-span-2 text-[11px] text-slate-400">
                      Recipient local start
                      <TimeSelect
                        value={draft.localStart}
                        onChange={(v) => editDraft({ localStart: v })}
                      />
                    </label>
                    <label className="col-span-2 text-[11px] text-slate-400">
                      Recipient local end
                      <TimeSelect
                        value={draft.localEnd}
                        onChange={(v) => editDraft({ localEnd: v })}
                      />
                    </label>
                  </>
                )}
              </div>
            </div>

            {/* Rate & limits */}
            <div>
              <SectionHead>Rate &amp; limits</SectionHead>
              <div className="grid grid-cols-2 gap-x-3 gap-y-2.5 sm:grid-cols-4">
                <label className="col-span-2 text-[11px] text-slate-400">
                  Interval between sends
                  <div className="mt-1 flex gap-1">
                    <input
                      type="number"
                      min={intervalUnit === "min" ? 0.5 : 10}
                      step={intervalUnit === "min" ? 0.5 : 5}
                      value={
                        intervalUnit === "min"
                          ? Math.round((draft.intervalSec / 60) * 100) / 100
                          : draft.intervalSec
                      }
                      onChange={(e) => {
                        const n = Number(e.target.value);
                        const sec =
                          intervalUnit === "min" ? Math.round(n * 60) : Math.round(n);
                        editDraft({ intervalSec: sec });
                      }}
                      className="min-w-0 flex-1 rounded-md border border-white/10 bg-slate-950 px-2 py-1 text-xs text-slate-100 outline-none focus:border-cyan-400/40"
                    />
                    <select
                      value={intervalUnit}
                      onChange={(e) =>
                        setIntervalUnit(e.target.value as "sec" | "min")
                      }
                      className="rounded-md border border-white/10 bg-slate-950 px-1 py-1 text-xs text-slate-300 outline-none focus:border-cyan-400/40"
                    >
                      <option value="sec">sec</option>
                      <option value="min">min</option>
                    </select>
                  </div>
                  <span className="mt-0.5 block text-[10px] text-slate-600">
                    = {draft.intervalSec}s between each send
                  </span>
                </label>
                <label className="text-[11px] text-slate-400">
                  Jitter (±sec)
                  <input
                    type="number"
                    min={0}
                    value={draft.jitterSec}
                    onChange={(e) =>
                      editDraft({ jitterSec: Number(e.target.value) })
                    }
                    className="mt-1 w-full rounded-md border border-white/10 bg-slate-950 px-2 py-1 text-xs text-slate-100 outline-none focus:border-cyan-400/40"
                  />
                </label>
              </div>
            </div>

            {/* Follow-up strategy */}
            <div>
              <SectionHead>Follow-up strategy</SectionHead>
              <div className="space-y-2 rounded-lg border border-white/10 bg-slate-950/40 p-3">
                <p className="text-[11px] text-slate-300">
                  The pitch (message 2, with links) sends{" "}
                  <span className="text-cyan-300">only after a reply</span> —
                  automatically, in‑thread, within a few minutes. Non‑repliers
                  never get the link‑heavy pitch.
                </p>
                <label className="flex items-center gap-2 text-[11px] text-slate-300">
                  <input
                    type="checkbox"
                    checked={draft.bumpEnabled}
                    onChange={(e) => editDraft({ bumpEnabled: e.target.checked })}
                    className="accent-cyan-500"
                  />
                  Send a link‑free bump to non‑repliers
                </label>
                {draft.bumpEnabled && (
                  <label className="flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
                    after
                    <input
                      type="number"
                      min={1}
                      value={draft.bumpAfterDays}
                      onChange={(e) =>
                        editDraft({ bumpAfterDays: Number(e.target.value) })
                      }
                      className="w-16 rounded-md border border-white/10 bg-slate-950 px-2 py-1 text-xs text-slate-100 outline-none focus:border-cyan-400/40"
                    />
                    day{draft.bumpAfterDays === 1 ? "" : "s"} · rotates 30 bump
                    templates
                  </label>
                )}
              </div>
            </div>

            {/* Sending accounts */}
            <div>
              <div className="mb-2 flex items-baseline justify-between gap-2">
                <SectionHead>Sending accounts</SectionHead>
                <span className="text-[10px] text-slate-600">
                  {(draft.senderPool?.length ?? 0) === 0
                    ? "all accounts eligible"
                    : `${draft.senderPool.length} selected — openers use only these`}
                </span>
              </div>
              <div className="rounded-lg border border-white/10 bg-slate-950/40 p-3">
                {senders.length === 0 ? (
                  <p className="text-[10px] text-slate-600">
                    No sender identities configured.
                  </p>
                ) : (
                  <div className="space-y-1">
                    {senders.map((id) => {
                      const email = id.email.toLowerCase();
                      const pool = draft.senderPool ?? [];
                      const inPool = pool.includes(email);
                      const used = status?.sentBySender?.[email];
                      // While editing, show the cap being edited rather than
                      // the one the worker is currently running with.
                      const cap = effCapFor(draft, email);
                      const block = blockByEmail.get(email);
                      const commitCap = () => {
                        const raw = capDrafts[email];
                        if (raw === undefined) return;
                        setCapDrafts((d) => {
                          const n = { ...d };
                          delete n[email];
                          return n;
                        });
                        const v = Math.round(Number(raw));
                        const next = { ...(draft.senderCaps ?? {}) };
                        if (raw.trim() !== "" && Number.isFinite(v) && v > 0)
                          next[email] = v;
                        else delete next[email];
                        editDraft({ senderCaps: next });
                      };
                      return (
                        <label
                          key={email}
                          className="flex items-center gap-2 rounded px-1 py-0.5 text-[11px] text-slate-300 hover:bg-white/[0.03]"
                        >
                          <input
                            type="checkbox"
                            checked={inPool}
                            onChange={() => {
                              const next = inPool
                                ? pool.filter((x) => x !== email)
                                : [...pool, email];
                              editDraft({ senderPool: next });
                            }}
                            className="accent-cyan-500"
                          />
                          <span className="flex-1 truncate font-mono">{id.email}</span>
                          {inPool && used !== undefined && (
                            <span
                              className={
                                "shrink-0 tabular-nums text-[10px] " +
                                (cap > 0 && used >= cap
                                  ? "text-rose-300"
                                  : "text-slate-500")
                              }
                            >
                              {cap > 0 ? `${used}/${cap}` : used} today
                            </span>
                          )}
                          {block && (
                            // No Resume button here: this row is a <label>, so a
                            // nested button would toggle the pool checkbox. It
                            // lives in the banner above instead.
                            <span
                              title={`Gmail bounced this account with a policy block${
                                block.detail ? `: ${block.detail}` : ""
                              }. The queue skips it until ${resumeAt(block.until)}.`}
                              className="inline-flex shrink-0 items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-300"
                            >
                              <PauseIcon className="h-2.5 w-2.5" />
                              Blocked · resumes {resumeAt(block.until)}
                            </span>
                          )}
                          <span className="flex shrink-0 items-center gap-1 text-[10px] text-slate-600">
                            cap
                            <input
                              type="number"
                              min={0}
                              value={
                                capDrafts[email] ??
                                (draft.senderCaps?.[email] || "")
                              }
                              placeholder="∞"
                              onChange={(e) =>
                                setCapDrafts((d) => ({
                                  ...d,
                                  [email]: e.target.value,
                                }))
                              }
                              onBlur={commitCap}
                              onKeyDown={(e) => {
                                if (e.key === "Enter")
                                  (e.target as HTMLInputElement).blur();
                              }}
                              title="This account's own daily cap (blank = no limit)"
                              className="w-14 rounded-md border border-white/10 bg-slate-950 px-1.5 py-0.5 text-center text-[11px] text-slate-100 outline-none placeholder:text-slate-600 focus:border-cyan-400/40"
                            />
                          </span>
                        </label>
                      );
                    })}
                  </div>
                )}
                <div className="mt-3 border-t border-white/5 pt-3">
                  <p className="mb-2 text-[10px] text-slate-600">
                    The <span className="text-slate-400">cap</span> box sets an
                    account&apos;s own daily limit, to match its warm-up status.
                    Blank = no limit for that account.
                  </p>
                  <label className="flex flex-col justify-start text-[11px] text-slate-400">
                    <span className="flex items-center gap-2 text-slate-300">
                      <input
                        type="checkbox"
                        checked={draft.rotateSenders}
                        onChange={(e) =>
                          editDraft({ rotateSenders: e.target.checked })
                        }
                        className="accent-cyan-500"
                      />
                      Rotate identities
                    </span>
                    <span className="ml-6 mt-0.5 text-[10px] text-slate-600">
                      Only used when no accounts are selected above.
                    </span>
                  </label>
                </div>
              </div>
            </div>

            {/* Opener rotation — rewrite the queued items' openers in place */}
            <div>
              <div className="mb-2 flex items-baseline justify-between gap-2">
                <SectionHead>Opener rotation</SectionHead>
                <span className="text-[10px] text-slate-600">
                  rewrites the {num("queued")} queued item
                  {num("queued") === 1 ? "" : "s"} in place · keeps follow-ups ·
                  applies on click, not on OK
                </span>
              </div>
              <div className="rounded-lg border border-white/10 bg-slate-950/40 p-3">
                {openers.length === 0 ? (
                  <p className="text-[10px] text-slate-600">No opener templates.</p>
                ) : (
                  <>
                    <div className="mb-1.5 flex items-center justify-between">
                      <span className="text-[10px] text-slate-500">
                        {selectedRotate.length} of {openers.length} selected
                      </span>
                      <button
                        type="button"
                        onClick={() =>
                          setRotateIds(
                            allRotateOn ? [] : openers.map((o) => o.id),
                          )
                        }
                        className="text-[10px] text-slate-400 transition hover:text-cyan-300"
                      >
                        {allRotateOn ? "Clear all" : "Select all"}
                      </button>
                    </div>
                    <div className="max-h-40 space-y-0.5 overflow-y-auto">
                      {openers.map((o) => {
                        const on = rotateIds.includes(o.id);
                        return (
                          <label
                            key={o.id}
                            className="flex items-center gap-2 rounded px-1.5 py-1 text-xs text-slate-200 transition hover:bg-white/[0.03]"
                          >
                            <input
                              type="checkbox"
                              checked={on}
                              onChange={() => toggleRotate(o.id)}
                              className="accent-cyan-500"
                            />
                            <span className="truncate">{o.label}</span>
                          </label>
                        );
                      })}
                    </div>
                    <div className="mt-3 flex items-center justify-between gap-2 border-t border-white/5 pt-3">
                      <span
                        className={
                          "text-[11px] " +
                          (selectedRotate.length === 0
                            ? "text-rose-300"
                            : rotatePerDay > 7
                              ? "text-amber-300"
                              : rotatePerDay < 5
                                ? "text-slate-400"
                                : "text-emerald-300")
                        }
                      >
                        {selectedRotate.length === 0
                          ? "select at least one"
                          : `≈${Math.round(rotatePerDay)} send${
                              Math.round(rotatePerDay) === 1 ? "" : "s"
                            }/template/day`}
                      </span>
                      <button
                        type="button"
                        onClick={() => void applyOpenerRotation()}
                        disabled={
                          rotating ||
                          selectedRotate.length === 0 ||
                          num("queued") === 0
                        }
                        className="rounded-full border border-cyan-400/30 bg-cyan-500/10 px-4 py-1.5 text-xs font-medium text-cyan-200 transition hover:border-cyan-300/70 hover:bg-cyan-500/20 disabled:opacity-40"
                      >
                        {rotating
                          ? "Rotating…"
                          : `Rotate ${num("queued")} queued`}
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
              </div>
              {/* OK applies every setting above in one PATCH. The one exception
                  is "Rotate queued", which rewrites queue items on click. */}
              <div className="flex items-center justify-end gap-2 border-t border-white/10 px-5 py-3">
                <span className="mr-auto text-[11px] text-slate-500">
                  {settingsDirty
                    ? "Unsaved changes — click OK to apply."
                    : rotatedQueued
                      ? "Openers already rotated. No other changes."
                      : "No changes."}
                </span>
                <button
                  type="button"
                  onClick={discardSettings}
                  disabled={savingSettings}
                  className="rounded-full border border-white/10 px-4 py-1.5 text-xs text-slate-400 transition hover:border-white/25 hover:text-white disabled:opacity-40"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void applySettings()}
                  disabled={savingSettings}
                  className="rounded-full border border-cyan-400/40 bg-cyan-500/15 px-6 py-1.5 text-xs font-medium text-cyan-100 transition hover:border-cyan-300/70 hover:bg-cyan-500/25 disabled:opacity-40"
                >
                  {savingSettings ? "Applying…" : "OK"}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Items */}
        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {loading ? (
            <p className="text-sm text-slate-400">Loading…</p>
          ) : items.length === 0 ? (
            <p className="text-sm text-slate-400">
              Queue is empty. Compose in the Send window and click Add to queue.
            </p>
          ) : (
            <div className="flex flex-col gap-1.5">
              {items.map((it) => {
                const eta = itemEta(
                  it,
                  Math.max(0, pendingOpenerIds.indexOf(it.id)),
                  dueBumpCount,
                );
                return (
                <div
                  key={it.id}
                  className="group flex items-center gap-3 rounded-lg border border-white/10 bg-slate-950/50 px-3 py-2 transition hover:border-white/20"
                >
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-cyan-500/25 to-slate-700 text-[11px] font-semibold text-cyan-100">
                    {(it.name.trim()[0] || it.toEmail.trim()[0] || "?").toUpperCase()}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="flex min-w-0 items-center gap-1.5 text-sm text-slate-100">
                      <span className="truncate">{it.toEmail}</span>
                      {it.ccEmail && (
                        <span
                          className="shrink-0 rounded border border-white/10 bg-white/5 px-1 py-px text-[10px] uppercase tracking-wide text-slate-400"
                          title={`Also CC'd: ${it.ccEmail}`}
                        >
                          cc
                        </span>
                      )}
                    </p>
                    <p className="truncate text-[11px] text-slate-500">
                      {(it.countryStd || it.timezone) && (
                        <span className="text-slate-400">
                          <CountryFlag
                            country={it.countryStd}
                            size={10}
                            className="mr-1 align-[-1px]"
                          />
                          {it.countryStd || it.timezone}
                          {localClock(it.timezone)
                            ? ` · ${localClock(it.timezone)} local`
                            : ""}
                          {" · "}
                        </span>
                      )}
                      {it.opSubject && (
                        <span className="italic text-slate-400">“{it.opSubject}”</span>
                      )}
                      {it.lastError && it.lastError !== "canceled" ? (
                        <span className="text-rose-300"> · {it.lastError}</span>
                      ) : null}
                    </p>
                  </div>
                  {eta && (
                    <span
                      className="shrink-0 whitespace-nowrap text-[11px] tabular-nums text-cyan-300/80"
                      title={eta.title}
                    >
                      {eta.text}
                    </span>
                  )}
                  <QueueStatusPill item={it} />
                  {it.opStatus === "pending" && (
                    <button
                      type="button"
                      onClick={() => void itemAction(it.id, "cancel")}
                      title="Cancel this send"
                      aria-label="Cancel this send"
                      className="shrink-0 rounded-md p-1 text-slate-600 opacity-0 transition hover:text-rose-300 focus:opacity-100 group-hover:opacity-100"
                    >
                      <CloseIcon className="h-3.5 w-3.5" />
                    </button>
                  )}
                  {canRetry(it) && (
                    <button
                      type="button"
                      onClick={() => void itemAction(it.id, "retry")}
                      title={
                        it.lastError === "canceled"
                          ? "Put this canceled send back in the queue"
                          : "Retry this failed send"
                      }
                      aria-label="Retry this send"
                      className="shrink-0 rounded-md p-1 text-slate-600 opacity-0 transition hover:text-cyan-300 focus:opacity-100 group-hover:opacity-100"
                    >
                      <RetryIcon className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-white/10 px-5 py-3">
          <button
            type="button"
            onClick={() => void retryAllFailed()}
            disabled={num("failed") === 0}
            className="mr-auto rounded-full border border-cyan-500/30 bg-cyan-500/10 px-4 py-1.5 text-xs text-cyan-200 transition hover:border-cyan-400/60 hover:bg-cyan-500/20 disabled:opacity-40 disabled:hover:border-cyan-500/30 disabled:hover:bg-cyan-500/10"
            title="Put every failed and canceled item back in the queue"
          >
            Retry failed{num("failed") > 0 ? ` (${num("failed")})` : ""}
          </button>
          <button
            type="button"
            onClick={() => void cancelAllFollowups()}
            disabled={num("followupsPending") === 0}
            className="rounded-full border border-white/10 px-4 py-1.5 text-xs text-slate-400 transition hover:border-amber-400/40 hover:text-amber-200 disabled:opacity-40 disabled:hover:border-white/10 disabled:hover:text-slate-400"
            title="Skip every follow-up that hasn't sent yet"
          >
            Stop pending follow-ups{num("followupsPending") > 0 ? ` (${num("followupsPending")})` : ""}
          </button>
          <button
            type="button"
            onClick={() => void cancelAllQueued()}
            disabled={num("queued") === 0}
            className="rounded-full border border-rose-500/30 bg-rose-500/10 px-4 py-1.5 text-xs text-rose-200 transition hover:border-rose-400/60 hover:bg-rose-500/20 disabled:opacity-40 disabled:hover:border-rose-500/30 disabled:hover:bg-rose-500/10"
            title="Cancel every not-yet-sent opener in the queue"
          >
            Cancel all queued{num("queued") > 0 ? ` (${num("queued")})` : ""}
          </button>
          <button
            type="button"
            onClick={() => void clearFinished()}
            className="rounded-full border border-white/10 px-4 py-1.5 text-xs text-slate-400 transition hover:border-white/25 hover:text-white"
          >
            Clear sent &amp; canceled
          </button>
        </div>
      </div>
    </div>
  );
}
