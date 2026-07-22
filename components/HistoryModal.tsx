"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import type { SheetHistoryRow } from "@/lib/sheets";
import GmailAvatar from "@/components/GmailAvatar";
import { CountryFlag } from "@/components/CountryFlag";
import HistoryCampaignPanel from "@/components/HistoryCampaignPanel";

function PhoneBadgeIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.18z" />
    </svg>
  );
}

// Merged per-row status: the single most useful signal — replied? follow-up
// due? 2-step done? just sent? failed? — as one pill. Replaces the separate
// "Sent" + "Replied" columns and the inline contact-cell ticks (status was
// previously encoded in three places). Replied always wins, since a reply is
// the outcome that changes what you do next.
function RowStatus({
  replied,
  tick,
}: {
  replied: boolean;
  tick?: { opSent: boolean; fuSent: boolean; hasFollow: boolean; failed: boolean };
}) {
  const pill = (text: string, cls: string, title: string) => (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${cls}`}
      title={title}
    >
      {text}
    </span>
  );
  if (replied) {
    return (
      <span
        className="inline-flex items-center gap-1.5 rounded-full border border-emerald-400/30 bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold text-emerald-300"
        title="This contact replied"
      >
        {/* Static: this badge renders once PER REPLIED ROW, so a pulsing dot
            here meant one infinite animation per row in a long history. */}
        <span
          className="h-1.5 w-1.5 rounded-full bg-emerald-400"
          aria-hidden
        />
        Replied
      </span>
    );
  }
  if (tick?.failed) {
    return pill("⚠ Failed", "border-rose-400/30 bg-rose-500/15 text-rose-300", "A send step failed");
  }
  if (tick?.hasFollow && !tick.fuSent) {
    return pill(
      "⏳ Follow-up",
      "border-amber-400/30 bg-amber-500/15 text-amber-300",
      "Opener sent · follow-up pending",
    );
  }
  if (tick?.hasFollow && tick.fuSent) {
    return pill(
      "✓✓ 2-step",
      "border-cyan-400/30 bg-cyan-500/15 text-cyan-200",
      "Opener + follow-up sent · awaiting reply",
    );
  }
  return pill(
    "✓ Sent",
    "border-white/10 bg-white/5 text-slate-400",
    "Sent · no reply yet",
  );
}

function nameInitial(name: string, email: string): string {
  const n = (name || "").trim();
  if (n) return n[0]!.toUpperCase();
  const e = (email || "").trim();
  return e ? e[0]!.toUpperCase() : "?";
}

type HistorySortKey =
  | "no"
  | "date"
  | "name"
  | "country"
  | "contact"
  | "site"
  | "sender"
  | "link"
  | "sent"
  | "active";

type DatePresetId =
  | "today"
  | "yesterday"
  | "last7"
  | "last14"
  | "last30"
  | "last90"
  | "last365"
  | "lastMonth"
  | "custom";

const DATE_PRESETS: { id: DatePresetId; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "yesterday", label: "Yesterday" },
  { id: "last7", label: "Last 7 Days" },
  { id: "last14", label: "Last 14 Days" },
  { id: "last30", label: "Last 30 Days" },
  { id: "last90", label: "Last 90 Days" },
  { id: "last365", label: "Last 365 Days" },
  { id: "lastMonth", label: "Last Month" },
];

const SENDER_PALETTE: Record<string, { text: string; bg: string; border: string }> = {
  "imagesatomic@gmail.com": {
    text: "text-sky-300",
    bg: "bg-sky-500/15",
    border: "border-sky-500/35",
  },
  "creativeengineer166@gmail.com": {
    text: "text-violet-300",
    bg: "bg-violet-500/15",
    border: "border-violet-500/35",
  },
  "dwicenterlifechanges@gmail.com": {
    text: "text-emerald-300",
    bg: "bg-emerald-500/15",
    border: "border-emerald-500/35",
  },
  "dvdkbrk@gmail.com": {
    text: "text-amber-300",
    bg: "bg-amber-500/15",
    border: "border-amber-500/35",
  },
};

const FALLBACK_SENDER_COLORS = [
  { text: "text-rose-300", bg: "bg-rose-500/15", border: "border-rose-500/35" },
  { text: "text-teal-300", bg: "bg-teal-500/15", border: "border-teal-500/35" },
  { text: "text-indigo-300", bg: "bg-indigo-500/15", border: "border-indigo-500/35" },
  { text: "text-orange-300", bg: "bg-orange-500/15", border: "border-orange-500/35" },
];

const COLUMNS: { key: HistorySortKey; label: string; sortable: boolean }[] = [
  { key: "date", label: "Date", sortable: true },
  { key: "name", label: "Name", sortable: true },
  { key: "country", label: "Country", sortable: true },
  { key: "contact", label: "Contact", sortable: true },
  { key: "site", label: "Site", sortable: true },
  { key: "sender", label: "Sender", sortable: true },
  { key: "link", label: "Link", sortable: true },
  { key: "active", label: "Status", sortable: true },
];

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
  if (!iso.trim()) return null;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : t;
}

function formatShortDate(d: Date): string {
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

function formatHistoryDate(iso: string): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// Short relative age for the "viewed" badge ("just now", "5m ago", "2h ago").
// Timezone-independent (computed from the age), so app/Gmail clock offsets don't
// skew it. Negative/skewed values collapse to "just now".
function formatViewedAgo(iso: string): string {
  if (!iso || !iso.trim()) return "";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const diffMs = Date.now() - t;
  if (diffMs < 45_000) return "just now";
  const min = Math.round(diffMs / 60_000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day}d ago`;
  if (day < 30) return `${Math.round(day / 7)}w ago`;
  return formatShortDate(new Date(t));
}

function senderLocalPart(email: string): string {
  const trimmed = email.trim();
  const at = trimmed.indexOf("@");
  return at > 0 ? trimmed.slice(0, at) : trimmed;
}

function presetRange(id: DatePresetId): { from: Date; to: Date; label: string } {
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);

  switch (id) {
    case "today":
      return { from: startOfDay(now), to: endOfDay(now), label: "Today" };
    case "yesterday":
      return {
        from: startOfDay(yesterday),
        to: endOfDay(yesterday),
        label: "Yesterday",
      };
    case "last7":
    case "last14":
    case "last30":
    case "last90":
    case "last365": {
      const days =
        id === "last7"
          ? 7
          : id === "last14"
            ? 14
            : id === "last30"
              ? 30
              : id === "last90"
                ? 90
                : 365;
      const to = endOfDay(yesterday);
      const from = startOfDay(yesterday);
      from.setDate(from.getDate() - (days - 1));
      return {
        from,
        to,
        label: DATE_PRESETS.find((p) => p.id === id)?.label ?? "Range",
      };
    }
    case "lastMonth": {
      const first = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const last = new Date(now.getFullYear(), now.getMonth(), 0);
      return {
        from: startOfDay(first),
        to: endOfDay(last),
        label: "Last Month",
      };
    }
    default:
      return { from: startOfDay(now), to: endOfDay(now), label: "Custom" };
  }
}

