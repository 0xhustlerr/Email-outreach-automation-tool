"use client";

import { useEffect, useState } from "react";
import type { SavedContact } from "@/lib/contacts-store";
import {
  githubLogin,
  keyAfterEdit,
  keyForManualContact,
  withScheme,
} from "@/lib/contact-key";

// Add / Edit a contact by hand. Adding merges into an existing card with the
// same key (e.g. a GitHub person a scan already saved); editing REPLACES the
// card's fields, so a phone can be deleted or a country cleared. An edit that
// adds a GitHub login moves the card onto that login's key - merging, after
// a confirm, into the scan's card when one is already there.

type Fields = {
  name: string;
  country: string;
  emails: string;
  githubUrl: string;
  upworkUrl: string;
  linkedinUrl: string;
  phones: string;
  telegrams: string;
};

/**
 * Contacts from the old Add-by-URL bar can hold a non-GitHub link (and its
 * login) in profileUrl. The form has no field for it, so it's left out of
 * the GitHub field and never sent - the edit keeps it as saved.
 */
const hasLegacyProfile = (c?: SavedContact): boolean =>
  !!c?.profileUrl && githubLogin(c.profileUrl) === null;

function fieldsFrom(c?: SavedContact): Fields {
  return {
    name: c?.name ?? "",
    country: c?.country ?? "",
    emails: c?.emails.join(", ") ?? "",
    githubUrl: hasLegacyProfile(c) ? "" : (c?.profileUrl ?? ""),
    upworkUrl: c?.attachedUrl ?? "",
    linkedinUrl: c?.linkedinUrl ?? "",
    phones: c?.phones.join(", ") ?? "",
    telegrams: c?.telegrams.join(", ") ?? "",
  };
}

const splitList = (v: string): string[] =>
  v
    .split(/[,;\n]/)
    .map((s) => s.trim())
    .filter(Boolean);

const INPUT =
  "w-full rounded-full border border-white/10 bg-slate-950/70 px-4 py-2 text-sm text-slate-100 outline-none transition focus:border-cyan-400 focus:ring-2 focus:ring-cyan-400/30";
const LABEL =
  "mb-1 block text-[11px] font-medium uppercase tracking-[0.22em] text-slate-400";

const FIELDS: { id: keyof Fields; label: string; placeholder: string; wide?: boolean }[] = [
  { id: "name", label: "Name", placeholder: "Jane Doe" },
  { id: "country", label: "Country", placeholder: "Germany" },
  { id: "emails", label: "Email", placeholder: "jane@example.com", wide: true },
  { id: "githubUrl", label: "GitHub URL", placeholder: "github.com/username", wide: true },
  { id: "upworkUrl", label: "Upwork URL", placeholder: "upwork.com/freelancers/~…", wide: true },
  { id: "linkedinUrl", label: "LinkedIn URL", placeholder: "linkedin.com/in/…", wide: true },
  { id: "phones", label: "Phone", placeholder: "+14155550123" },
  { id: "telegrams", label: "Telegram", placeholder: "@handle" },
];

export default function ContactFormModal({
  initial,
  contacts,
  onClose,
  onSaved,
}: {
  /** Set = edit this contact; unset = add a new one. */
  initial?: SavedContact;
  /** Every saved contact - to warn before an edit merges into another card. */
  contacts: SavedContact[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const editing = !!initial;
  const [fields, setFields] = useState<Fields>(() => fieldsFrom(initial));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // Don't let the Contacts modal underneath close too.
        e.stopImmediatePropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const onSave = async () => {
    const githubUrl = fields.githubUrl.trim();
    const upworkUrl = withScheme(fields.upworkUrl);
    const linkedinUrl = withScheme(fields.linkedinUrl);
    const login = githubUrl ? githubLogin(githubUrl) : null;
    if (githubUrl && !login) {
      setError("GitHub URL must look like github.com/username.");
      return;
    }
    const legacyProfile = hasLegacyProfile(initial);
    if (!fields.name.trim() && !githubUrl && !upworkUrl && !linkedinUrl && !legacyProfile) {
      setError("Enter at least a name or one URL.");
      return;
    }
    // Omitted = keep the saved legacy link; otherwise GitHub (or "" = clear).
    const github =
      legacyProfile && !login
        ? {}
        : { login: login ?? "", profileUrl: login ? `https://github.com/${login}` : "" };

    const key = initial
      ? keyAfterEdit(initial.key, githubUrl)
      : keyForManualContact({ githubUrl, upworkUrl, linkedinUrl });
    const mergeInto =
      initial && key !== initial.key ? contacts.find((c) => c.key === key) : undefined;
    if (
      mergeInto &&
      !window.confirm(
        `"${mergeInto.name || mergeInto.login}" is already saved under ${githubUrl}. ` +
          `Merge this contact into that card? Its phones, emails and handles are kept; ` +
          `fields you filled in here win.`,
      )
    ) {
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/contacts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key,
          ...github,
          name: fields.name,
          country: fields.country,
          emails: splitList(fields.emails),
          phones: splitList(fields.phones),
          telegrams: splitList(fields.telegrams).map((t) => t.replace(/^@/, "")),
          attachedUrl: upworkUrl,
          linkedinUrl,
          ...(initial ? { replace: true, fromKey: initial.key } : { direct: true }),
        }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Failed to save.");
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save contact.");
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/80 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <form
        className="flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-white/10 bg-slate-900 shadow-2xl"
        onSubmit={(e) => {
          e.preventDefault();
          void onSave();
        }}
      >
        <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
          <h2 className="text-sm font-semibold uppercase tracking-[0.22em] text-slate-200">
            {editing ? "Edit contact" : "Add contact"}
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

        <div className="grid min-h-0 flex-1 grid-cols-2 gap-x-3 gap-y-3 overflow-y-auto px-5 py-4">
          {FIELDS.map((field) => (
            <div key={field.id} className={field.wide ? "col-span-2" : ""}>
              <label htmlFor={`cf-${field.id}`} className={LABEL}>
                {field.label}
              </label>
              <input
                id={`cf-${field.id}`}
                type="text"
                value={fields[field.id]}
                onChange={(e) => setFields((prev) => ({ ...prev, [field.id]: e.target.value }))}
                placeholder={field.placeholder}
                autoFocus={field.id === "name"}
                className={INPUT}
              />
            </div>
          ))}
          <p className="col-span-2 text-[11px] text-slate-500">
            Separate several emails, phones or handles with commas.
            {editing && " Emails already sent to stay blocked from a new opener even if removed here."}
          </p>
        </div>

        {error && <p className="px-5 pb-1 text-xs text-rose-300">{error}</p>}

        <div className="flex items-center justify-end gap-3 border-t border-white/10 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-full px-4 py-2 text-sm text-slate-400 transition hover:text-white"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving}
            data-ripple
            className="btn-press rounded-full border border-cyan-400/40 bg-cyan-500/15 px-5 py-2 text-sm font-medium text-cyan-100 transition hover:border-cyan-300 hover:bg-cyan-400/25 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            {saving ? "Saving…" : editing ? "Save changes" : "Add contact"}
          </button>
        </div>
      </form>
    </div>
  );
}
