"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { GmailReplyMessage, GmailThreadMessage } from "@/lib/gmail";
import type { ReplyNotification } from "@/lib/reply-alerts";
import { inboxContextLabel, type ReplyInboxContext } from "@/lib/reply-inbox";
import type { SheetHistoryRow } from "@/lib/sheets";
import { primaryEmail, rowKey } from "@/lib/sheet-active";
import ReplyCustomTabDialog from "@/components/ReplyCustomTabDialog";
import GmailAvatar from "@/components/GmailAvatar";
import MessageIcon from "@/components/icons/MessageIcon";
import type { ReplyFilterSelection } from "@/hooks/useNewReplies";
import { useReplyConversations } from "@/hooks/useReplyConversations";
import type { CustomReplyTab } from "@/lib/reply-custom-tabs";
import { threadKeyForRow } from "@/lib/reply-custom-tabs";
import type { MailIdentity } from "@/lib/types";

type AlertRow = SheetHistoryRow & { _alert?: ReplyNotification };

type Props = {
  displayRows: AlertRow[];
  unseenCount: number;
  allCount: number;
  customTabCounts: Record<string, number>;
  filter: ReplyFilterSelection;
  onFilterChange: (f: ReplyFilterSelection) => void;
  onMarkSeen: (rowId: number) => void;
  onMarkAllSeen: () => void;
  customTabs: CustomReplyTab[];
  onCreateCustomTab: (name: string, icon: string, threadKey: string) => void;
  onAddToCustomTab: (tabId: string, threadKey: string) => void;
  inboxContextFor: (row: AlertRow) => ReplyInboxContext;
  isUnread: (row: SheetHistoryRow) => boolean;
  messageIds: Record<string, string>;
  syncing?: boolean;
  senders: MailIdentity[];
  smtpConfigured: boolean;
};

function avatarInitials(name: string, contact: string): string {
  const src = name.trim() || contact.trim();
  if (!src) return "?";
  const parts = src.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return src.slice(0, 2).toUpperCase();
}

