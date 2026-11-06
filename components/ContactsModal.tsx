"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import ContactFormModal from "@/components/ContactFormModal";
import GmailAvatar from "@/components/GmailAvatar";
import {
  Card,
  EmptyState,
  PageBody,
  PageHeader,
  SearchInput,
  Segmented,
  Toolbar,
} from "@/components/ui/dashboard";
import { withScheme } from "@/lib/contact-key";
import type { SavedContact } from "@/lib/contacts-store";

// Saved-contacts browser: every profile a scan has discovered, with its
// GitHub URL, email addresses, phone numbers and telegram handles - all
// served from the local database. Contacts can also be added or edited by
// hand through ContactFormModal.

export type { SavedContact };

export type ContactsFilter = "special" | "emailed" | "phone" | "all";

const FILTERS: { id: ContactsFilter; label: string }[] = [
  { id: "special", label: "Special" },
  { id: "emailed", label: "Emailed" },
  { id: "phone", label: "Has phone" },
  { id: "all", label: "All" },
];

function UsersIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

function PlusIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className={className} aria-hidden>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function MailIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="m22 7-10 6L2 7" />
    </svg>
  );
}

function PhoneIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z" />
    </svg>
  );
}

function SendIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d="m22 2-7 20-4-9-9-4z" />
      <path d="M22 2 11 13" />
    </svg>
  );
}

/** One contact channel: icon, value, trailing badges and an action button. */
function ChannelRow({
  icon,
  value,
  valueClass,
  badge,
  action,
}: {
  icon: ReactNode;
  value: ReactNode;
  valueClass: string;
  badge?: ReactNode;
  action: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-2 py-1.5">
      <span className="flex min-w-0 items-center gap-2">
        <span className="shrink-0 text-slate-500">{icon}</span>
        <span className={"truncate font-mono text-[13px] " + valueClass}>{value}</span>
        {badge}
      </span>
      <span className="shrink-0">{action}</span>
    </div>
  );
}

function Initial({ c }: { c: SavedContact }) {
  return (
    <span className="flex h-10 w-10 items-center justify-center rounded-full bg-cyan-500/15 text-sm font-semibold text-cyan-200">
      {(c.name || c.login || "?").slice(0, 1).toUpperCase()}
    </span>
  );
}

