"use client";

import { useEffect, useState } from "react";
import { useTemplates, type UiTemplate } from "@/hooks/useTemplates";

// Manage Templates: edit existing templates or add new ones. Saved to the
// database via /api/templates and applied to all future sends.

function TrashIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d="M3 6h18" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  );
}

export default function TemplatesModal({ onClose }: { onClose: () => void }) {
  const { templates, templatesLoaded, saveTemplate, deleteTemplate } =
    useTemplates();

  // null = nothing picked yet (auto-select pending); "new" = the user
  // clicked "+ New template"; otherwise the id of the template being edited.
  const [tab, setTab] = useState<"opener" | "followup">("opener");
  const [selection, setSelection] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<
    { ok: boolean; message: string } | null
  >(null);

  const isNew = selection === "new";
  const selectedId = !isNew ? selection : null;
  const tabTemplates = templates.filter((t) => t.kind === tab);

  const loadIntoEditor = (t: UiTemplate | null) => {
    setSelection(t?.id ?? "new");
    setLabel(t?.label ?? "");
    setSubject(t?.subject ?? "");
    setBody(t?.body ?? "");
    setDirty(false);
    setFeedback(null);
  };

  // Auto-pick the first template of the active tab.
  useEffect(() => {
    if (selection !== null || tabTemplates.length === 0) return;
    loadIntoEditor(tabTemplates[0]);
  }, [tabTemplates, selection]);

  // Switching tabs resets the editor to that tab's first template.
  const switchTab = (next: "opener" | "followup") => {
    if (next === tab) return;
    setTab(next);
    setSelection(null);
    setLabel("");
    setSubject("");
    setBody("");
    setDirty(false);
    setFeedback(null);
  };

  // When the database copy lands, refresh the untouched editor so it shows
  // the saved content rather than the built-in defaults.
  useEffect(() => {
    if (!templatesLoaded || dirty || !selectedId) return;
    const t = templates.find((x) => x.id === selectedId);
    if (t) {
      setLabel(t.label);
      setSubject(t.subject);
      setBody(t.body);
    }
  }, [templatesLoaded, templates, dirty, selectedId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const onSave = async () => {
    if (busy) return;
    setBusy(true);
    setFeedback(null);
    const res = await saveTemplate({
      id: selectedId ?? undefined,
      label: label.trim(),
      subject,
      body,
      kind: tab,
    });
    setBusy(false);
    if (res.ok) {
      setDirty(false);
      if (res.id) setSelection(res.id);
      setFeedback({
        ok: true,
        message: "Saved - will be used for future messages.",
      });
    } else {
      setFeedback({ ok: false, message: res.error ?? "Failed to save." });
    }
  };

  const removeTemplate = async (id: string, name: string) => {
    if (busy) return;
    if (tabTemplates.length <= 1) {
      setFeedback({
        ok: false,
        message: `Cannot delete the last ${tab} template.`,
      });
      return;
    }
    if (!window.confirm(`Delete template "${name}"? This cannot be undone.`)) {
      return;
    }
    setBusy(true);
    const res = await deleteTemplate(id);
    setBusy(false);
    if (res.ok) {
      // If the open template was the one removed, drop back to "nothing
      // picked" so the auto-select effect moves the editor to the first
      // remaining template once the refreshed list arrives.
      if (selectedId === id) {
        setSelection(null);
        setDirty(false);
      }
      setFeedback({ ok: true, message: "Template deleted." });
    } else {
      setFeedback({ ok: false, message: res.error ?? "Failed to delete." });
    }
  };

  const onDelete = () => {
    if (!selectedId) return;
    void removeTemplate(selectedId, label);
  };

  const canSave = !!label.trim() && !!subject.trim() && !!body.trim() && !busy;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/90 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-white/10 bg-slate-900 shadow-2xl">
        <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
          <h2 className="text-sm font-semibold uppercase tracking-[0.22em] text-slate-200">
            Manage templates
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

        {/* Tabs: Message 1 (opener) / Message 2 (follow-up) */}
        <div className="flex gap-1 border-b border-white/10 px-5 pt-3">
          {(
            [
              { id: "opener", label: "Message 1 · Opener" },
              { id: "followup", label: "Message 2 · Follow-up" },
            ] as const
          ).map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => switchTab(t.id)}
              className={
                "rounded-t-lg px-4 py-2 text-xs font-medium transition " +
                (tab === t.id
                  ? "border-b-2 border-cyan-400 text-cyan-100"
                  : "text-slate-400 hover:text-white")
              }
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-5 md:flex-row md:overflow-hidden">
          {/* Template list (current tab) — scrolls on its own on desktop */}
          <div className="flex shrink-0 flex-col gap-2 md:w-52 md:min-h-0 md:overflow-y-auto md:pr-1">
            {tabTemplates.map((t) => (
              <div
                key={t.id}
                className={
                  "group flex items-center gap-1 rounded-lg border pr-1 transition " +
                  (selectedId === t.id
                    ? "border-cyan-400/60 bg-cyan-500/10"
                    : "border-white/10 bg-slate-950/50 hover:border-white/25")
                }
              >
                <button
                  type="button"
                  onClick={() => loadIntoEditor(t)}
                  className={
                    "min-w-0 flex-1 truncate px-3 py-2 text-left text-sm transition " +
                    (selectedId === t.id
                      ? "text-cyan-100"
                      : "text-slate-300 group-hover:text-white")
                  }
                  title={t.label}
                >
                  {t.label}
                </button>
                {tabTemplates.length > 1 && (
                  <button
                    type="button"
                    onClick={() => void removeTemplate(t.id, t.label)}
                    disabled={busy}
                    title={`Delete "${t.label}"`}
                    className="shrink-0 rounded-md p-1.5 text-slate-500 opacity-60 transition hover:bg-rose-500/15 hover:text-rose-300 hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-30"
                  >
                    <TrashIcon className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            ))}
            <button
              type="button"
              onClick={() => loadIntoEditor(null)}
              className={
                "rounded-lg border border-dashed px-3 py-2 text-left text-sm transition " +
                (isNew
                  ? "border-cyan-400/60 bg-cyan-500/10 text-cyan-100"
                  : "border-white/20 text-slate-400 hover:border-white/40 hover:text-white")
              }
            >
              + New template
            </button>
          </div>

          {/* Editor — stays fixed while the list scrolls */}
          <div className="flex min-w-0 flex-1 flex-col gap-3 md:min-h-0">
            <div>
              <label className="mb-1 block text-[11px] font-medium uppercase tracking-[0.22em] text-slate-400">
                Template name
              </label>
              <input
                type="text"
                value={label}
                onChange={(e) => {
                  setLabel(e.target.value);
                  setDirty(true);
                }}
                placeholder="e.g. Collaboration suggestion"
                className="w-full rounded-lg border border-white/10 bg-slate-950/70 px-4 py-2.5 text-sm text-slate-100 outline-none transition focus:border-cyan-400 focus:ring-2 focus:ring-cyan-400/30"
              />
            </div>

            <div>
              <label className="mb-1 block text-[11px] font-medium uppercase tracking-[0.22em] text-slate-400">
                Subject
              </label>
              <input
                type="text"
                value={subject}
                onChange={(e) => {
                  setSubject(e.target.value);
                  setDirty(true);
                }}
                className="w-full rounded-lg border border-white/10 bg-slate-950/70 px-4 py-2.5 text-sm text-slate-100 outline-none transition focus:border-cyan-400 focus:ring-2 focus:ring-cyan-400/30"
              />
              {tab === "followup" && (
                <p className="mt-1 text-[11px] text-slate-500">
                  Ignored when sent — follow-ups reuse the opener&apos;s subject
                  as{" "}
                  <span className="font-mono text-indigo-300">Re: …</span> so
                  they thread correctly. Only the body is used.
                </p>
              )}
            </div>

            <div className="flex min-h-0 flex-1 flex-col">
              <div className="mb-1 flex items-center justify-between">
                <label className="text-[11px] font-medium uppercase tracking-[0.22em] text-slate-400">
                  Body
                </label>
                <span className="text-[11px] text-slate-500">
                  Placeholders:{" "}
                  <code className="text-cyan-300">{"{{name}}"}</code>{" "}
                  <code className="text-cyan-300">{"{{url_upwork}}"}</code>{" "}
                  <code className="text-cyan-300">{"{{url_linkedin}}"}</code>{" "}
                  <code className="text-cyan-300">{"{{url_github}}"}</code>{" "}
                  <code className="text-cyan-300">{"{{sender}}"}</code>{" "}
                  <code className="text-cyan-300">{"{{sender_email}}"}</code>{" "}
                  — <code className="text-cyan-300">{"{{url}}"}</code> ={" "}
                  <code className="text-cyan-300">{"{{url_upwork}}"}</code>
                </span>
              </div>
              <textarea
                value={body}
                onChange={(e) => {
                  setBody(e.target.value);
                  setDirty(true);
                }}
                rows={12}
                className="w-full flex-1 resize-y rounded-lg border border-white/10 bg-slate-950/70 px-4 py-3 font-mono text-[13px] leading-relaxed text-slate-100 outline-none transition focus:border-cyan-400 focus:ring-2 focus:ring-cyan-400/30"
              />
            </div>

            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => void onSave()}
                disabled={!canSave}
                data-ripple
                className="btn-press inline-flex items-center gap-1.5 rounded-full border border-cyan-400/40 bg-cyan-500/15 px-4 py-1.5 text-sm font-medium text-cyan-100 transition hover:border-cyan-300 hover:bg-cyan-400/25 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
              >
                {busy ? "Saving…" : isNew ? "Add template" : "Save changes"}
              </button>
              {!isNew && tabTemplates.length > 1 && (
                <button
                  type="button"
                  onClick={() => void onDelete()}
                  disabled={busy}
                  className="inline-flex items-center gap-1.5 rounded-full border border-rose-400/30 bg-rose-500/10 px-4 py-1.5 text-sm font-medium text-rose-200 transition hover:border-rose-300 hover:bg-rose-400/20 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Delete
                </button>
              )}
              {feedback && (
                <span
                  className={
                    "text-xs " +
                    (feedback.ok ? "text-emerald-300" : "text-rose-300")
                  }
                >
                  {feedback.message}
                </span>
              )}
              {dirty && !feedback && (
                <span className="text-xs text-slate-500">Unsaved changes</span>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