function formatWhen(iso: string): string {
  if (!iso.trim()) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const diff = Date.now() - d.getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? "" : "s"} ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days} day${days === 1 ? "" : "s"} ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function senderDisplayName(
  rowName: string,
  fromHeader: string | undefined,
): string {
  const n = rowName.trim();
  if (n) return n;
  if (!fromHeader?.trim()) return "Contact";
  const match = fromHeader.match(/^([^<]+)</);
  if (match) return match[1].trim().replace(/"/g, "") || "Contact";
  return fromHeader.split("@")[0] || "Contact";
}

function tabButtonClass(selected: boolean): string {
  return `inline-flex shrink-0 items-center gap-1 rounded-lg border px-2.5 py-1 text-[11px] font-medium transition ${
    selected
      ? "border-cyan-400/45 bg-cyan-500/20 text-cyan-100 shadow-sm"
      : "border-white/10 bg-slate-900/70 text-slate-400 hover:border-white/20 hover:bg-slate-800/80 hover:text-slate-200"
  }`;
}

function tabCountClass(selected: boolean): string {
  return `tabular-nums text-[10px] font-semibold ${
    selected ? "text-cyan-200/90" : "text-slate-500"
  }`;
}

// Exact local time - used as the hover title so the precise moment is always
// available even though the visible label is relative.
function formatBubbleTime(iso: string): string {
  if (!iso.trim()) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

// Relative age ("just now", "2h ago", "Yesterday", date). Timezone-independent
// - this is what fixes the app/Gmail clock mismatch, since both compute the
// same age from the same instant regardless of each app's display timezone.
function formatRelativeTime(iso: string): string {
  if (!iso.trim()) return "";
  const d = new Date(iso);
  const t = d.getTime();
  if (Number.isNaN(t)) return "";
  const diffMs = Date.now() - t;
  // Future-dated / clock-skewed (device clock behind Gmail, or timezone
  // artifact): a relative label like "just now" would be misleading, so show
  // the absolute local date+time instead.
  if (diffMs < -120000) return formatBubbleTime(iso);
  const min = Math.round(diffMs / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day === 1) return `Yesterday ${d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
  if (day < 7) return `${day}d ago`;
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
  });
}

// Whether two ISO timestamps fall on the same calendar day (drives the
// day-separator chips in the conversation). Bad dates collapse to "same" so we
// never render a stray separator.
function sameCalendarDay(a: string, b: string): boolean {
  const da = new Date(a);
  const db = new Date(b);
  if (Number.isNaN(da.getTime()) || Number.isNaN(db.getTime())) return true;
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}

// Centered day-separator label: "Today" / "Yesterday" / weekday-date.
function dayLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const y = new Date();
  y.setDate(now.getDate() - 1);
  const same = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
  if (same(d, now)) return "Today";
  if (same(d, y)) return "Yesterday";
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: d.getFullYear() === now.getFullYear() ? undefined : "numeric",
  });
}

// Remove leading email quote markers ("> ", ">> ") so a fully-quoted message
// still reads as text instead of rendering as an empty bubble.
function dequote(text: string): string {
  return text
    .split("\n")
    .map((l) => l.replace(/^\s*(>+\s?)+/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Split an email body into the new reply and the quoted history beneath it.
// Chat apps hide the quoted thread; we render `main` in the bubble and tuck
// `quoted` behind a "show quoted text" toggle so the actual message is what
// you see. Detects the common quote markers: ">" prefixes, "On … wrote:"
// attribution (which can wrap across two lines), and Outlook dividers.
function splitQuotedText(body: string): { main: string; quoted: string } {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const isDivider = (l: string) =>
    /^>/.test(l) ||
    /^\s*-{2,}\s*Original Message\s*-{2,}/i.test(l) ||
    /^\s*_{5,}\s*$/.test(l) ||
    /^\s*On\b.*\bwrote:\s*$/.test(l) ||
    /^\s*From:\s.+/.test(l);

  let cut = -1;
  for (let i = 0; i < lines.length; i++) {
    if (isDivider(lines[i])) {
      cut = i;
      break;
    }
    // "On <date>…" attribution that wraps and ends with "wrote:" a line or
    // two later - cut at the "On" line so the whole attribution is hidden.
    if (/^\s*On\b/.test(lines[i])) {
      const joined = lines.slice(i, i + 3).join(" ");
      if (/\bwrote:\s*$/.test(joined.trim())) {
        cut = i;
        break;
      }
    }
  }

  if (cut === -1) return { main: body.trim(), quoted: "" };

  const main = lines.slice(0, cut).join("\n").trim();
  const quoted = lines.slice(cut).join("\n").trim();

  // Whole message is quoted (Dexter's client quoted everything and added no new
  // line above it) - there's no "new" text, so show the de-quoted content as
  // the body instead of an empty bubble with a lone "•••".
  if (!main) return { main: dequote(quoted), quoted: "" };

  return { main, quoted };
}

function SendArrowIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d="M22 2 11 13" />
      <path d="M22 2 15 22l-4-9-9-4 20-7z" />
    </svg>
  );
}

function ChevronIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

// Single/double check marks and a flame, drawn inline so they render crisply
// and identically on every platform (no emoji).
function CheckIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 18 14" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M2 7.5 6.5 12 16 2" />
    </svg>
  );
}
function DoubleCheckIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 22 14" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M1.5 8 5 11.5 12.5 3" />
      <path d="M8.5 8 12 11.5 19.5 3" />
    </svg>
  );
}
function FlameIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z" />
    </svg>
  );
}

// Telegram/Teams-style delivery receipt for an OUTBOUND bubble. A tracked open
// (opened_at set) shows a blue double-tick + "viewed <relative>"; otherwise a
// single muted tick ("Sent"). Opened 4+ times flags the lead as "hot".
function ReceiptStatus({
  openedAt,
  openCount,
}: {
  openedAt?: string | null;
  openCount?: number;
}) {
  const seen = !!(openedAt && openedAt.trim());
  const hot = (openCount ?? 0) > 3;
  if (!seen) {
    return (
      <span className="inline-flex items-center text-cyan-100/55" title="Sent">
        <CheckIcon className="h-3.5 w-3.5" />
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1">
      {hot && (
        <span
          className="inline-flex items-center gap-0.5 rounded-full bg-orange-500/25 px-1 py-[1px] text-[9px] font-bold text-orange-100 ring-1 ring-inset ring-orange-300/40"
          title={`Opened ${openCount}× — hot lead`}
        >
          <FlameIcon className="h-2.5 w-2.5" />
          {openCount}×
        </span>
      )}
      <span className="text-sky-100" title={formatBubbleTime(openedAt!)}>
        viewed {formatRelativeTime(openedAt!)}
      </span>
      <DoubleCheckIcon className="h-3.5 w-3.5 text-sky-300" />
    </span>
  );
}

// A single chat bubble. Shows the new reply text; hides quoted history behind
// a compact "•••" toggle (like Gmail/LinkedIn) so threads stay readable.
function MessageBubble({
  message,
  showAvatar,
  avatar,
}: {
  message: GmailThreadMessage;
  showAvatar: boolean;
  avatar: React.ReactNode;
}) {
  const [showQuoted, setShowQuoted] = useState(false);
  const { main, quoted } = useMemo(
    () => splitQuotedText(message.bodyText || ""),
    [message.bodyText],
  );
  const out = message.isOutbound;

  return (
    <div className={`flex items-end gap-2 ${out ? "justify-end" : "justify-start"}`}>
      {!out && (
        <span className="mb-1 shrink-0">
          {showAvatar ? avatar : <span className="block h-7 w-7" />}
        </span>
      )}
      <div
        className={`max-w-[min(80%,32rem)] min-w-0 rounded-2xl px-3.5 py-2.5 shadow-sm ${
          out
            ? "rounded-br-md bg-cyan-600 text-white"
            : "rounded-bl-md border border-slate-700/70 bg-slate-800 text-slate-100"
        }`}
      >
        <p className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed [overflow-wrap:anywhere]">
          {main || (quoted ? "" : "-")}
        </p>

        {quoted && (
          <div className="mt-1.5">
            <button
              type="button"
              onClick={() => setShowQuoted((v) => !v)}
              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium transition ${
                out
                  ? "bg-cyan-500/30 text-cyan-50/90 hover:bg-cyan-500/50"
                  : "bg-slate-700/60 text-slate-300 hover:bg-slate-600/80"
              }`}
              title={showQuoted ? "Hide quoted text" : "Show quoted text"}
            >
              <ChevronIcon
                className={"h-3 w-3 transition-transform " + (showQuoted ? "rotate-180" : "")}
              />
              {showQuoted ? "Hide quoted" : "Quoted text"}
            </button>
            {showQuoted && (
              <pre
                className={`mt-1.5 max-h-56 overflow-y-auto whitespace-pre-wrap break-words border-l-2 pl-2.5 font-sans text-[12px] leading-relaxed [overflow-wrap:anywhere] ${
                  out
                    ? "border-cyan-300/50 text-cyan-50/80"
                    : "border-slate-600 text-slate-400"
                }`}
              >
                {quoted}
              </pre>
            )}
          </div>
        )}

        {(out || message.receivedAt) && (
          <div
            className={`mt-1 flex items-center justify-end gap-1.5 text-[10px] ${
              out ? "text-cyan-100/70" : "text-slate-500"
            }`}
          >
            {message.receivedAt && (
              <span title={formatBubbleTime(message.receivedAt)}>
                {formatRelativeTime(message.receivedAt)}
              </span>
            )}
            {out && (
              <ReceiptStatus
                openedAt={message.openedAt}
                openCount={message.openCount}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default function ReplyNotificationsBell({
  displayRows,
  unseenCount,
  allCount,
  customTabCounts,
  filter,
  onFilterChange,
  onMarkSeen,
  onMarkAllSeen,
  customTabs,
  onCreateCustomTab,
  onAddToCustomTab,
  inboxContextFor,
  isUnread,
  messageIds,
  syncing,
  senders,
  smtpConfigured,
}: Props) {
  const [open, setOpen] = useState(false);
  const [selectedKey, setSelectedKey] = useState<number | null>(null);
  const [selectedRow, setSelectedRow] = useState<SheetHistoryRow | null>(null);
  const [loadingMsg, setLoadingMsg] = useState(false);
  const [msgError, setMsgError] = useState<string | null>(null);
  const [preview, setPreview] = useState<GmailReplyMessage | null>(null);
  const [threadMessages, setThreadMessages] = useState<GmailThreadMessage[]>([]);
  const [replyFrom, setReplyFrom] = useState("");
  const [replyBody, setReplyBody] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sendOk, setSendOk] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const bellRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const threadEndRef = useRef<HTMLDivElement>(null);
  const [panelPos, setPanelPos] = useState<{
    top: number;
    right: number;
    width: number;
    maxHeight: number;
  } | null>(null);
  const [mounted, setMounted] = useState(false);
  const [holdMenu, setHoldMenu] = useState<{
    row: AlertRow;
    x: number;
    y: number;
  } | null>(null);
  const [customTabDialog, setCustomTabDialog] = useState<{
    threadKey: string;
  } | null>(null);
  const holdTimerRef = useRef<number | null>(null);

  const receivedInboxByRow = useMemo(() => {
    const map: Record<string, string> = {};
    for (const row of displayRows) {
      const rk = rowKey(row);
      if (rk == null) continue;
      const ctx = inboxContextFor(row);
      map[String(rk)] = ctx.receivedInbox;
    }
    return map;
  }, [displayRows, inboxContextFor]);

  const {
    getPreview,
    getConversation,
    getMessageCount,
    loadConversation,
    loadingConversations,
    threadKeyFor,
  } = useReplyConversations(displayRows, open, filter, receivedInboxByRow);

  const conversationActive = selectedKey !== null;

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (filter.kind === "unread") {
      setSelectedKey(null);
      setSelectedRow(null);
      setPreview(null);
      setThreadMessages([]);
      setMsgError(null);
      setLoadingMsg(false);
    }
  }, [filter]);

  const clearHoldTimer = () => {
    if (holdTimerRef.current) {
      window.clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
  };

  const startHold = (row: AlertRow, clientX: number, clientY: number) => {
    clearHoldTimer();
    holdTimerRef.current = window.setTimeout(() => {
      setHoldMenu({ row, x: clientX, y: clientY });
    }, 480);
  };

  const updatePanelPos = useCallback(() => {
    const bell = bellRef.current;
    if (!bell) return;
    const r = bell.getBoundingClientRect();
    const margin = 12;
    const gap = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const width = Math.min(920, vw - margin * 2);
    let right = Math.max(margin, vw - r.right);
    if (vw - right - width < margin) {
      right = Math.max(margin, vw - width - margin);
    }
    const top = Math.min(r.bottom + gap, vh - 120);
    const maxHeight = Math.min(560, vh - top - margin);
    setPanelPos({ top, right, width, maxHeight: Math.max(280, maxHeight) });
  }, []);

  useEffect(() => {
    if (!open) return;
    updatePanelPos();
    window.addEventListener("resize", updatePanelPos);
    window.addEventListener("scroll", updatePanelPos, true);
    return () => {
      window.removeEventListener("resize", updatePanelPos);
      window.removeEventListener("scroll", updatePanelPos, true);
    };
  }, [open, updatePanelPos]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (rootRef.current?.contains(t) || panelRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener("click", onDoc);
    return () => document.removeEventListener("click", onDoc);
  }, [open]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    if (open) document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  useEffect(() => {
    if (!loadingMsg && threadMessages.length > 0) {
      threadEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [loadingMsg, threadMessages]);

  const pickDefaultSender = useCallback(
    (row: AlertRow) => {
      const inbox = inboxContextFor(row).receivedInbox;
      const match = senders.find((s) => s.email.toLowerCase() === inbox);
      return match?.email ?? senders[0]?.email ?? inbox;
    },
    [senders, inboxContextFor],
  );

  const applyConversation = useCallback((thread: {
    messages: GmailThreadMessage[];
    latest: GmailReplyMessage;
  }) => {
    setPreview(thread.latest);
    setThreadMessages(thread.messages);
  }, []);

  const loadThread = useCallback(
    async (row: AlertRow): Promise<void> => {
      const key = rowKey(row);
      if (!key) return;
      setSelectedKey(key);
      setSelectedRow(row);
      setMsgError(null);
      setSendError(null);
      setSendOk(false);
      setReplyBody("");
      setReplyFrom(pickDefaultSender(row));

      const cached = getConversation(row);
      if (cached?.thread) {
        applyConversation(cached.thread);
        setLoadingMsg(false);
        return;
      }

      setLoadingMsg(true);
      setPreview(null);
      setThreadMessages([]);
      try {
        const conv = await loadConversation(row);
        if (!conv?.thread) {
          setMsgError("No Gmail conversation found for this contact.");
          return;
        }
        applyConversation(conv.thread);
      } catch (err) {
        setMsgError(
          err instanceof Error ? err.message : "Failed to load conversation.",
        );
      } finally {
        setLoadingMsg(false);
      }
    },
    [pickDefaultSender, getConversation, loadConversation, applyConversation],
  );

  const refreshOpenConversation = useCallback(
    async (silent = true) => {
      if (!selectedRow) return;
      try {
        const conv = await loadConversation(selectedRow as AlertRow, true);
        if (conv?.thread) {
          applyConversation(conv.thread);
          if (!silent) setLoadingMsg(false);
        }
      } catch {
        if (!silent) {
          setMsgError("Failed to refresh conversation.");
          setLoadingMsg(false);
        }
      }
    },
    [selectedRow, loadConversation, applyConversation],
  );

  const lastKnownMsgId = selectedKey
    ? messageIds[String(selectedKey)]
    : undefined;

  useEffect(() => {
    if (!open || !selectedRow || !lastKnownMsgId) return;
    const conv = getConversation(selectedRow as AlertRow);
    if (conv?.thread.latest.id === lastKnownMsgId) return;
    void refreshOpenConversation(true);
  }, [open, selectedRow, lastKnownMsgId, getConversation, refreshOpenConversation]);

  useEffect(() => {
    if (!open || !conversationActive || !selectedRow) return;
    const ms = Math.max(
      20_000,
      Number(process.env.NEXT_PUBLIC_INBOX_POLL_MS ?? "45000") || 45_000,
    );
    const id = window.setInterval(() => {
      void refreshOpenConversation(true);
    }, ms);
    return () => window.clearInterval(id);
  }, [open, conversationActive, selectedRow, refreshOpenConversation]);

  const openRow = (row: AlertRow) => {
    const key = rowKey(row);
    if (!key) return;
    void loadThread(row).then(() => onMarkSeen(key));
  };

  const handleSendReply = async () => {
    if (!selectedRow || !preview || !replyBody.trim()) return;
    const contact = primaryEmail(selectedRow.contact);
    const picked = senders.find(
      (s) => s.email.toLowerCase() === replyFrom.toLowerCase(),
    );
    if (!picked) {
      setSendError("Choose a sender from your configured mail identities.");
      return;
    }

    setSending(true);
    setSendError(null);
    setSendOk(false);
    try {
      const res = await fetch("/api/send-reply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from: { email: picked.email, name: picked.name },
          to: contact,
          body: replyBody.trim(),
          replyToMessageId: preview.id,
          sender: inboxContextFor(selectedRow).receivedInbox,
        }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        throw new Error(data.error ?? "Failed to send reply.");
      }
      setReplyBody("");
      setSendOk(true);
      const conv = await loadConversation(selectedRow, true);
      if (conv?.thread) applyConversation(conv.thread);
    } catch (err) {
      setSendError(
        err instanceof Error ? err.message : "Failed to send reply.",
      );
    } finally {
      setSending(false);
    }
  };

  const canReply =
    smtpConfigured &&
    senders.length > 0 &&
    preview &&
    selectedRow &&
    !loadingMsg;

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={bellRef}
        type="button"
        onClick={() => {
          setOpen((v) => {
            if (!v) updatePanelPos();
            return !v;
          });
        }}
        aria-label={
          unseenCount > 0 ? `Replies, ${unseenCount} new` : "Replies"
        }
        aria-expanded={open}
        title={
          syncing
            ? "Checking Gmail for new replies…"
            : unseenCount > 0
              ? `${unseenCount} new ${unseenCount === 1 ? "reply" : "replies"}`
              : "No new replies"
        }
        className={`btn-press relative inline-flex h-8 w-8 items-center justify-center rounded-full border transition hover:text-white ${
          unseenCount > 0
            ? "border-rose-400/40 bg-rose-500/10 text-rose-100 hover:border-rose-300/60 hover:bg-rose-500/20"
            : "border-white/15 bg-white/5 text-slate-200 hover:border-cyan-400/40 hover:bg-cyan-500/10"
        }`}
      >
        <MessageIcon className="h-5 w-5 object-contain" />
        {unseenCount > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-rose-500 px-1 text-[10px] font-bold leading-none text-white shadow-[0_0_8px_rgba(244,63,94,0.65)]">
            {unseenCount > 99 ? "99+" : unseenCount}
          </span>
        )}
        {syncing && (
          <span className="absolute -bottom-0.5 -right-0.5 h-2 w-2 animate-pulse rounded-full bg-cyan-400" />
        )}
      </button>

      {open &&
        mounted &&
        panelPos &&
        createPortal(
        <div
          ref={panelRef}
          style={{
            top: panelPos.top,
            right: panelPos.right,
            width: panelPos.width,
            maxHeight: panelPos.maxHeight,
          }}
          className="fixed z-[300] flex min-h-0 flex-col overflow-hidden rounded-2xl border border-white/15 bg-slate-950 shadow-[0_16px_48px_rgba(0,0,0,0.55)]"
          role="dialog"
          aria-label="Reply notifications"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex min-h-[min(360px,100%)] min-h-0 min-w-0 flex-1 flex-col min-[720px]:min-h-0 min-[720px]:flex-row">
            <div className="flex min-h-0 min-w-0 flex-col border-b border-white/10 min-[720px]:w-[min(38%,300px)] min-[720px]:max-w-[300px] min-[720px]:shrink-0 min-[720px]:border-b-0 min-[720px]:border-r min-[720px]:border-white/10">
              <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-white/10 px-3 py-2.5">
                <div
                  className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5"
                  role="tablist"
                  aria-label="Conversation tabs"
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={filter.kind === "unread"}
                    onClick={() => onFilterChange({ kind: "unread" })}
                    className={tabButtonClass(filter.kind === "unread")}
                  >
                    <span>New</span>
                    <span className={tabCountClass(filter.kind === "unread")}>
                      {unseenCount}
                    </span>
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={filter.kind === "all"}
                    onClick={() => onFilterChange({ kind: "all" })}
                    className={tabButtonClass(filter.kind === "all")}
                  >
                    <span>All</span>
                    <span className={tabCountClass(filter.kind === "all")}>
                      {allCount}
                    </span>
                  </button>
                  {customTabs.map((tab) => {
                    const selected =
                      filter.kind === "custom" && filter.tabId === tab.id;
                    const count = customTabCounts[tab.id] ?? 0;
                    return (
                      <button
                        key={tab.id}
                        type="button"
                        role="tab"
                        aria-selected={selected}
                        title={tab.name}
                        onClick={() =>
                          onFilterChange({ kind: "custom", tabId: tab.id })
                        }
                        className={tabButtonClass(selected)}
                      >
                        <span className="max-w-[7rem] truncate">{tab.name}</span>
                        <span className={tabCountClass(selected)}>{count}</span>
                      </button>
                    );
                  })}
                </div>
                {filter.kind === "unread" && unseenCount > 0 && (
                  <button
                    type="button"
                    onClick={() => onMarkAllSeen()}
                    className="inline-flex shrink-0 items-center gap-1 text-[11px] text-slate-400 transition hover:text-cyan-300"
                  >
                    <span className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-slate-500/60 text-[9px]">
                      ✓
                    </span>
                    Mark all read
                  </button>
                )}
              </div>

              <div className="min-h-0 max-h-[min(240px,36vh)] flex-1 overflow-y-auto min-[720px]:max-h-none">
                {displayRows.length === 0 ? (
                  <p className="px-4 py-10 text-center text-sm text-slate-500">
                    {filter.kind === "unread"
                      ? "No new replies - you're all caught up."
                      : filter.kind === "all"
                        ? "No active sessions in the sheet."
                        : "No threads in this tab. Long-press a conversation to add one."}
                  </p>
                ) : (
                  displayRows.map((row) => {
                    const threadId = threadKeyFor(row);
                    const ctx = inboxContextFor(row);
                    const unread = isUnread(row);
                    const listPreview = getPreview(row);
                    const name = senderDisplayName(
                      row.name ?? "",
                      listPreview?.from,
                    );
                    const contact = primaryEmail(row.contact);
                    const myInbox = ctx.receivedInbox;
                    const when = listPreview?.receivedAt || row.date;
                    const active =
                      selectedRow !== null &&
                      threadKeyFor(selectedRow as AlertRow) === threadId;
                    const msgCount = getMessageCount(row);
                    const showPreview = filter.kind !== "unread";
                    const previewText = showPreview
                      ? listPreview?.snippet ||
                        row._alert?.snippet?.slice(0, 120) ||
                        (loadingConversations ? "…" : "")
                      : row._alert?.snippet?.slice(0, 120) ||
                        listPreview?.snippet ||
                        "";

                    return (
                      <div
                        key={threadId}
                        className={`border-b border-white/5 ${
                          active ? "bg-cyan-500/10" : ""
                        }`}
                        onMouseDown={(e) => {
                          if (e.button === 0) startHold(row, e.clientX, e.clientY);
                        }}
                        onMouseUp={clearHoldTimer}
                        onMouseLeave={clearHoldTimer}
                        onTouchStart={(e) => {
                          const t = e.touches[0];
                          if (t) startHold(row, t.clientX, t.clientY);
                        }}
                        onTouchEnd={clearHoldTimer}
                        onTouchCancel={clearHoldTimer}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          setHoldMenu({ row, x: e.clientX, y: e.clientY });
                        }}
                      >
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            openRow(row);
                          }}
                          className="flex w-full min-w-0 cursor-pointer gap-3 px-4 py-3 text-left transition hover:bg-white/5"
                        >
                          {unread ? (
                            <span
                              className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-sky-400 shadow-[0_0_6px_rgba(56,189,248,0.8)]"
                              aria-hidden
                            />
                          ) : (
                            <span className="w-2 shrink-0" />
                          )}
                          <GmailAvatar
                            email={contact}
                            size={36}
                            fallback={
                              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-cyan-500/30 to-slate-700 text-xs font-semibold text-cyan-100">
                                {avatarInitials(name, contact)}
                              </span>
                            }
                          />
                          <span className="min-w-0 flex-1">
                            <div className="flex items-start justify-between gap-2">
                              <p className="flex min-w-0 items-center gap-1.5 text-sm font-semibold text-slate-100">
                                <span className="truncate">{name}</span>
                                {msgCount !== null ? (
                                  <span
                                    className="shrink-0 rounded-md bg-white/5 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-slate-400"
                                    title={`${msgCount} message${msgCount === 1 ? "" : "s"} in thread`}
                                  >
                                    {msgCount}
                                  </span>
                                ) : loadingConversations ? (
                                  <span className="shrink-0 text-[10px] text-slate-600">
                                    …
                                  </span>
                                ) : null}
                              </p>
                              {when ? (
                                <span className="shrink-0 text-[10px] text-slate-500">
                                  {formatWhen(when)}
                                </span>
                              ) : null}
                            </div>
                            <p className="mt-0.5 truncate text-[11px] text-cyan-300/85">
                              {contact}
                            </p>
                            <p className="truncate text-[11px] text-slate-500">
                              <span className="text-slate-600">via </span>
                              {myInbox}
                            </p>
                            {previewText ? (
                              <p className="mt-1.5 line-clamp-2 text-xs leading-snug text-slate-400">
                                {previewText}
                              </p>
                            ) : null}
                          </span>
                        </button>
                      </div>
                    );
                  })
                )}
              </div>
            </div>

            <div
              className={`flex min-h-0 min-w-0 flex-1 flex-col ${
                !conversationActive ? "opacity-60" : ""
              }`}
            >
              <div className="shrink-0 border-b border-white/10 bg-slate-900/60 px-3 py-2.5 sm:px-4 sm:py-3">
                {conversationActive && selectedRow ? (
                  <div className="flex items-center gap-3">
                    <GmailAvatar
                      email={primaryEmail(selectedRow.contact)}
                      size={38}
                      fallback={
                        <span className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-cyan-500/30 to-slate-700 text-sm font-semibold text-cyan-100">
                          {avatarInitials(
                            selectedRow.name ?? "",
                            primaryEmail(selectedRow.contact),
                          )}
                        </span>
                      }
                    />
                    <div className="min-w-0 flex-1 text-[11px]">
                      <p className="flex min-w-0 items-center gap-1.5 truncate text-sm font-semibold text-slate-100">
                        <span className="truncate">
                          {senderDisplayName(selectedRow.name ?? "", preview?.from)}
                        </span>
                        {threadMessages.length > 0 && (
                          <span className="shrink-0 tabular-nums text-slate-500">
                            {threadMessages.length}
                          </span>
                        )}
                      </p>
                      <p className="truncate text-cyan-300/80">
                        {primaryEmail(selectedRow.contact)}
                      </p>
                      {inboxContextFor(selectedRow as AlertRow).crossInbox && (
                        <p className="text-[11px] leading-snug text-amber-300/90">
                          {inboxContextLabel(inboxContextFor(selectedRow as AlertRow))}
                        </p>
                      )}
                    </div>
                  </div>
                ) : (
                  <h3 className="text-sm font-medium text-slate-200">Conversation</h3>
                )}
              </div>

              <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto bg-slate-950/60 px-3 py-3 sm:px-4">
                {!conversationActive && (
                  <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
                    <span className="flex h-14 w-14 items-center justify-center rounded-full bg-white/5 text-slate-500">
                      <MessageIcon className="h-7 w-7 object-contain" />
                    </span>
                    <p className="max-w-[220px] text-sm text-slate-500">
                      {filter.kind === "unread"
                        ? "Pick a reply on the left to open the conversation."
                        : "Pick a conversation to read the full thread."}
                    </p>
                  </div>
                )}
                {conversationActive && loadingMsg && threadMessages.length === 0 && (
                  <div className="flex h-full items-center justify-center gap-2 text-sm text-slate-400">
                    <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-600 border-t-cyan-400" />
                    Loading messages…
                  </div>
                )}
                {conversationActive && msgError && !loadingMsg && (
                  <div className="flex h-full items-center justify-center px-6 text-center">
                    <p className="text-sm text-rose-300">{msgError}</p>
                  </div>
                )}
                {conversationActive && threadMessages.length > 0 && selectedRow && (
                  <div className="flex flex-col">
                    {threadMessages.map((m, i) => {
                      const prev = threadMessages[i - 1];
                      const next = threadMessages[i + 1];
                      // Avatar only on the last message of a consecutive run from
                      // the same side; extra gap when the side changes.
                      const isRunEnd = !next || next.isOutbound !== m.isOutbound;
                      const isRunStart = !prev || prev.isOutbound !== m.isOutbound;
                      const showDay =
                        !!m.receivedAt &&
                        (!prev ||
                          !prev.receivedAt ||
                          !sameCalendarDay(m.receivedAt, prev.receivedAt));
                      return (
                        <Fragment key={m.id}>
                          {showDay && (
                            <div className="flex justify-center py-2.5">
                              <span className="rounded-full bg-white/[0.06] px-3 py-0.5 text-[10px] font-medium text-slate-400">
                                {dayLabel(m.receivedAt as string)}
                              </span>
                            </div>
                          )}
                          <div
                            className={
                              i === 0 || showDay
                                ? ""
                                : isRunStart
                                  ? "mt-2.5"
                                  : "mt-1"
                            }
                          >
                            <MessageBubble
                              message={m}
                              showAvatar={isRunEnd}
                              avatar={
                                <GmailAvatar
                                  email={primaryEmail(selectedRow.contact)}
                                  size={28}
                                  fallback={
                                    <span className="flex h-7 w-7 items-center justify-center rounded-full bg-gradient-to-br from-cyan-500/30 to-slate-700 text-[10px] font-semibold text-cyan-100">
                                      {avatarInitials(
                                        selectedRow.name ?? "",
                                        primaryEmail(selectedRow.contact),
                                      )}
                                    </span>
                                  }
                                />
                              }
                            />
                          </div>
                        </Fragment>
                      );
                    })}
                    <div ref={threadEndRef} />
                  </div>
                )}
              </div>

              {conversationActive && canReply && (
                <div className="shrink-0 border-t border-white/10 bg-slate-900 p-3 sm:px-4">
                  <div className="mb-2 flex items-center gap-1.5 text-[11px] text-slate-500">
                    <span className="shrink-0">From</span>
                    <select
                      value={replyFrom}
                      onChange={(e) => setReplyFrom(e.target.value)}
                      className="min-w-0 flex-1 truncate rounded-md border border-white/10 bg-slate-950 px-2 py-1 text-[11px] text-slate-300 outline-none focus:border-cyan-400/40"
                    >
                      {senders.map((s) => (
                        <option key={s.email} value={s.email}>
                          {s.name ? `${s.name} · ` : ""}
                          {s.email}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="flex items-end gap-2 rounded-2xl border border-white/10 bg-slate-950 px-3 py-2 transition focus-within:border-cyan-400/40">
                    <textarea
                      value={replyBody}
                      onChange={(e) => setReplyBody(e.target.value)}
                      onKeyDown={(e) => {
                        // Enter sends; Shift+Enter inserts a newline.
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          if (!sending && replyBody.trim()) void handleSendReply();
                        }
                      }}
                      rows={1}
                      placeholder="Write a message…"
                      className="max-h-40 min-h-[24px] w-full resize-none bg-transparent py-1 text-sm text-slate-100 placeholder:text-slate-500 outline-none"
                      style={{ height: "auto" }}
                      onInput={(e) => {
                        const el = e.currentTarget;
                        el.style.height = "auto";
                        el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
                      }}
                    />
                    <button
                      type="button"
                      disabled={sending || !replyBody.trim()}
                      onClick={() => void handleSendReply()}
                      className="btn-press mb-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-cyan-500 text-white transition hover:bg-cyan-400 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-500"
                      title="Send (Enter)"
                    >
                      {sending ? (
                        <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
                      ) : (
                        <SendArrowIcon className="h-4 w-4" />
                      )}
                    </button>
                  </div>
                  <div className="mt-1 flex items-center justify-between px-1">
                    <span className="text-[10px] text-slate-600">
                      Enter to send · Shift+Enter for a new line
                    </span>
                    {sendError && (
                      <span className="text-[11px] text-rose-300">{sendError}</span>
                    )}
                    {sendOk && !sendError && (
                      <span className="text-[11px] text-emerald-400">Sent ✓</span>
                    )}
                  </div>
                </div>
              )}

              {conversationActive && !loadingMsg && !canReply && preview && (
                <div className="shrink-0 border-t border-white/10 px-4 py-3">
                  <p className="text-xs text-slate-500">
                    {!smtpConfigured
                      ? "Configure SMTP in .env.local to send replies from here."
                      : "Add sender identities to MAIL_IDENTITIES to reply."}
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>,
        document.body,
      )}

      {mounted &&
        holdMenu &&
        createPortal(
          <div
            className="fixed inset-0 z-[350]"
            onMouseDown={() => setHoldMenu(null)}
          >
            <div
              className="absolute min-w-[180px] rounded-lg border border-white/15 bg-slate-950 py-1 shadow-xl"
              style={{
                left: Math.min(holdMenu.x, window.innerWidth - 200),
                top: Math.min(holdMenu.y, window.innerHeight - 120),
              }}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <button
                type="button"
                className="block w-full px-3 py-2 text-left text-xs text-slate-200 hover:bg-white/10"
                onClick={() => {
                  const key = threadKeyForRow(
                    holdMenu.row,
                    receivedInboxByRow,
                  );
                  setHoldMenu(null);
                  setCustomTabDialog({ threadKey: key });
                }}
              >
                Add to custom tab…
              </button>
              {customTabs.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-slate-300 hover:bg-white/10"
                  onClick={() => {
                    onAddToCustomTab(
                      tab.id,
                      threadKeyForRow(holdMenu.row, receivedInboxByRow),
                    );
                    setHoldMenu(null);
                  }}
                >
                  <span>{tab.icon}</span>
                  <span className="truncate">{tab.name}</span>
                </button>
              ))}
            </div>
          </div>,
          document.body,
        )}

      <ReplyCustomTabDialog
        key={customTabDialog?.threadKey ?? "closed"}
        open={customTabDialog !== null}
        title="New custom tab"
        onClose={() => setCustomTabDialog(null)}
        onSave={(name, icon) => {
          if (customTabDialog) {
            onCreateCustomTab(name, icon, customTabDialog.threadKey);
          }
          setCustomTabDialog(null);
        }}
      />
    </div>
  );
}
