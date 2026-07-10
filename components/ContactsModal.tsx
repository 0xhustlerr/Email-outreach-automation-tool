"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import GmailAvatar from "@/components/GmailAvatar";

// Saved-contacts browser: every profile a scan has discovered, with its
// GitHub URL, email addresses, phone numbers and telegram handles - all
// served from the local database. Contacts can also be added manually by
// pasting a URL.

export type SavedContact = {
  key: string;
  login: string;
  profileUrl: string;
  name: string;
  country: string;
  emails: string[];
  phones: string[];
  telegrams: string[];
  updatedAt: string;
  direct: boolean;
  attachedUrl: string;
  sentEmails: string[];
  lastSentAt: string | null;
  special: boolean;
};

export type ContactsFilter = "special" | "emailed" | "phone" | "all";

const FILTERS: { id: ContactsFilter; label: string }[] = [
  { id: "special", label: "★ Special" },
  { id: "emailed", label: "Emailed" },
  { id: "phone", label: "Has phone" },
  { id: "all", label: "All" },
];

function keyFromUrl(raw: string): { key: string; login: string; url: string } | null {
  let input = raw.trim();
  if (!input) return null;
  if (!/^https?:\/\//i.test(input)) input = `https://${input}`;
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\./i, "").toLowerCase();
  const firstSeg = u.pathname.split("/").filter(Boolean)[0] ?? "";
  if (host === "github.com" && firstSeg) {
    return { key: firstSeg.toLowerCase(), login: firstSeg, url: `https://github.com/${firstSeg}` };
  }
  const key = `${host}${u.pathname}`.replace(/\/+$/, "").toLowerCase();
  return { key, login: firstSeg || host, url: u.toString() };
}