export default function ContactsModal({
  onSendEmail,
  initialFilter = "special",
}: {
  onClose: () => void;
  asPage?: boolean;
  onSendEmail: (email: string, contact: SavedContact) => void;
  initialFilter?: ContactsFilter;
}) {
  const [contacts, setContacts] = useState<SavedContact[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("");
  const [category, setCategory] = useState<ContactsFilter>(initialFilter);
  // null = form closed; "new" = add; a contact = edit that one.
  const [form, setForm] = useState<SavedContact | "new" | null>(null);
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
      [c.login, c.name, c.country, c.profileUrl, c.attachedUrl, c.linkedinUrl, ...c.emails, ...c.phones, ...c.telegrams]
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
    <PageBody>
      <PageHeader
        title="Contacts"
        description="Everyone a scan discovered or you saved by hand, with their emails, phones and handles."
        icon={<UsersIcon className="h-5 w-5" />}
        meta={
          !loading && (
            <span className="badge badge-neutral tabular-nums">{contacts.length}</span>
          )
        }
        actions={
          <button
            type="button"
            onClick={() => setForm("new")}
            data-ripple
            className="btn btn-primary"
          >
            <PlusIcon className="h-4 w-4" />
            Add contact
          </button>
        }
      />

      <Toolbar>
        <SearchInput value={filter} onChange={setFilter} placeholder="Search contacts…" />
        <div className="max-w-full overflow-x-auto">
          <Segmented
            value={category}
            onChange={setCategory}
            options={FILTERS.map((f) => ({
              value: f.id,
              label: f.label,
              count: countFor(f.id),
              icon:
                f.id === "special" ? (
                  <span className="text-amber-300" aria-hidden>
                    ★
                  </span>
                ) : undefined,
            }))}
          />
        </div>
      </Toolbar>

      {error && (
        <p className="rounded-lg border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
          {error}
        </p>
      )}

      {loading ? (
        <Card>
          <p className="text-sm text-slate-400">Loading…</p>
        </Card>
      ) : shown.length === 0 ? (
        <Card flush>
          <EmptyState
            icon={<UsersIcon className="h-5 w-5" />}
            title={contacts.length === 0 ? "No saved contacts yet" : "No contacts match"}
            description={
              contacts.length === 0
                ? "Send an email from a scan, use ☆ on a found phone/telegram, or add one by hand."
                : "No contacts match this filter."
            }
            action={
              contacts.length === 0 ? (
                <button type="button" onClick={() => setForm("new")} className="btn btn-secondary btn-sm">
                  <PlusIcon className="h-3.5 w-3.5" />
                  Add contact
                </button>
              ) : undefined
            }
          />
        </Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
          {shown.map((c) => {
            const hasChannels = c.emails.length > 0 || c.phones.length > 0 || c.telegrams.length > 0;
            return (
              <div key={c.key} className="card flex min-w-0 flex-col p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-start gap-3">
                    <span className="shrink-0">
                      {c.emails[0] ? (
                        <GmailAvatar email={c.emails[0]} size={40} fallback={<Initial c={c} />} />
                      ) : (
                        <Initial c={c} />
                      )}
                    </span>
                    <div className="min-w-0">
                      <p className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate text-sm font-semibold text-slate-100">
                          {c.name || c.login || c.key}
                        </span>
                        {c.special && (
                          <span
                            className="shrink-0 text-xs text-amber-300"
                            title="Special contact - has a phone/telegram fallback"
                          >
                            ★
                          </span>
                        )}
                      </p>
                      {c.country && (
                        <p className="truncate text-xs text-slate-500">{c.country}</p>
                      )}
                      {(c.direct || c.lastSentAt) && (
                        <div className="mt-1.5 flex flex-wrap gap-1.5">
                          {c.direct && <span className="badge badge-warning">Saved directly</span>}
                          {c.lastSentAt && (
                            <span className="badge badge-neutral tabular-nums">
                              Sent {new Date(c.lastSentAt).toLocaleDateString()}
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="-mr-1.5 -mt-1 flex shrink-0 items-center">
                    <button
                      type="button"
                      onClick={() => setForm(c)}
                      className="btn btn-ghost btn-sm"
                      title="Edit contact"
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => void onDelete(c)}
                      className="btn btn-ghost btn-sm hover:!text-rose-300"
                      title="Remove contact"
                    >
                      Remove
                    </button>
                  </div>
                </div>

                {(c.profileUrl || c.attachedUrl || c.linkedinUrl) && (
                  <div className="mt-3 flex flex-col gap-0.5 pl-[3.25rem]">
                    {c.profileUrl && (
                      <a
                        href={c.profileUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="truncate text-xs text-cyan-300 hover:text-cyan-200 hover:underline"
                        title="Open profile"
                      >
                        {c.profileUrl.replace(/^https?:\/\//, "")}
                      </a>
                    )}
                    {c.attachedUrl && (
                      <a
                        href={withScheme(c.attachedUrl)}
                        target="_blank"
                        rel="noreferrer"
                        className="truncate text-xs text-slate-400 hover:text-slate-200 hover:underline"
                        title="Attached URL"
                      >
                        🔗 {c.attachedUrl.replace(/^https?:\/\//, "")}
                      </a>
                    )}
                    {c.linkedinUrl && (
                      <a
                        href={withScheme(c.linkedinUrl)}
                        target="_blank"
                        rel="noreferrer"
                        className="truncate text-xs text-slate-400 hover:text-slate-200 hover:underline"
                        title="LinkedIn"
                      >
                        in {c.linkedinUrl.replace(/^https?:\/\/(www\.)?/, "")}
                      </a>
                    )}
                  </div>
                )}

                {hasChannels && (
                  <div className="mt-3 flex flex-col divide-y divide-white/5 border-t border-white/5 pt-1.5">
                    {c.emails.map((e) => {
                      const wasSent = c.sentEmails.some(
                        (s) => s.toLowerCase() === e.toLowerCase(),
                      );
                      return (
                        <ChannelRow
                          key={e}
                          icon={<MailIcon className="h-3.5 w-3.5" />}
                          value={e}
                          valueClass="text-slate-200"
                          badge={wasSent && <span className="badge badge-success shrink-0">✓ Sent</span>}
                          action={
                            <button
                              type="button"
                              onClick={() => onSendEmail(e, c)}
                              data-ripple
                              className="btn btn-secondary btn-sm"
                            >
                              <SendIcon className="h-3 w-3" />
                              {wasSent ? "Send again" : "Send"}
                            </button>
                          }
                        />
                      );
                    })}
                    {c.phones.map((p) => (
                      <ChannelRow
                        key={p}
                        icon={<PhoneIcon className="h-3.5 w-3.5" />}
                        value={p}
                        valueClass="text-emerald-200"
                        action={
                          <a href={`tel:${p.replace(/[^\d+]/g, "")}`} className="btn btn-secondary btn-sm">
                            Call
                          </a>
                        }
                      />
                    ))}
                    {c.telegrams.map((t) => (
                      <ChannelRow
                        key={t}
                        icon={<SendIcon className="h-3.5 w-3.5" />}
                        value={`@${t.replace(/^@/, "")}`}
                        valueClass="text-sky-200"
                        action={
                          <a
                            href={`https://t.me/${t.replace(/^@/, "")}`}
                            target="_blank"
                            rel="noreferrer"
                            className="btn btn-secondary btn-sm"
                          >
                            Open
                          </a>
                        }
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {form && (
        <ContactFormModal
          initial={form === "new" ? undefined : form}
          contacts={contacts}
          onClose={() => setForm(null)}
          onSaved={() => {
            setForm(null);
            void refresh();
          }}
        />
      )}
    </PageBody>
  );
}
