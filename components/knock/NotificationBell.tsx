"use client";

import type { FeedItem } from "@knocklabs/client";
import {
  FilterStatus,
  NotificationFeed,
  formatTimestamp,
  useKnockFeed,
  useNotificationStore,
} from "@knocklabs/react";
import { useEffect, useRef, useState } from "react";

type Props = {
  onReplyClick?: (data: {
    rowId?: number;
    contact?: string;
    name?: string;
  }) => void;
};

function BellIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  );
}

function avatarInitials(name: string, contact: string): string {
  const src = name.trim() || contact.trim();
  if (!src) return "?";
  const parts = src.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return src.slice(0, 2).toUpperCase();
}

function itemMessage(item: FeedItem): string {
  const data = item.data as Record<string, unknown> | null;
  if (typeof data?.message === "string") return data.message;
  const block = item.blocks?.find(
    (b) => b.type === "markdown" || b.type === "text",
  );
  if (block && "rendered" in block && typeof block.rendered === "string") {
    return block.rendered.replace(/<[^>]+>/g, "").trim();
  }
  return "New reply";
}

function itemDisplayName(item: FeedItem): string {
  const data = item.data as Record<string, unknown> | null;
  if (typeof data?.name === "string" && data.name.trim()) return data.name.trim();
  const actor = item.actors?.[0] as { name?: string } | undefined;
  if (actor?.name) return actor.name;
  if (typeof data?.contact === "string") return data.contact;
  return "Contact";
}

export default function NotificationBell({ onReplyClick }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const { feedClient } = useKnockFeed();

  const unseenCount = useNotificationStore(
    feedClient,
    (s) => s.metadata?.unseen_count ?? s.metadata?.unread_count ?? 0,
  );

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    if (open) document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={
          unseenCount > 0
            ? `Notifications, ${unseenCount} unread`
            : "Notifications"
        }
        aria-expanded={open}
        className="btn-press relative inline-flex h-8 w-8 items-center justify-center rounded-full border border-white/15 bg-white/5 text-slate-200 transition hover:border-cyan-400/40 hover:bg-cyan-500/10 hover:text-white"
      >
        <BellIcon className="h-4 w-4" />
        {unseenCount > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-rose-500 px-1 text-[10px] font-bold leading-none text-white shadow-[0_0_8px_rgba(244,63,94,0.6)]">
            {unseenCount > 99 ? "99+" : unseenCount}
          </span>
        )}
      </button>

      {open && (
        <div
          className="absolute right-0 top-full z-[200] mt-2 w-[min(380px,calc(100vw-2rem))] overflow-hidden rounded-xl border border-white/15 bg-slate-950 shadow-[0_16px_48px_rgba(0,0,0,0.55)]"
          role="dialog"
          aria-label="Notifications"
        >
          <div className="max-h-[min(420px,70vh)] overflow-auto [&_.rnf-notification-feed]:!border-0 [&_.rnf-notification-feed]:!bg-transparent">
            <NotificationFeed
              initialFilterStatus={FilterStatus.All}
              renderHeader={({
                filterStatus,
                setFilterStatus,
                onMarkAllAsReadClick,
              }) => (
                <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-white/10 bg-slate-950/95 px-4 py-3">
                  <h3 className="flex-1 text-sm font-semibold text-slate-100">
                    Notifications
                  </h3>
                  <div className="relative">
                    <select
                      value={filterStatus}
                      onChange={(e) =>
                        setFilterStatus(e.target.value as FilterStatus)
                      }
                      className="appearance-none rounded-lg border border-white/10 bg-slate-900/80 py-1 pl-2 pr-7 text-xs text-slate-300 outline-none focus:border-cyan-400/40"
                      aria-label="Filter notifications"
                    >
                      <option value={FilterStatus.All}>All</option>
                      <option value={FilterStatus.Unread}>Unread</option>
                      <option value={FilterStatus.Unseen}>Unseen</option>
                    </select>
                    <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-slate-500">
                      ▾
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={(e) => onMarkAllAsReadClick?.(e, [])}
                    className="inline-flex items-center gap-1 text-[11px] text-slate-400 transition hover:text-cyan-300"
                  >
                    <span className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-slate-500/60 text-[9px]">
                      ✓
                    </span>
                    Mark all as read
                  </button>
                </div>
              )}
              renderItem={({ item }) => {
                const unread = !item.read_at;
                const name = itemDisplayName(item);
                const message = itemMessage(item);
                const data = item.data as Record<string, unknown> | null;
                const contact =
                  typeof data?.contact === "string" ? data.contact : "";
                const time = item.inserted_at
                  ? formatTimestamp(item.inserted_at)
                  : "";

                return (
                  <button
                    type="button"
                    className="flex w-full gap-3 border-b border-white/5 px-4 py-3 text-left transition hover:bg-white/5"
                    onClick={() => {
                      void feedClient.markAsRead(item);
                      void feedClient.markAsSeen(item);
                      setOpen(false);
                      onReplyClick?.({
                        rowId:
                          typeof data?.rowId === "number"
                            ? data.rowId
                            : undefined,
                        contact: contact || undefined,
                        name: name || undefined,
                      });
                    }}
                  >
                    {unread && (
                      <span
                        className="mt-2 h-2 w-2 shrink-0 rounded-full bg-sky-400 shadow-[0_0_6px_rgba(56,189,248,0.8)]"
                        aria-hidden
                      />
                    )}
                    {!unread && <span className="w-2 shrink-0" />}
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-cyan-500/30 to-slate-700 text-xs font-semibold text-cyan-100">
                      {avatarInitials(name, contact)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <p className="text-xs leading-snug text-slate-300">
                        New reply from{" "}
                        <span className="font-semibold text-slate-100">
                          {name}
                        </span>
                        :
                      </p>
                      <p className="mt-1.5 border-l-2 border-slate-600 pl-2 text-xs leading-relaxed text-slate-400">
                        {message}
                      </p>
                      {time && (
                        <p className="mt-2 text-[11px] text-slate-500">
                          {time}
                        </p>
                      )}
                    </span>
                  </button>
                );
              }}
              EmptyComponent={
                <p className="px-4 py-8 text-center text-sm text-slate-500">
                  No notifications yet
                </p>
              }
            />
          </div>
        </div>
      )}
    </div>
  );
}