export default function ContactsModal({
  onClose,
  onSendEmail,
  initialFilter = "special",
}: {
  onClose: () => void;
  onSendEmail: (email: string, contact: SavedContact) => void;
  initialFilter?: ContactsFilter;
}) {
  const [contacts, setContacts] = useState<SavedContact[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("");
  const [category, setCategory] = useState<ContactsFilter>(initialFilter);
  const [addUrl, setAddUrl] = useState("");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/contacts");
      const data = (await res.json()) as { ok?: boolean; contacts?: SavedContact[] };
      if (res.ok && data.ok) setContacts(data.contacts ?? []);
    } catch {
      setError("Failed to load contacts.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const onAdd = async () => {
    const parsed = keyFromUrl(addUrl);
    if (!parsed) {
      setError("Enter a valid URL (e.g. github.com/username).");
      return;
    }
    setAdding(true);
    setError(null);
    try {
      const res = await fetch("/api/contacts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key: parsed.key,
          login: parsed.login,
          profileUrl: parsed.url,
        }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Failed to add.");
      setAddUrl("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add contact.");
    } finally {
      setAdding(false);
    }
  };

  const onDelete = async (c: SavedContact) => {
    if (!window.confirm(`Remove contact "${c.name || c.login || c.key}"?`)) return;
    await fetch(`/api/contacts?key=${encodeURIComponent(c.key)}`, {
      method: "DELETE",
    }).catch(() => {});
    await refresh();
  };

  const shown = useMemo(() => {
    let list = contacts;
    if (category === "special") list = list.filter((c) => c.special);
    else if (category === "emailed") list = list.filter((c) => c.sentEmails.length > 0);
    else if (category === "phone") list = list.filter((c) => c.phones.length > 0);

    const q = filter.trim().toLowerCase();
    if (!q) return list;
    return list.filter((c) =>
      [c.login, c.name, c.country, c.profileUrl, c.attachedUrl, ...c.emails, ...c.phones, ...c.telegrams]
        .join(" ")
        .toLowerCase()
        .includes(q),
    );
  }, [contacts, filter, category]);

  const countFor = (f: ContactsFilter): number =>
    f === "special"
      ? contacts.filter((c) => c.special).length
      : f === "emailed"
        ? contacts.filter((c) => c.sentEmails.length > 0).length
        : f === "phone"
          ? contacts.filter((c) => c.phones.length > 0).length
          : contacts.length;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-white/10 bg-slate-900 shadow-2xl">
        <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
          <h2 className="text-sm font-semibold uppercase tracking-[0.22em] text-slate-200">
            Contacts
            <span className="ml-2 text-slate-500">({contacts.length})</span>
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full px-2 py-1 text-slate-400 transition hover:text-white"
            title="Close"
          >
            ✕
          </button>
        </div>

        {/* Add by URL + search */}
        <div className="flex flex-col gap-2 border-b border-white/10 px-5 py-3 md:flex-row">
          <div className="flex flex-1 gap-2">
            <input
              type="text"
              value={addUrl}
              onChange={(e) => setAddUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void onAdd();
              }}
              placeholder="Add by URL - github.com/username or any profile link"
              className="w-full rounded-full border border-white/10 bg-slate-950/70 px-4 py-2 text-sm text-slate-100 outline-none transition focus:border-cyan-400 focus:ring-2 focus:ring-cyan-400/30"
            />
            <button
              type="button"
              onClick={() => void onAdd()}
              disabled={adding || !addUrl.trim()}
              data-ripple
              className="btn-press shrink-0 rounded-full border border-cyan-400/40 bg-cyan-500/15 px-4 py-2 text-sm font-medium text-cyan-100 transition hover:border-cyan-300 hover:bg-cyan-400/25 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
            >
              {adding ? "Adding…" : "+ Add"}
            </button>
          </div>
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Search…"
            className="w-full rounded-full border border-white/10 bg-slate-950/70 px-4 py-2 text-sm text-slate-100 outline-none transition focus:border-cyan-400 focus:ring-2 focus:ring-cyan-400/30 md:w-48"
          />
        </div>

        {/* Category chips */}
        <div className="flex flex-wrap items-center gap-2 border-b border-white/10 px-5 py-2.5">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setCategory(f.id)}
              className={
                "rounded-full border px-3 py-1 text-xs font-medium transition " +
                (category === f.id
                  ? "border-cyan-400/60 bg-cyan-500/15 text-cyan-100"
                  : "border-white/10 bg-slate-950/50 text-slate-400 hover:border-white/25 hover:text-white")
              }
            >
              {f.label}
              <span className="ml-1.5 text-[10px] opacity-70">{countFor(f.id)}</span>
            </button>
          ))}
        </div>

        {error && (
          <p className="px-5 pt-2 text-xs text-rose-300">{error}</p>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {loading ? (
            <p className="text-sm text-slate-400">Loading…</p>
          ) : shown.length === 0 ? (
            <p className="text-sm text-slate-400">
              {contacts.length === 0
                ? "No saved contacts yet - send an email from a scan, use ☆ on a found phone/telegram, or add one by URL above."
                : "No contacts match this filter."}
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              {shown.map((c) => (
                <div
                  key={c.key}
                  className="rounded-xl border border-white/10 bg-slate-950/50 p-4"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-3">
                      {c.emails[0] ? (
                        <GmailAvatar
                          email={c.emails[0]}
                          size={36}
                          fallback={
                            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-cyan-500/15 text-sm font-semibold text-cyan-200">
                              {(c.name || c.login || "?").slice(0, 1).toUpperCase()}
                            </span>
                          }
                        />
                      ) : (
                        <span className="flex h-9 w-9 items-center justify-center rounded-full bg-cyan-500/15 text-sm font-semibold text-cyan-200">
                          {(c.name || c.login || "?").slice(0, 1).toUpperCase()}
                        </span>
                      )}
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-slate-100">
                          {c.name || c.login || c.key}
                          {c.country && (
                            <span className="ml-2 text-xs text-slate-500">
                              {c.country}
                            </span>
                          )}
                          {c.special && (
                            <span
                              className="ml-2 text-xs text-amber-300"
                              title="Special contact - has a phone/telegram fallback"
                            >
                              ★
                            </span>
                          )}
                          {c.direct && (
                            <span className="ml-2 rounded-full border border-amber-400/30 bg-amber-500/10 px-2 py-0.5 text-[10px] uppercase tracking-wider text-amber-200">
                              saved directly
                            </span>
                          )}
                          {c.lastSentAt && (
                            <span className="ml-2 text-[10px] uppercase tracking-wider text-slate-500">
                              sent {new Date(c.lastSentAt).toLocaleDateString()}
                            </span>
                          )}
                        </p>
                        {c.profileUrl && (
                          <a
                            href={c.profileUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="block truncate text-xs text-cyan-300 hover:text-cyan-200 hover:underline"
                            title="Open profile"
                          >
                            {c.profileUrl.replace(/^https?:\/\//, "")}
                          </a>
                        )}
                        {c.attachedUrl && (
                          <a
                            href={/^https?:\/\//i.test(c.attachedUrl) ? c.attachedUrl : `https://${c.attachedUrl}`}
                            target="_blank"
                            rel="noreferrer"
                            className="block truncate text-xs text-slate-400 hover:text-slate-200 hover:underline"
                            title="Attached URL"
                          >
                            🔗 {c.attachedUrl.replace(/^https?:\/\//, "")}
                          </a>
                        )}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => void onDelete(c)}
                      className="shrink-0 rounded-full px-2 py-1 text-xs text-slate-500 transition hover:text-rose-300"
                      title="Remove contact"
                    >
                      Remove
                    </button>
                  </div>

                  {(c.emails.length > 0 || c.phones.length > 0 || c.telegrams.length > 0) && (
                    <div className="mt-3 flex flex-col gap-1.5">
                      {c.emails.map((e) => {
                        const wasSent = c.sentEmails.some(
                          (s) => s.toLowerCase() === e.toLowerCase(),
                        );
                        return (
                          <div key={e} className="flex items-center justify-between gap-2">
                            <span className="flex min-w-0 items-center gap-2">
                              <span className="truncate font-mono text-[13px] text-slate-200">
                                {e}
                              </span>
                              {wasSent && (
                                <span className="shrink-0 rounded-full border border-emerald-400/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-emerald-300">
                                  ✓ sent
                                </span>
                              )}
                            </span>
                            <button
                              type="button"
                              onClick={() => onSendEmail(e, c)}
                              data-ripple
                              className={
                                "btn-press shrink-0 rounded-full border px-3 py-0.5 text-xs font-medium transition " +
                                (wasSent
                                  ? "border-emerald-400/30 bg-emerald-500/10 text-emerald-200 hover:border-emerald-300/80 hover:bg-emerald-400/20 hover:text-white"
                                  : "border-cyan-400/30 bg-cyan-500/10 text-cyan-200 hover:border-cyan-300/80 hover:bg-cyan-400/20 hover:text-white")
                              }
                            >
                              {wasSent ? "Send again" : "Send"}
                            </button>
                          </div>
                        );
                      })}
                      {c.phones.map((p) => (
                        <div key={p} className="flex items-center justify-between gap-2">
                          <span className="truncate font-mono text-[13px] text-emerald-200">
                            {p}
                          </span>
                          <a
                            href={`tel:${p.replace(/[^\d+]/g, "")}`}
                            className="shrink-0 rounded-full border border-emerald-400/30 bg-emerald-500/10 px-3 py-0.5 text-xs font-medium text-emerald-200 transition hover:border-emerald-300/80 hover:bg-emerald-400/20 hover:text-white"
                          >
                            Call
                          </a>
                        </div>
                      ))}
                      {c.telegrams.map((t) => (
                        <div key={t} className="flex items-center justify-between gap-2">
                          <span className="truncate font-mono text-[13px] text-sky-200">
                            @{t.replace(/^@/, "")}
                          </span>
                          <a
                            href={`https://t.me/${t.replace(/^@/, "")}`}
                            target="_blank"
                            rel="noreferrer"
                            className="shrink-0 rounded-full border border-sky-400/30 bg-sky-500/10 px-3 py-0.5 text-xs font-medium text-sky-200 transition hover:border-sky-300/80 hover:bg-sky-400/20 hover:text-white"
                          >
                            Open
                          </a>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
