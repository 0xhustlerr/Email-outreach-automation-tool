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
  name: string;
  countryStd: string;
  timezone: string;
  tzSource: string;
  opSubject: string;
  opStatus: StepStatus;
  opSendAfter: string | null;
  hasFollow: boolean;
  fuStatus: StepStatus;
  fuDelayMin: number;
  fuSendAfter: string | null;
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
  fuDelayMin: number;
  localTimeSend: boolean;
  localStart: string;
  localEnd: string;
  senderPool: string[];
  perSenderCap: number;
  bumpEnabled: boolean;
  bumpAfterDays: number;
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
  perSenderCap?: number;
  senderPool?: string[];
  sentBySender?: Record<string, number>;
  waitingForSender?: number;
};

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

function MailIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m3 7 9 7 9-7" />
    </svg>
  );
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
      return pill("⏳ Follow-up", "border-indigo-400/30 bg-indigo-500/15 text-indigo-200", "Follow-up scheduled");
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
      status.nextInSec !== null
    ) {
      setCountdown(status.nextInSec);
    } else {
      setCountdown(null);
    }
  }, [status]);

  // …and tick it down every second between polls. Display-only — this never
  // touches the running queue worker.
  const counting = countdown !== null;
  useEffect(() => {
    if (!counting) return;
    const id = window.setInterval(() => {
      setCountdown((c) => (c === null ? null : Math.max(0, c - 1)));
    }, 1000);
    return () => window.clearInterval(id);
  }, [counting]);

  // Ticking clock for per-item countdowns (display only).
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  // Per-item estimated send time. Follow-ups have an exact eligibility time
  // (fuSendAfter); pending openers are estimated from their position in the
  // drip (one send per interval, follow-ups first).
  const itemEta = (
    item: QueueItem,
    openerRank: number,
    dueFollowups: number,
  ): string | null => {
    if (!status || !settings) return null;
    const intervalMs = Math.max(5, settings.intervalSec) * 1000;

    if (item.fuStatus === "scheduled") {
      const t = item.fuSendAfter ? new Date(item.fuSendAfter).getTime() : now;
      const remain = Math.max(0, Math.round((t - now) / 1000));
      return `follow-up in ${fmtCountdown(remain)}`;
    }

    if (item.opStatus === "pending") {
      // When paused, the header already says so — don't repeat it on every row.
      if (!status.enabled) return null;
      if (status.capReached) return "after cap resets";
      if (!status.withinWindow) return "next window";
      const startMs = item.opSendAfter
        ? new Date(item.opSendAfter).getTime()
        : now;
      const base = Math.max(now, startMs);
      // Due follow-ups jump ahead; then openers in id order.
      const eta = base + (dueFollowups + openerRank) * intervalMs;
      const remain = Math.max(0, Math.round((eta - now) / 1000));
      return `~ sends in ${fmtCountdown(remain)}`;
    }
    return null;
  };

  // Precompute drip order for the estimate.
  const pendingOpenerIds = items
    .filter((it) => it.opStatus === "pending")
    .map((it) => it.id)
    .sort((a, b) => a - b);
  const dueFollowupCount = items.filter(
    (it) =>
      it.fuStatus === "scheduled" &&
      it.fuSendAfter !== null &&
      new Date(it.fuSendAfter).getTime() <= now,
  ).length;

  // Total emails still to leave the queue (pending openers + their follow-ups
  // + already-scheduled follow-ups).
  const remainingSends = useMemo(() => {
    let n = 0;
    for (const it of items) {
      if (it.opStatus === "pending") n += 1 + (it.hasFollow ? 1 : 0);
      else if (it.fuStatus === "scheduled") n += 1;
    }
    return n;
  }, [items]);

  // Estimate when the whole queue finishes: walk day-by-day respecting the
  // window hours, one send per interval, and the daily cap (by client).
  const finishEstimate = useMemo(() => {
    if (!settings || !status || remainingSends === 0) return null;
    const parseHm = (hm: string) => {
      const [h, m] = hm.split(":").map((x) => parseInt(x, 10));
      return (h || 0) * 60 + (m || 0);
    };
    const intervalSec = Math.max(5, settings.intervalSec);
    const startMin = parseHm(settings.windowStart);
    const endMin = parseHm(settings.windowEnd);
    let winMin = endMin - startMin;
    if (winMin <= 0) winMin += 1440;
    const intervalCapPerDay = Math.max(1, Math.floor((winMin * 60) / intervalSec));

    const openers = items.filter((it) => it.opStatus === "pending").length;
    const avg = openers > 0 ? remainingSends / openers : 1;
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
    // Today's cap headroom (clients), converted to sends via the avg.
    // status.dailyCap is the effective total (per-sender cap × active accounts).
    let capSendsToday = Math.round(
      Math.max(0, status.dailyCap - status.sentToday) * avg,
    );
    let guard = 0;
    while (remaining > 0 && guard++ < 400) {
      t = advance(t);
      const secsLeft = Math.max(0, (winEndOf(t).getTime() - t.getTime()) / 1000);
      const slots = Math.min(Math.floor(secsLeft / intervalSec), capSendsToday);
      if (slots <= 0) {
        const nd = new Date(t);
        nd.setDate(nd.getDate() + 1);
        t = winStartOf(nd);
        capSendsToday = Math.round(status.dailyCap * avg);
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
      capSendsToday = Math.round(settings.dailyCap * avg);
    }
    return remaining === 0 ? t : null;
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
    const accts = (poolCount || senders.length) || 1;
    const cap =
      settings.perSenderCap > 0
        ? `${settings.perSenderCap}/sender (${accts} accts)`
        : `${settings.dailyCap}/day`;
    return [
      `${label12h(settings.windowStart)}–${label12h(settings.windowEnd)}`,
      `${settings.intervalSec}s`,
      cap,
      settings.localTimeSend ? "local time" : null,
    ]
      .filter(Boolean)
      .join("  ·  ");
  }, [settings, senders.length]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Esc closes the settings modal first if it's open, else the queue.
      if (settingsOpen) setSettingsOpen(false);
      else onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, settingsOpen]);

  const patchSettings = async (patch: Partial<QueueSettings>) => {
    setSettings((s) => (s ? { ...s, ...patch } : s));
    await fetch("/api/queue", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }).catch(() => {});
    void refresh();
  };

  const itemAction = async (id: number, action: "cancel" | "retry") => {
    await fetch(`/api/queue?action=${action}&id=${id}`, { method: "PATCH" }).catch(
      () => {},
    );
    void refresh();
  };

  const clearFinished = async () => {
    await fetch("/api/queue?action=clear-finished", { method: "PATCH" }).catch(
      () => {},
    );
    void refresh();
  };

  const num = (v: string) => (counts[v] ?? 0);

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
  const activeSenders =
    ((settings?.senderPool?.length ?? 0) || senders.length) || 1;
  // The overall day ceiling = per-sender cap × active accounts (legacy total
  // when no per-sender cap is set).
  const totalDailyCap = settings
    ? settings.perSenderCap > 0
      ? settings.perSenderCap * activeSenders
      : settings.dailyCap
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
      className="fade-in fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
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
            <span className="ml-auto tabular-nums">
              {!status.enabled
                ? "Paused"
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
                    "h-full rounded-full transition-all duration-500 " +
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
                <span>
                  <b className="text-slate-200">{remainingSends}</b> left to send
                </span>
                {finishLabel && (
                  <span title="Estimate — depends on window, interval & daily cap">
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

        {/* Settings — opens a modal so the queued contacts stay in view */}
        {settings && (
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
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
        {settings && settingsOpen && (
          <div
            className="fade-in fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) setSettingsOpen(false);
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
                  onClick={() => setSettingsOpen(false)}
                  className="rounded-full p-2 text-slate-400 transition hover:bg-white/5 hover:text-white"
                  title="Close"
                  aria-label="Close"
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
                    value={toLocalInput(settings.startAt)}
                    onChange={(e) =>
                      void patchSettings({ startAt: fromLocalInput(e.target.value) })
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
                    value={settings.windowStart}
                    onChange={(v) => void patchSettings({ windowStart: v })}
                  />
                </label>
                <label className="text-[11px] text-slate-400">
                  Window end
                  <TimeSelect
                    value={settings.windowEnd}
                    onChange={(v) => void patchSettings({ windowEnd: v })}
                  />
                </label>
                <label className="col-span-2 flex flex-col text-[11px] text-slate-300 sm:col-span-4">
                  <span className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={settings.localTimeSend}
                      onChange={(e) =>
                        void patchSettings({ localTimeSend: e.target.checked })
                      }
                      className="accent-cyan-500"
                    />
                    Send by each recipient&apos;s local time
                  </span>
                  <span className="ml-6 mt-0.5 text-[10px] text-slate-600">
                    Uses their resolved timezone; unknown ones use the window above.
                  </span>
                </label>
                {settings.localTimeSend && (
                  <>
                    <label className="col-span-2 text-[11px] text-slate-400">
                      Recipient local start
                      <TimeSelect
                        value={settings.localStart}
                        onChange={(v) => void patchSettings({ localStart: v })}
                      />
                    </label>
                    <label className="col-span-2 text-[11px] text-slate-400">
                      Recipient local end
                      <TimeSelect
                        value={settings.localEnd}
                        onChange={(v) => void patchSettings({ localEnd: v })}
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
                          ? Math.round((settings.intervalSec / 60) * 100) / 100
                          : settings.intervalSec
                      }
                      onChange={(e) => {
                        const n = Number(e.target.value);
                        const sec =
                          intervalUnit === "min" ? Math.round(n * 60) : Math.round(n);
                        void patchSettings({ intervalSec: sec });
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
                    = {settings.intervalSec}s between each send
                  </span>
                </label>
                <label className="text-[11px] text-slate-400">
                  Jitter (±sec)
                  <input
                    type="number"
                    min={0}
                    value={settings.jitterSec}
                    onChange={(e) =>
                      void patchSettings({ jitterSec: Number(e.target.value) })
                    }
                    className="mt-1 w-full rounded-md border border-white/10 bg-slate-950 px-2 py-1 text-xs text-slate-100 outline-none focus:border-cyan-400/40"
                  />
                </label>
                <label className="text-[11px] text-slate-400">
                  Daily cap / sender
                  <input
                    type="number"
                    min={1}
                    value={settings.perSenderCap}
                    onChange={(e) =>
                      void patchSettings({ perSenderCap: Number(e.target.value) })
                    }
                    className="mt-1 w-full rounded-md border border-white/10 bg-slate-950 px-2 py-1 text-xs text-slate-100 outline-none focus:border-cyan-400/40"
                  />
                  <span className="mt-0.5 block text-[10px] text-slate-600">
                    per Gmail sender
                    {activeSenders > 1
                      ? ` · ×${activeSenders} = ${
                          settings.perSenderCap * activeSenders
                        }/day`
                      : ""}
                  </span>
                </label>
                <label className="col-span-2 text-[11px] text-slate-400">
                  Default follow-up delay (min)
                  <input
                    type="number"
                    min={1}
                    value={settings.fuDelayMin}
                    onChange={(e) =>
                      void patchSettings({ fuDelayMin: Number(e.target.value) })
                    }
                    className="mt-1 w-full rounded-md border border-white/10 bg-slate-950 px-2 py-1 text-xs text-slate-100 outline-none focus:border-cyan-400/40"
                  />
                  <span className="mt-0.5 block text-[10px] text-slate-600">
                    only used if you turn the timed pitch back on
                  </span>
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
                    checked={settings.bumpEnabled}
                    onChange={(e) =>
                      void patchSettings({ bumpEnabled: e.target.checked })
                    }
                    className="accent-cyan-500"
                  />
                  Send a link‑free bump to non‑repliers
                </label>
                {settings.bumpEnabled && (
                  <label className="flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
                    after
                    <input
                      type="number"
                      min={1}
                      value={settings.bumpAfterDays}
                      onChange={(e) =>
                        void patchSettings({ bumpAfterDays: Number(e.target.value) })
                      }
                      className="w-16 rounded-md border border-white/10 bg-slate-950 px-2 py-1 text-xs text-slate-100 outline-none focus:border-cyan-400/40"
                    />
                    day{settings.bumpAfterDays === 1 ? "" : "s"} · rotates 30 bump
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
                  {(settings.senderPool?.length ?? 0) === 0
                    ? "all accounts eligible"
                    : `${settings.senderPool.length} selected — openers use only these`}
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
                      const pool = settings.senderPool ?? [];
                      const inPool = pool.includes(email);
                      const used = status?.sentBySender?.[email];
                      const cap = settings.perSenderCap;
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
                              void patchSettings({ senderPool: next });
                            }}
                            className="accent-cyan-500"
                          />
                          <span className="flex-1 truncate font-mono">{id.email}</span>
                          {inPool && cap > 0 && used !== undefined && (
                            <span
                              className={
                                "shrink-0 tabular-nums text-[10px] " +
                                (used >= cap ? "text-rose-300" : "text-slate-500")
                              }
                            >
                              {used}/{cap} today
                            </span>
                          )}
                        </label>
                      );
                    })}
                  </div>
                )}
                <div className="mt-3 border-t border-white/5 pt-3">
                  <p className="mb-2 text-[10px] text-slate-600">
                    Each account&apos;s daily limit is the{" "}
                    <span className="text-slate-400">Daily cap / sender</span> set
                    under Rate &amp; limits (meters above).
                  </p>
                  <label className="flex flex-col justify-start text-[11px] text-slate-400">
                    <span className="flex items-center gap-2 text-slate-300">
                      <input
                        type="checkbox"
                        checked={settings.rotateSenders}
                        onChange={(e) =>
                          void patchSettings({ rotateSenders: e.target.checked })
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
                  {num("queued") === 1 ? "" : "s"} in place · keeps follow-ups
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
                  dueFollowupCount,
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
                    <p className="truncate text-sm text-slate-100">{it.toEmail}</p>
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
                    <span className="shrink-0 whitespace-nowrap text-[11px] tabular-nums text-cyan-300/80">
                      {eta}
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
                </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-white/10 px-5 py-3">
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
