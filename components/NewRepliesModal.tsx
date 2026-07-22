"use client";

import { useCallback, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import type { SheetHistoryRow } from "@/lib/sheets";
import { primaryEmail, rowKey } from "@/lib/sheet-active";

export type GmailReplyPreview = {
  id: string;
  subject: string;
  from: string;
  date: string;
  snippet: string;
  bodyText: string;
  bodyHtml: string;
};

type Props = {
  rows: SheetHistoryRow[];
  onClose: () => void;
  onMarkSeen: (rowId: number) => void;
};

const COLUMNS: { key: keyof SheetHistoryRow; label: string }[] = [
  { key: "name", label: "Name" },
  { key: "date", label: "Date" },
  { key: "contact", label: "Contact" },
  { key: "sender", label: "Sender" },
  { key: "site", label: "Site" },
  { key: "country", label: "Country" },
];

function formatDate(iso: string): string {
  if (!iso.trim()) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function NewRepliesModal({ rows, onClose, onMarkSeen }: Props) {
  const [selectedKey, setSelectedKey] = useState<number | null>(null);
  const [loadingMsg, setLoadingMsg] = useState(false);
  const [msgError, setMsgError] = useState<string | null>(null);
  const [preview, setPreview] = useState<GmailReplyPreview | null>(null);

  const loadMessage = useCallback(async (row: SheetHistoryRow) => {
    const key = rowKey(row);
    if (!key) return;
    setSelectedKey(key);
    setLoadingMsg(true);
    setMsgError(null);
    setPreview(null);
    const contact = primaryEmail(row.contact);
    const sender = row.sender.trim();
    try {
      const params = new URLSearchParams({
        sender,
        contact,
        after: row.date,
      });
      const res = await fetch(`/api/gmail-reply?${params}`);
      const data = (await res.json()) as {
        ok?: boolean;
        message?: GmailReplyPreview | null;
        error?: string;
      };
      if (!res.ok || !data.ok) {
        throw new Error(data.error ?? "Failed to load message.");
      }
      setPreview(data.message ?? null);
      if (!data.message) {
        setMsgError("No message found in Gmail for this contact.");
      }
    } catch (err) {
      setMsgError(
        err instanceof Error ? err.message : "Failed to load message.",
      );
    } finally {
      setLoadingMsg(false);
    }
  }, []);

  const dismissRow = (row: SheetHistoryRow, e: React.MouseEvent) => {
    const key = rowKey(row);
    if (!key) return;
    e.stopPropagation();
    onMarkSeen(key);
    if (selectedKey === key) {
      setSelectedKey(null);
      setPreview(null);
      setMsgError(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="new-replies-title"
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 12 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.98, y: 8 }}
        transition={{ type: "spring", stiffness: 380, damping: 32 }}
        className="flex max-h-[90vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-emerald-500/30 bg-slate-950/95 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-white/10 px-5 py-4">
          <div>
            <h2
              id="new-replies-title"
              className="text-lg font-semibold text-emerald-100"
            >
              New replies
            </h2>
            <p className="text-xs text-slate-400">
              Click a contact email to read the message. Click a column cell to
              dismiss only that row.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-white/10 px-3 py-1 text-xs text-slate-300 hover:bg-white/10 hover:text-white"
          >
            Close
          </button>
        </header>

        <div className="flex min-h-0 flex-1 flex-col gap-0 md:flex-row">
          <div className="min-h-0 flex-1 overflow-auto">
            {rows.length === 0 ? (
              <p className="p-6 text-center text-sm text-slate-500">
                No new replies right now.
              </p>
            ) : (
              <table className="w-full min-w-[640px] border-collapse text-left text-xs">
                <thead className="sticky top-0 z-10 bg-slate-900/95 text-[10px] uppercase tracking-wider text-slate-500">
                  <tr>
                    {COLUMNS.map((col) => (
                      <th key={col.key} className="px-3 py-2.5 font-medium">
                        {col.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const key = rowKey(row);
                    const active = key === selectedKey;
                    return (
                      <tr
                        key={key ?? `${row.contact}-${row.date}`}
                        className={`border-t border-white/5 transition ${
                          active ? "bg-emerald-500/10" : "hover:bg-white/5"
                        }`}
                      >
                        {COLUMNS.map((col) => {
                          const raw = row[col.key];
                          const text =
                            raw == null || raw === "" ? "-" : String(raw);
                          if (col.key === "contact") {
                            const email = primaryEmail(row.contact);
                            return (
                              <td key={col.key} className="px-3 py-2.5">
                                <button
                                  type="button"
                                  onClick={() => void loadMessage(row)}
                                  className="max-w-[200px] truncate text-left font-medium text-cyan-300 underline decoration-cyan-500/40 underline-offset-2 hover:text-cyan-200"
                                >
                                  {email || text}
                                </button>
                              </td>
                            );
                          }
                          if (col.key === "date") {
                            return (
                              <td
                                key={col.key}
                                className="cursor-pointer whitespace-nowrap px-3 py-2.5 text-slate-300"
                                onClick={(e) => dismissRow(row, e)}
                                title="Dismiss this reply from alerts"
                              >
                                {formatDate(row.date)}
                              </td>
                            );
                          }
                          return (
                            <td
                              key={col.key}
                              className="max-w-[140px] cursor-pointer truncate px-3 py-2.5 text-slate-300"
                              onClick={(e) => dismissRow(row, e)}
                              title="Dismiss this reply from alerts"
                            >
                              {text}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>

          <AnimatePresence mode="wait">
            {(selectedKey != null || loadingMsg || preview || msgError) && (
              <motion.aside
                key={selectedKey ?? "panel"}
                initial={{ opacity: 0, x: 16 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 12 }}
                className="flex w-full flex-col border-t border-white/10 bg-slate-900/80 md:w-[min(420px,42%)] md:border-l md:border-t-0"
              >
                <div className="border-b border-white/10 px-4 py-3">
                  <h3 className="text-sm font-medium text-slate-200">
                    Reply message
                  </h3>
                </div>
                <div className="flex-1 overflow-auto p-4">
                  {loadingMsg && (
                    <p className="text-sm text-slate-400">Loading from Gmail…</p>
                  )}
                  {msgError && !loadingMsg && (
                    <p className="text-sm text-rose-300">{msgError}</p>
                  )}
                  {preview && !loadingMsg && (
                    <div className="space-y-3 text-sm">
                      <div>
                        <p className="text-[10px] uppercase tracking-wider text-slate-500">
                          From
                        </p>
                        <p className="text-slate-200">{preview.from}</p>
                      </div>
                      <div>
                        <p className="text-[10px] uppercase tracking-wider text-slate-500">
                          Subject
                        </p>
                        <p className="font-medium text-slate-100">
                          {preview.subject || "(no subject)"}
                        </p>
                      </div>
                      <div>
                        <p className="text-[10px] uppercase tracking-wider text-slate-500">
                          Date
                        </p>
                        <p className="text-slate-300">{preview.date}</p>
                      </div>
                      <div className="rounded-lg border border-white/10 bg-black/30 p-3">
                        <p className="mb-2 text-[10px] uppercase tracking-wider text-slate-500">
                          Body
                        </p>
                        <pre className="whitespace-pre-wrap font-sans text-xs leading-relaxed text-slate-200">
                          {preview.bodyText || preview.snippet || "-"}
                        </pre>
                      </div>
                    </div>
                  )}
                  {!loadingMsg && !preview && !msgError && selectedKey && (
                    <p className="text-sm text-slate-500">
                      Select a contact email to load the reply.
                    </p>
                  )}
                </div>
              </motion.aside>
            )}
          </AnimatePresence>
        </div>
      </motion.div>
    </div>
  );
}