function senderStyle(email: string) {
  const key = email.trim().toLowerCase();
  if (SENDER_PALETTE[key]) return SENDER_PALETTE[key];
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash + key.charCodeAt(i) * 17) % 997;
  return FALLBACK_SENDER_COLORS[hash % FALLBACK_SENDER_COLORS.length];
}

function primaryEmail(contact: string): string {
  const part = contact.split(/[/,;]/)[0]?.trim() ?? "";
  const match = part.match(/[^\s@]+@[^\s@]+\.[^\s@]+/);
  return match ? match[0].toLowerCase() : part.toLowerCase();
}

type ContactProvider = "gmail" | "hotmail" | "outlook" | "proton" | "other";

function detectContactProvider(email: string): ContactProvider {
  const m = email.match(/@([^@\s]+)$/i);
  if (!m) return "other";
  const d = m[1].toLowerCase();

  if (d === "gmail.com" || d === "googlemail.com") return "gmail";
  if (d.startsWith("hotmail.") || d === "msn.com") return "hotmail";
  if (
    d.startsWith("outlook.") ||
    d.startsWith("live.") ||
    d === "outlook.com" ||
    d.endsWith(".onmicrosoft.com")
  ) {
    return "outlook";
  }
  if (
    d === "proton.me" ||
    d === "protonmail.com" ||
    d === "pm.me" ||
    d.startsWith("protonmail.")
  ) {
    return "proton";
  }
  return "other";
}

const CONTACT_PROVIDER_TEXT: Record<ContactProvider, string> = {
  gmail: "text-[#f28b82]",
  hotmail: "text-[#4fc3f7]",
  outlook: "text-[#60a5fa]",
  proton: "text-[#b4a0ff]",
  other: "text-slate-300",
};

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h + s.charCodeAt(i) * 31) % 100000;
  return h;
}

// --- Icons ----------------------------------------------------------------

function CloseIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      className={className}
    >
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}

function CalendarIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      className={className}
    >
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <path d="M16 2v4M8 2v4M3 10h18" />
    </svg>
  );
}

function GmailIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden>
      <path
        fill="#EA4335"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"
      />
      <path
        fill="#4285F4"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
      />
    </svg>
  );
}

function HotmailIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden>
      <rect x="3" y="5" width="18" height="14" rx="2" fill="#0072C6" />
      <path
        fill="#fff"
        d="M3 7.5 12 13l9-5.5V7l-9 5.5L3 7z"
      />
      <path fill="#FFB900" d="M12 13 3 7.5V9l9 5.5 9-5.5V7.5L12 13z" opacity="0.9" />
    </svg>
  );
}

function OutlookIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden>
      <path fill="#0078D4" d="M22 6.5v11L13 19V5l9 1.5z" />
      <path fill="#28A8EA" d="M13 5v14l-4 1.5V3.5L13 5z" />
      <rect x="2" y="6" width="9" height="12" rx="1.5" fill="#0078D4" />
      <ellipse cx="6.5" cy="12" rx="3" ry="3.5" fill="#fff" />
    </svg>
  );
}

function ProtonIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden>
      <circle cx="12" cy="12" r="10" fill="#6D4AFF" />
      <path
        fill="#fff"
        d="M12 6.5c2.8 0 4.5 1.6 4.5 3.6 0 1.4-.8 2.5-2.1 3.1L16.5 17h-2.2l-1.4-3.2h-.8L10.7 17H8.5l2.1-3.8c-1.3-.6-2.1-1.7-2.1-3.1 0-2 1.7-3.6 4.5-3.6zm0 1.8c-1.3 0-2 .7-2 1.8s.7 1.8 2 1.8 2-.7 2-1.8-.7-1.8-2-1.8z"
      />
    </svg>
  );
}

function GenericMailIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden>
      <rect x="3" y="5" width="18" height="14" rx="2" fill="#64748b" />
      <path fill="#94a3b8" d="M3 7.5 12 13l9-5.5V7l-9 5.5L3 7z" />
    </svg>
  );
}

function ContactProviderIcon({
  provider,
  className,
}: {
  provider: ContactProvider;
  className?: string;
}) {
  switch (provider) {
    case "gmail":
      return <GmailIcon className={className} />;
    case "hotmail":
      return <HotmailIcon className={className} />;
    case "outlook":
      return <OutlookIcon className={className} />;
    case "proton":
      return <ProtonIcon className={className} />;
    default:
      return <GenericMailIcon className={`${className} text-slate-400`} />;
  }
}

function ChevronIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      className={className}
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function SearchIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}

function SendIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="m3 11 18-8-8 18-2-8z" />
    </svg>
  );
}

function rowSearchHaystack(row: SheetHistoryRow): string {
  return [
    row.date,
    formatHistoryDate(row.date),
    row.name,
    row.country,
    row.contact,
    row.site,
    row.sender,
    row.link,
    row.active,
    row.replied,
    row.repliedAt,
  ]
    .join(" ")
    .toLowerCase();
}

function matchesSearch(row: SheetHistoryRow, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return rowSearchHaystack(row).includes(needle);
}

// --- Date range picker ------------------------------------------------------

function HistoryDateRangePicker({
  preset,
  rangeFrom,
  rangeTo,
  onApply,
}: {
  preset: DatePresetId;
  rangeFrom: Date;
  rangeTo: Date;
  onApply: (preset: DatePresetId, from: Date, to: Date) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draftPreset, setDraftPreset] = useState(preset);
  const [draftFrom, setDraftFrom] = useState(rangeFrom);
  const [draftTo, setDraftTo] = useState(rangeTo);
  const [viewMonth, setViewMonth] = useState(
    () => new Date(rangeFrom.getFullYear(), rangeFrom.getMonth(), 1),
  );
  const [pickStart, setPickStart] = useState<Date | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const rangeLabel = useMemo(() => {
    const p = DATE_PRESETS.find((x) => x.id === preset);
    const name =
      preset === "custom"
        ? "Custom"
        : (p?.label ?? "Range");
    return `${name} · ${formatShortDate(rangeFrom)} – ${formatShortDate(rangeTo)}`;
  }, [preset, rangeFrom, rangeTo]);

  useEffect(() => {
    if (!open) return;
    setDraftPreset(preset);
    setDraftFrom(rangeFrom);
    setDraftTo(rangeTo);
    setPickStart(null);
    setViewMonth(new Date(rangeFrom.getFullYear(), rangeFrom.getMonth(), 1));
  }, [open, preset, rangeFrom, rangeTo]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const selectPreset = (id: DatePresetId) => {
    const r = presetRange(id);
    setDraftPreset(id);
    setDraftFrom(r.from);
    setDraftTo(r.to);
    setPickStart(null);
    setViewMonth(new Date(r.from.getFullYear(), r.from.getMonth(), 1));
  };

  const onDayClick = (day: Date) => {
    const d = startOfDay(day);
    if (!pickStart) {
      setPickStart(d);
      setDraftFrom(d);
      setDraftTo(d);
      setDraftPreset("custom");
      return;
    }
    const a = pickStart.getTime() <= d.getTime() ? pickStart : d;
    const b = pickStart.getTime() <= d.getTime() ? d : pickStart;
    setDraftFrom(a);
    setDraftTo(b);
    setPickStart(null);
    setDraftPreset("custom");
  };

  const apply = () => {
    onApply(draftPreset, draftFrom, draftTo);
    setOpen(false);
  };

  const year = viewMonth.getFullYear();
  const month = viewMonth.getMonth();
  const firstDow = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const today = startOfDay(new Date());
  const fromMs = startOfDay(draftFrom).getTime();
  const toMs = endOfDay(draftTo).getTime();

  const cells: (Date | null)[] = [];
  for (let i = 0; i < firstDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push(new Date(year, month, d));
  }

  return (
    <div ref={panelRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex max-w-[min(100%,280px)] items-center gap-2 rounded-full border border-white/10 bg-slate-950/70 px-3 py-1.5 text-xs font-medium text-slate-200 transition hover:border-cyan-400/40 hover:text-white"
      >
        <CalendarIcon className="h-3.5 w-3.5 shrink-0 text-cyan-300" />
        <span className="truncate">{rangeLabel}</span>
        <ChevronIcon
          className={`h-3.5 w-3.5 shrink-0 text-slate-400 transition ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <div className="absolute right-0 top-full z-30 mt-2 flex w-[min(100vw-2rem,520px)] overflow-hidden rounded-xl border border-white/10 bg-slate-950 shadow-2xl shadow-black/60">
          <ul className="w-[140px] shrink-0 border-r border-white/5 bg-slate-900/80 py-2">
            {DATE_PRESETS.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => selectPreset(p.id)}
                  className={`w-full px-4 py-2 text-left text-xs transition ${
                    draftPreset === p.id
                      ? "bg-cyan-500/15 font-medium text-cyan-200"
                      : "text-slate-400 hover:bg-white/5 hover:text-slate-200"
                  }`}
                >
                  {p.label}
                </button>
              </li>
            ))}
          </ul>

          <div className="min-w-0 flex-1 p-4">
            <p className="mb-3 text-[11px] text-slate-500">
              {pickStart ? "Tap end date" : "Tap start date"}
            </p>
            <div className="mb-3 flex items-center justify-between">
              <button
                type="button"
                onClick={() =>
                  setViewMonth(new Date(year, month - 1, 1))
                }
                className="rounded p-1 text-slate-400 hover:bg-white/5 hover:text-slate-200"
                aria-label="Previous month"
              >
                ‹
              </button>
              <span className="text-sm font-medium text-slate-200">
                {viewMonth.toLocaleDateString(undefined, {
                  month: "long",
                  year: "numeric",
                })}
              </span>
              <button
                type="button"
                onClick={() =>
                  setViewMonth(new Date(year, month + 1, 1))
                }
                className="rounded p-1 text-slate-400 hover:bg-white/5 hover:text-slate-200"
                aria-label="Next month"
              >
                ›
              </button>
            </div>

            <div className="grid grid-cols-7 gap-0.5 text-center text-[10px] text-slate-500">
              {["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map((d) => (
                <div key={d} className="py-1 font-medium">
                  {d}
                </div>
              ))}
              {cells.map((day, i) => {
                if (!day) {
                  return <div key={`e-${i}`} />;
                }
                const ms = startOfDay(day).getTime();
                const inRange = ms >= fromMs && ms <= toMs;
                const isStart = ms === fromMs;
                const isEnd = ms === toMs;
                const isToday = ms === today.getTime();

                return (
                  <button
                    key={day.toISOString()}
                    type="button"
                    onClick={() => onDayClick(day)}
                    className={`relative py-1.5 text-xs transition ${
                      inRange ? "bg-blue-600/40 text-slate-100" : "text-slate-300 hover:bg-white/5"
                    } ${isStart || isEnd ? "font-semibold" : ""} ${
                      isToday && !inRange ? "ring-1 ring-cyan-400/50 ring-inset" : ""
                    } rounded-md`}
                  >
                    {(isStart || isEnd) && (
                      <span className="absolute inset-0.5 rounded-full bg-blue-500" />
                    )}
                    <span className="relative z-[1]">{day.getDate()}</span>
                  </button>
                );
              })}
            </div>

            <p className="mt-3 text-[10px] leading-relaxed text-slate-600">
              Last N days end yesterday (sheet export alignment).
            </p>

            <div className="mt-3 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-lg px-3 py-1.5 text-xs text-slate-400 hover:text-slate-200"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={apply}
                className="rounded-lg bg-cyan-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-cyan-500"
              >
                Apply
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// --- Main modal -------------------------------------------------------------

export default function HistoryModal({
  onClose,
  onSendRow,
  rows,
  loading,
  error,
  onRefresh,
}: {
  onClose: () => void;
  /** Opens compose modal prefilled from this history row. */
  onSendRow?: (row: SheetHistoryRow) => void;
  rows: SheetHistoryRow[];
  loading: boolean;
  error: string | null;
  onRefresh?: () => void;
}) {
  const initial = presetRange("today");
  const [sortKey, setSortKey] = useState<HistorySortKey>("date");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [datePreset, setDatePreset] = useState<DatePresetId>("today");
  const [rangeFrom, setRangeFrom] = useState(initial.from);
  const [rangeTo, setRangeTo] = useState(initial.to);
  const [copiedToast, setCopiedToast] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [campaignOpen, setCampaignOpen] = useState(false);
  const [selectedEmails, setSelectedEmails] = useState<Set<string>>(
    () => new Set(),
  );
  // When true the table shows exactly the selected contacts (across ALL
  // history, ignoring the date filter) so a bulk selection like
  // "Select non-replied (782)" is actually reviewable before you send.
  const [showSelectedOnly, setShowSelectedOnly] = useState(false);
  const copyTimerRef = useRef<number | null>(null);

  const toggleEmail = (email: string) => {
    setSelectedEmails((prev) => {
      const next = new Set(prev);
      if (next.has(email)) next.delete(email);
      else next.add(email);
      return next;
    });
  };

  const searchActive = searchQuery.trim().length > 0;

  // Special-contact lookup: email -> fallback channels (phones/telegrams).
  // Rows whose recipient has one get the green phone badge - meaning "no
  // reply? you can still call this one."
  const [fallbackByEmail, setFallbackByEmail] = useState<
    Map<string, { phones: string[]; telegrams: string[] }>
  >(() => new Map());
  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/contacts");
        const data = (await res.json()) as {
          ok?: boolean;
          contacts?: {
            emails: string[];
            phones: string[];
            telegrams: string[];
          }[];
        };
        if (!res.ok || !data.ok) return;
        const map = new Map<string, { phones: string[]; telegrams: string[] }>();
        for (const c of data.contacts ?? []) {
          if (c.phones.length === 0 && c.telegrams.length === 0) continue;
          for (const e of c.emails) {
            map.set(e.toLowerCase(), { phones: c.phones, telegrams: c.telegrams });
          }
        }
        setFallbackByEmail(map);
      } catch {
        // Badge is a bonus - history works fine without it.
      }
    })();
  }, []);

  // Two-step status ticks: email -> {opSent, fuSent, hasFollow, failed}.
  const [ticksByEmail, setTicksByEmail] = useState<
    Record<
      string,
      {
        opSent: boolean;
        fuSent: boolean;
        hasFollow: boolean;
        failed: boolean;
        opSentAt: string | null;
        fuSentAt: string | null;
      }
    >
  >({});
  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch("/api/sequence-ticks");
        const data = (await res.json()) as {
          ok?: boolean;
          ticks?: typeof ticksByEmail;
        };
        if (res.ok && data.ok) setTicksByEmail(data.ticks ?? {});
      } catch {
        // Ticks are a bonus.
      }
    };
    void load();
    const id = window.setInterval(load, 15000);
    return () => window.clearInterval(id);
  }, []);

  const copyToClipboard = async (text: string) => {
    const value = text.trim();
    if (!value || value === "-") return;
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = value;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    setCopiedToast(true);
    if (copyTimerRef.current) window.clearTimeout(copyTimerRef.current);
    copyTimerRef.current = window.setTimeout(() => setCopiedToast(false), 1800);
  };

  useEffect(() => {
    return () => {
      if (copyTimerRef.current) window.clearTimeout(copyTimerRef.current);
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const dateFilteredRows = useMemo(() => {
    const fromMs = rangeFrom.getTime();
    const toMs = rangeTo.getTime();
    return rows.filter((row) => {
      const ms = parseRowDateMs(row.date);
      if (ms === null) return false;
      return ms >= fromMs && ms <= toMs;
    });
  }, [rows, rangeFrom, rangeTo]);

  const displayRows = useMemo(() => {
    // Selection review takes precedence over the date range: show every
    // history row for the selected contacts. Search still narrows within them.
    if (showSelectedOnly) {
      const sel = rows.filter((row) => {
        const e = primaryEmail(row.contact);
        return e.includes("@") && selectedEmails.has(e);
      });
      return searchActive
        ? sel.filter((row) => matchesSearch(row, searchQuery))
        : sel;
    }
    const pool = searchActive ? rows : dateFilteredRows;
    if (!searchActive) return pool;
    return pool.filter((row) => matchesSearch(row, searchQuery));
  }, [rows, dateFilteredRows, searchActive, searchQuery, showSelectedOnly, selectedEmails]);

  const sortedRows = useMemo(() => {
    const copy = displayRows.map((row, index) => ({ row, index }));
    copy.sort((a, b) => {
      let cmp = 0;
      if (sortKey === "no" || sortKey === "sent") {
        cmp = a.index - b.index;
      } else if (sortKey === "date") {
        const at = parseRowDateMs(a.row.date) ?? 0;
        const bt = parseRowDateMs(b.row.date) ?? 0;
        cmp = at - bt;
      } else if (sortKey === "active") {
        const av = isYes(a.row.active) ? "1" : "0";
        const bv = isYes(b.row.active) ? "1" : "0";
        cmp = av.localeCompare(bv);
      } else {
        const av = (a.row[sortKey] ?? "").toString().toLowerCase();
        const bv = (b.row[sortKey] ?? "").toString().toLowerCase();
        cmp = av.localeCompare(bv);
      }
      return sortDir === "asc" ? cmp : -cmp;
    });
    return copy.map((x) => x.row);
  }, [displayRows, sortKey, sortDir]);

  // How many times each address appears in the full history (sent once, twice…).
  const sentCountByEmail = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) {
      const e = primaryEmail(r.contact);
      if (!e.includes("@")) continue;
      m.set(e, (m.get(e) ?? 0) + 1);
    }
    return m;
  }, [rows]);

  // Emails currently visible (for select-all).
  const visibleEmails = useMemo(() => {
    const set = new Set<string>();
    for (const r of sortedRows) {
      const e = primaryEmail(r.contact);
      if (e.includes("@")) set.add(e);
    }
    return set;
  }, [sortedRows]);

  const allVisibleSelected =
    visibleEmails.size > 0 &&
    [...visibleEmails].every((e) => selectedEmails.has(e));

  const toggleSelectAll = () => {
    setSelectedEmails((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) {
        for (const e of visibleEmails) next.delete(e);
      } else {
        for (const e of visibleEmails) next.add(e);
      }
      return next;
    });
  };

  // Contacts (deduped) that NEVER replied anywhere in history — a contact
  // counts as replied if any of its rows shows a reply.
  const repliedEmails = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) {
      if (isYes(r.active) || isYes(r.replied)) {
        const e = primaryEmail(r.contact);
        if (e.includes("@")) set.add(e);
      }
    }
    return set;
  }, [rows]);

  // Most-recent send timestamp per contact (across ALL history).
  const latestSendByEmail = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) {
      const e = primaryEmail(r.contact);
      if (!e.includes("@")) continue;
      const ms = parseRowDateMs(r.date);
      if (ms === null) continue;
      if (!m.has(e) || ms > (m.get(e) as number)) m.set(e, ms);
    }
    return m;
  }, [rows]);

  // TEMPORARY window for "select non-replied": last year up to 6 days ago —
  // skip the recent 6 days so we don't re-contact people just emailed.
  const NONREPLY_SKIP_RECENT_DAYS = 6;
  const NONREPLY_LOOKBACK_DAYS = 365;
  const selectableNonReplied = useMemo(() => {
    const now = Date.now();
    const recentCut = now - NONREPLY_SKIP_RECENT_DAYS * 86_400_000;
    const oldCut = now - NONREPLY_LOOKBACK_DAYS * 86_400_000;
    const out: string[] = [];
    for (const [email, last] of latestSendByEmail) {
      if (repliedEmails.has(email)) continue; // replied at some point
      if (last <= recentCut && last >= oldCut) out.push(email); // in window
    }
    return out;
  }, [latestSendByEmail, repliedEmails]);

  // Select exactly the deduped non-repliers inside that window, and flip the
  // table into review mode so the selection is visible (not filtered away by
  // the current date range).
  const selectNonReplied = () => {
    setSelectedEmails(new Set(selectableNonReplied));
    setShowSelectedOnly(true);
  };

  const deleteSelected = async () => {
    const emails = [...selectedEmails];
    if (emails.length === 0) return;
    if (
      !window.confirm(
        `Remove ${emails.length} contact${emails.length === 1 ? "" : "s"} from history? This hides their sends from this view.`,
      )
    ) {
      return;
    }
    try {
      const res = await fetch("/api/sheet-history", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ emails }),
      });
      const data = (await res.json()) as { ok?: boolean; removed?: number };
      if (res.ok && data.ok) {
        toast.success(`Removed ${data.removed ?? 0} row(s) from history.`);
        setSelectedEmails(new Set());
        setShowSelectedOnly(false);
        onRefresh?.();
      } else {
        toast.error("Failed to delete.");
      }
    } catch {
      toast.error("Failed to delete.");
    }
  };

  const toggleSort = (key: HistorySortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "date" || key === "no" ? "desc" : "asc");
    }
  };

  const sortIndicator = (key: HistorySortKey) => {
    if (sortKey !== key) return null;
    return (
      <span className="ml-1 text-cyan-400">
        {sortDir === "asc" ? "↑" : "↓"}
      </span>
    );
  };

  const copyCell = (
    copyText: string,
    children: ReactNode,
    className: string,
  ) => {
    const empty = !copyText.trim();
    if (empty) {
      return <td className={`${className} text-slate-600`}>-</td>;
    }
    return (
      <td
        className={`${className} cursor-pointer transition hover:bg-cyan-500/10`}
        title="Click to copy"
        onClick={() => void copyToClipboard(copyText)}
      >
        {children}
      </td>
    );
  };

  const contactCell = (contact: string) => {
    const display = contact.trim() || "-";
    if (!contact.trim()) {
      return <td className="truncate px-3 py-3 text-slate-600">-</td>;
    }
    const email = primaryEmail(contact);
    const provider = email.includes("@")
      ? detectContactProvider(email)
      : "other";
    const fallback = email.includes("@")
      ? fallbackByEmail.get(email.toLowerCase())
      : undefined;
    const fallbackTitle = fallback
      ? [
          fallback.phones.length ? `📞 ${fallback.phones.join(", ")}` : "",
          fallback.telegrams.length
            ? `✈ ${fallback.telegrams.map((t) => `@${t.replace(/^@/, "")}`).join(", ")}`
            : "",
        ]
          .filter(Boolean)
          .join("  ")
      : "";
    return (
      <td
        className="cursor-pointer truncate px-3 py-3 transition hover:bg-cyan-500/10"
        title="Click to copy"
        onClick={() => void copyToClipboard(contact)}
      >
        <span className="inline-flex max-w-full items-center gap-1.5">
          <ContactProviderIcon
            provider={provider}
            className="h-3.5 w-3.5 shrink-0"
          />
          <span
            className={`truncate font-mono text-xs ${CONTACT_PROVIDER_TEXT[provider]}`}
          >
            {display}
          </span>
          {(() => {
            const n = email.includes("@")
              ? (sentCountByEmail.get(email) ?? 0)
              : 0;
            return n > 1 ? (
              <span
                className="shrink-0 rounded-full border border-amber-400/40 bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-300"
                title={`This address has been emailed ${n} times`}
                onClick={(e) => e.stopPropagation()}
              >
                {n}×
              </span>
            ) : null;
          })()}
          {fallback && (
            <span
              className="inline-flex shrink-0 items-center gap-0.5 rounded-full border border-emerald-400/40 bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-300"
              title={`Fallback contact available - ${fallbackTitle}`}
              onClick={(e) => e.stopPropagation()}
            >
              <PhoneBadgeIcon className="h-3 w-3" />
              {fallback.phones.length > 0 ? fallback.phones.length : ""}
            </span>
          )}
        </span>
      </td>
    );
  };

  const nameCell = (row: SheetHistoryRow) => {
    const display = row.name.trim() || "-";
    const email = primaryEmail(row.contact);
    const canSend = !!onSendRow && email.includes("@");

    const avatar = (
      <GmailAvatar
        email={email}
        size={24}
        className="rounded-full"
        fallback={
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-cyan-500/30 to-slate-700 text-[10px] font-semibold text-cyan-100">
            {nameInitial(row.name, email)}
          </span>
        }
      />
    );

    return (
      <td
        className="cursor-pointer overflow-hidden px-3 py-3 transition hover:bg-cyan-500/10"
        title={canSend ? "Click to send email" : "Click to copy"}
        onClick={() => (canSend ? onSendRow(row) : void copyToClipboard(row.name))}
      >
        <span className="flex min-w-0 flex-col gap-1">
          <span className="flex min-w-0 items-center gap-2">
            {avatar}
            <span
              className={
                "truncate font-medium transition " +
                (canSend ? "text-cyan-200 hover:text-cyan-100" : "text-slate-200")
              }
            >
              {display}
            </span>
          </span>
          {(row.openedAt ?? "").trim() &&
            (() => {
              const hot = (row.openCount ?? 0) > 3;
              const rel = formatViewedAgo(row.openedAt ?? "");
              const times =
                row.openCount && row.openCount > 1 ? ` · ${row.openCount}×` : "";
              return (
                <span
                  className={
                    "inline-flex max-w-full items-center gap-1 self-start overflow-hidden rounded-full px-1.5 py-0.5 text-[10px] font-semibold leading-none ring-1 ring-inset ring-white/10 " +
                    (hot
                      ? "border border-orange-400/50 bg-gradient-to-b from-orange-500/30 to-amber-500/10 text-orange-100 shadow-[0_0_10px_-3px_rgba(251,146,60,0.85)]"
                      : "border border-violet-400/40 bg-gradient-to-b from-violet-500/25 to-fuchsia-500/10 text-violet-100 shadow-[0_0_10px_-3px_rgba(167,139,250,0.75)]")
                  }
                  title={`${hot ? "Hot lead — viewed" : "Viewed"} ${rel}${times}`}
                  aria-label={`${hot ? "Hot, viewed" : "Viewed"} ${rel}`}
                >
                  {hot ? (
                    <svg viewBox="0 0 24 24" className="h-3 w-3 shrink-0 drop-shadow-[0_0_3px_rgba(251,191,36,0.8)]" fill="currentColor" aria-hidden="true">
                      <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z" />
                    </svg>
                  ) : (
                    <svg viewBox="0 0 24 24" className="h-3 w-3 shrink-0 drop-shadow-[0_0_3px_rgba(216,180,254,0.7)]" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
                      <circle cx="12" cy="12" r="2.6" />
                    </svg>
                  )}
                  <span className="whitespace-nowrap">{rel}</span>
                  {row.openCount && row.openCount > 1 ? (
                    <span className="shrink-0 tabular-nums tracking-tight opacity-70">
                      {row.openCount}×
                    </span>
                  ) : null}
                </span>
              );
            })()}
        </span>
      </td>
    );
  };

  const periodLabel = useMemo(() => {
    if (searchActive) return "All history (search)";
    const p = DATE_PRESETS.find((x) => x.id === datePreset);
    return datePreset === "custom"
      ? `${formatShortDate(rangeFrom)} – ${formatShortDate(rangeTo)}`
      : (p?.label ?? "Selected period");
  }, [searchActive, datePreset, rangeFrom, rangeTo]);

  const periodCount = searchActive ? sortedRows.length : dateFilteredRows.length;
  const displayCount = sortedRows.length;

  const senderCell = (sender: string) => {
    const display = sender.trim() || "-";
    if (!sender.trim()) {
      return <td className="truncate px-3 py-3 text-slate-600">-</td>;
    }
    const style = senderStyle(sender);
    const short = senderLocalPart(sender);
    return (
      <td
        className="cursor-pointer truncate px-3 py-3 transition hover:bg-cyan-500/10"
        title={sender}
        onClick={() => void copyToClipboard(sender)}
      >
        <span className={`truncate font-mono text-[11px] ${style.text}`}>
          {short}
        </span>
      </td>
    );
  };

  // Merged status column: replied / follow-up due / 2-step / sent / failed.
  const statusCell = (row: SheetHistoryRow) => {
    const replied = isYes(row.active) || isYes(row.replied);
    const email = primaryEmail(row.contact);
    const tick = email.includes("@") ? ticksByEmail[email.toLowerCase()] : undefined;
    return (
      <td className="px-3 py-3">
        <RowStatus replied={replied} tick={tick} />
      </td>
    );
  };

  return (
    <div
      className="fade-in fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="glass slide-in relative flex h-[min(85vh,720px)] w-full max-w-6xl flex-col overflow-hidden rounded-2xl shadow-2xl shadow-black/50">
        {copiedToast && (
          <div className="pointer-events-none absolute left-1/2 top-4 z-20 -translate-x-1/2 rounded-full border border-cyan-400/40 bg-cyan-500/20 px-4 py-1.5 text-xs font-medium text-cyan-100 shadow-lg">
            Copied
          </div>
        )}

        <div className="flex shrink-0 flex-col gap-4 border-b border-white/5 px-6 py-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <h3 className="text-lg font-semibold text-slate-100">Sent history</h3>
            <p className="mt-0.5 text-xs text-slate-500">
              Click a name to send · other cells to copy
            </p>
            </div>

            <div className="flex shrink-0 flex-wrap items-center gap-2">
            <HistoryDateRangePicker
              preset={datePreset}
              rangeFrom={rangeFrom}
              rangeTo={rangeTo}
              onApply={(p, from, to) => {
                setDatePreset(p);
                setRangeFrom(startOfDay(from));
                setRangeTo(endOfDay(to));
              }}
            />
            {selectableNonReplied.length > 0 && (
              <button
                type="button"
                onClick={selectNonReplied}
                className="rounded-full border border-cyan-400/30 bg-cyan-500/10 px-3 py-1.5 text-xs font-medium text-cyan-200 transition hover:border-cyan-300/70 hover:bg-cyan-400/20 hover:text-white"
                title="Select every non-replier last-emailed between 1 year and 6 days ago (deduped, skips the recent 6 days)"
              >
                Select non-replied ({selectableNonReplied.length})
              </button>
            )}
            {selectedEmails.size > 0 && (
              <button
                type="button"
                onClick={() => void deleteSelected()}
                className="rounded-full border border-rose-400/30 bg-rose-500/10 px-3 py-1.5 text-xs font-medium text-rose-200 transition hover:border-rose-300/70 hover:bg-rose-400/20 hover:text-white"
                title="Remove the selected contacts from history"
              >
                Delete {selectedEmails.size}
              </button>
            )}
            <button
              type="button"
              onClick={() => setCampaignOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-full border border-cyan-400/50 bg-cyan-500/90 px-3.5 py-1.5 text-xs font-semibold text-slate-950 shadow-[0_0_16px_rgba(34,211,238,0.3)] transition hover:bg-cyan-400"
              title="Send a two-step sequence to the selected contacts (or this date range)"
            >
              <SendIcon className="h-3.5 w-3.5" />
              {selectedEmails.size > 0
                ? `Send 2-step to ${selectedEmails.size}`
                : "Send 2-step to these"}
            </button>
            {onRefresh && (
              <button
                type="button"
                onClick={onRefresh}
                disabled={loading}
                className="rounded-full border border-white/10 px-3 py-1.5 text-xs text-slate-300 transition hover:border-cyan-400/40 hover:text-cyan-200 disabled:opacity-50"
                title="Reload from Google Sheet"
              >
                {loading ? "…" : "↻"}
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="rounded-full p-2 text-slate-400 transition hover:bg-white/5 hover:text-slate-100"
              aria-label="Close"
            >
              <CloseIcon className="h-4 w-4" />
            </button>
            </div>
          </div>

          {!loading && !error && rows.length > 0 && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-white/5 bg-white/[0.02] px-3.5 py-2 text-xs">
              <span className="inline-flex items-baseline gap-1.5">
                <span className="text-lg font-bold tabular-nums leading-none text-white">
                  {showSelectedOnly || searchActive ? displayCount : periodCount}
                </span>
                <span className="text-slate-400">
                  {showSelectedOnly
                    ? "selected"
                    : `email${(searchActive ? displayCount : periodCount) === 1 ? "" : "s"} · ${searchActive ? "search" : periodLabel}`}
                </span>
              </span>
              <span className="text-slate-700">·</span>
              <span className="inline-flex items-baseline gap-1.5 text-slate-500">
                <span className="font-semibold tabular-nums text-slate-300">
                  {rows.length}
                </span>
                all-time
              </span>
            </div>
          )}

          <div className="relative w-full">
            <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search all history…"
              className="w-full rounded-lg border border-white/10 bg-slate-950/70 py-2 pl-9 pr-8 text-xs text-slate-100 outline-none transition placeholder:text-slate-600 focus:border-cyan-400/50 focus:ring-2 focus:ring-cyan-400/20"
              aria-label="Search all history"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-1 text-slate-500 hover:bg-white/5 hover:text-slate-200"
                aria-label="Clear search"
              >
                <CloseIcon className="h-3 w-3" />
              </button>
            )}
          </div>

          {selectedEmails.size > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-cyan-400/30 bg-cyan-500/10 px-3 py-2 text-xs">
              <span className="text-cyan-100">
                <span className="font-bold">{selectedEmails.size}</span> contact
                {selectedEmails.size === 1 ? "" : "s"} selected
                {showSelectedOnly ? " · showing only these" : ""}
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setShowSelectedOnly((v) => !v)}
                  className="rounded-full border border-cyan-400/30 px-2.5 py-1 font-medium text-cyan-200 transition hover:bg-cyan-400/20 hover:text-white"
                >
                  {showSelectedOnly ? "Show all rows" : "Review selected"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setSelectedEmails(new Set());
                    setShowSelectedOnly(false);
                  }}
                  className="rounded-full px-2.5 py-1 text-slate-400 transition hover:text-white"
                >
                  Clear
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="flex min-h-0 flex-1 flex-col p-4 md:p-6">
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-white/5">
            {loading && rows.length === 0 && (
              <div className="flex flex-1 items-center justify-center">
                <p className="text-sm text-slate-400">Loading history…</p>
              </div>
            )}
            {error && rows.length === 0 && (
              <div className="m-4 rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
                {error}
              </div>
            )}
            {!loading && !error && rows.length === 0 && (
              <div className="flex flex-1 items-center justify-center">
                <p className="text-sm text-slate-400">No sent emails logged yet.</p>
              </div>
            )}
            {!loading && !error && rows.length > 0 && sortedRows.length === 0 && (
              <div className="flex flex-1 items-center justify-center px-4 text-center">
                <p className="text-sm text-slate-400">
                  {searchActive
                    ? `No matches for "${searchQuery.trim()}" in full history.`
                    : "No entries in this date range."}
                </p>
              </div>
            )}
            {!loading && !error && sortedRows.length > 0 && (
              <div className="min-h-0 flex-1 overflow-auto">
                <table className="w-full table-fixed border-collapse text-left text-[11px]">
                  <colgroup>
                    <col className="w-[3%]" />
                    <col className="w-[10%]" />
                    <col className="w-[13%]" />
                    <col className="w-[9%]" />
                    <col className="w-[18%]" />
                    <col className="w-[7%]" />
                    <col className="w-[10%]" />
                    <col className="w-[18%]" />
                    <col className="w-[12%]" />
                  </colgroup>
                  <thead className="sticky top-0 z-10 bg-slate-950">
                    <tr className="border-b border-white/5 text-[10px] font-medium uppercase tracking-[0.12em] text-slate-500">
                      <th className="px-3 py-3">
                        <input
                          type="checkbox"
                          checked={allVisibleSelected}
                          onChange={toggleSelectAll}
                          className="accent-cyan-500"
                          title="Select all shown"
                        />
                      </th>
                      {COLUMNS.map((col) => (
                        <th key={col.key} className="px-3 py-3">
                          {col.sortable ? (
                            <button
                              type="button"
                              onClick={() => toggleSort(col.key)}
                              className="inline-flex items-center transition hover:text-cyan-300"
                            >
                              {col.label}
                              {sortIndicator(col.key)}
                            </button>
                          ) : (
                            col.label
                          )}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sortedRows.map((row, i) => {
                      const dateDisplay = formatHistoryDate(row.date);
                      const dateCopy = row.date.trim() || dateDisplay;
                      const active = isYes(row.active);
                      const rowEmail = primaryEmail(row.contact);
                      return (
                        <tr
                          key={`${row.date}-${row.contact}-${row.sender}-${hashString(row.link)}-${i}`}
                          className={`border-b text-slate-300 transition-colors ${
                            active
                              ? "history-row-active border-cyan-500/20"
                              : "border-white/5 hover:bg-white/[0.02]"
                          }`}
                        >
                          <td className="px-3 py-3">
                            {rowEmail.includes("@") && (
                              <input
                                type="checkbox"
                                checked={selectedEmails.has(rowEmail)}
                                onChange={() => toggleEmail(rowEmail)}
                                className="accent-cyan-500"
                              />
                            )}
                          </td>
                          {copyCell(
                            dateCopy,
                            <span className="whitespace-nowrap text-slate-400">
                              {dateDisplay}
                            </span>,
                            "px-3 py-3",
                          )}
                          {nameCell(row)}
                          {copyCell(
                            row.country,
                            <span className="inline-flex items-center gap-1.5">
                              <CountryFlag country={row.country} size={13} />
                              <span className="truncate">{row.country || "-"}</span>
                            </span>,
                            "truncate px-3 py-3",
                          )}
                          {contactCell(row.contact)}
                          {copyCell(row.site, row.site || "-", "truncate px-3 py-3")}
                          {senderCell(row.sender)}
                          {copyCell(
                            row.link,
                            <span className="block truncate">{row.link || "-"}</span>,
                            "truncate px-3 py-3",
                          )}
                          {statusCell(row)}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>

      {campaignOpen && (
        <HistoryCampaignPanel
          from={rangeFrom}
          to={rangeTo}
          periodLabel={searchActive ? "all history" : periodLabel}
          emails={
            selectedEmails.size > 0 ? [...selectedEmails] : undefined
          }
          onClose={() => setCampaignOpen(false)}
          onQueued={() => {
            setSelectedEmails(new Set());
            setShowSelectedOnly(false);
          }}
        />
      )}
    </div>
  );
}
