"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Spinner } from "@/components/ui/spinner";
import { useTemplates, type TemplateKind, type UiTemplate } from "@/hooks/useTemplates";
import { Card, PageBody, PageHeader, Segmented } from "@/components/ui/dashboard";
import { TemplatePreviewCard } from "@/components/EmailPreview";

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

function FileTextIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6M16 13H8M16 17H8M10 9H8" />
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

const PLACEHOLDERS = [
  "{{name}}",
  "{{url_upwork}}",
  "{{url_linkedin}}",
  "{{url_github}}",
  "{{sender}}",
  "{{sender_email}}",
];

// Props kept for app/page.tsx's call site; the page needs neither.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export default function TemplatesModal(_props: {
  onClose: () => void;
  asPage?: boolean;
}) {
  const {
    templates: allTemplates,
    templatesLoaded,
    templatesLoadFailed,
    refreshTemplates,
    saveTemplate,
    deleteTemplate,
  } = useTemplates();
  // Only the database's own rows. Until they land, useTemplates holds built-in
  // bridge templates whose ids may not exist in the database — editing one and
  // pressing Save would create it as a new template in the send rotation.
  const templates = useMemo(
    () => (templatesLoaded ? allTemplates : []),
    [templatesLoaded, allTemplates],
  );

  // null = nothing picked yet (auto-select pending); "new" = the user
  // clicked "+ New template"; otherwise the id of the template being edited.
  const [tab, setTab] = useState<TemplateKind>("opener");
  const [selection, setSelection] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);

  const isNew = selection === "new";
  const selectedId = !isNew ? selection : null;
  const tabTemplates = templates.filter((t) => t.kind === tab);
  // What a Pitch's "Re: …" subject is previewed against.
  const openerSubject = templates.find((t) => t.kind === "opener")?.subject ?? "";

  const loadIntoEditor = (t: UiTemplate | null) => {
    setSelection(t?.id ?? "new");
    setLabel(t?.label ?? "");
    setSubject(t?.subject ?? "");
    setBody(t?.body ?? "");
    setDirty(false);
  };

  // A failed load leaves nothing to edit, so say so.
  useEffect(() => {
    if (templatesLoadFailed && !templatesLoaded) {
      toast.error("Could not load your templates. Retry from the template list.", {
        id: "templates-load",
      });
    }
  }, [templatesLoadFailed, templatesLoaded]);

  // Auto-pick the first template of the active tab, once the database copy
  // has landed (see `templates` above).
  useEffect(() => {
    if (!templatesLoaded || selection !== null || tabTemplates.length === 0) return;
    loadIntoEditor(tabTemplates[0]);
  }, [templatesLoaded, tabTemplates, selection]);

  // Switching tabs resets the editor to that tab's first template.
  const switchTab = (next: TemplateKind) => {
    if (next === tab) return;
    setTab(next);
    setSelection(null);
    setLabel("");
    setSubject("");
    setBody("");
    setDirty(false);
  };

  // When the database copy lands, refresh the untouched editor so it shows
  // the saved content rather than the built-in defaults. If the open template
  // isn't in the database list (a bridge default clicked before it loaded, or
  // one deleted elsewhere), drop back to "nothing picked" so the auto-select
  // above moves the editor to a real one.
  useEffect(() => {
    if (!templatesLoaded || dirty || !selectedId) return;
    const t = templates.find((x) => x.id === selectedId);
    if (t) {
      setLabel(t.label);
      setSubject(t.subject);
      setBody(t.body);
    } else {
      setSelection(null);
    }
  }, [templatesLoaded, templates, dirty, selectedId]);

  const onSave = async () => {
    if (busy) return;
    setBusy(true);
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
      toast.success("Saved — will be used for future messages.");
    } else {
      toast.error(res.error ?? "Failed to save.");
    }
  };

  const removeTemplate = async (id: string, name: string) => {
    if (busy) return;
    if (tabTemplates.length <= 1) {
      toast.error(`Cannot delete the last ${tab} template.`);
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
      toast.success("Template deleted.");
    } else {
      toast.error(res.error ?? "Failed to delete.");
    }
  };

  const onDelete = () => {
    if (!selectedId) return;
    void removeTemplate(selectedId, label);
  };

  const canSave = !!label.trim() && !!subject.trim() && !!body.trim() && !busy;

  return (
    <PageBody>
      <PageHeader
        title="Templates"
        description="The opener and follow-up messages used for every future send."
        icon={<FileTextIcon className="h-5 w-5" />}
        meta={
          dirty ? (
            <span className="badge badge-warning">Unsaved changes</span>
          ) : undefined
        }
        actions={
          <>
            <button
              type="button"
              onClick={() => loadIntoEditor(null)}
              className="btn btn-secondary"
            >
              <PlusIcon className="h-4 w-4" />
              New template
            </button>
            <button
              type="button"
              onClick={() => void onSave()}
              disabled={!canSave}
              data-ripple
              className="btn btn-primary"
            >
              {busy && <Spinner />}
              {busy ? "Saving…" : isNew ? "Add template" : "Save changes"}
            </button>
          </>
        }
      />

      {/* Tabs: Message 1 (opener) / Message 2 (follow-up) */}
      <div className="max-w-full overflow-x-auto">
        <Segmented
          value={tab}
          onChange={switchTab}
          options={[
            { value: "opener", label: "Message 1 · Opener" },
            { value: "followup", label: "Message 2 · Follow-up" },
          ]}
        />
      </div>

      {/* List | editor | preview side by side on wide screens; below that the
          preview drops under the editor, and on narrow ones everything stacks. */}
      <div className="grid gap-6 lg:grid-cols-[280px_minmax(0,1fr)] xl:grid-cols-[240px_minmax(0,1fr)_minmax(0,1fr)]">
        {/* Template list (current tab) */}
        <Card
          title="Templates"
          description={
            templatesLoaded
              ? `${tabTemplates.length} ${tab === "opener" ? "opener" : "follow-up"} template${tabTemplates.length === 1 ? "" : "s"}`
              : templatesLoadFailed
                ? "Could not load"
                : "Loading…"
          }
          flush
          className="self-start"
        >
          {!templatesLoaded && (
            <div className="flex items-center gap-2 px-4 py-3 text-xs text-slate-400">
              {templatesLoadFailed ? (
                <button
                  type="button"
                  onClick={() => void refreshTemplates()}
                  className="btn btn-secondary btn-sm"
                >
                  Retry
                </button>
              ) : (
                <>
                  <Spinner />
                  Loading templates…
                </>
              )}
            </div>
          )}
          <ul className="flex flex-col gap-1 p-2 empty:hidden">
            {tabTemplates.map((t) => {
              const active = selectedId === t.id;
              return (
                <li
                  key={t.id}
                  className={
                    "group relative flex items-center gap-1 rounded-lg pr-1 transition " +
                    (active ? "bg-cyan-400/10" : "hover:bg-white/[0.04]")
                  }
                >
                  {active && (
                    <span className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-cyan-400" aria-hidden />
                  )}
                  <button
                    type="button"
                    onClick={() => loadIntoEditor(t)}
                    className="min-w-0 flex-1 px-3 py-2 text-left"
                    title={t.label}
                  >
                    <span
                      className={
                        "block truncate text-sm " +
                        (active ? "font-medium text-cyan-100" : "text-slate-300 group-hover:text-white")
                      }
                    >
                      {t.label}
                    </span>
                    <span className="block truncate text-xs text-slate-500">{t.subject}</span>
                  </button>
                  {tabTemplates.length > 1 && (
                    <button
                      type="button"
                      onClick={() => void removeTemplate(t.id, t.label)}
                      disabled={busy}
                      title={`Delete "${t.label}"`}
                      aria-label={`Delete "${t.label}"`}
                      className="btn btn-ghost btn-sm btn-icon shrink-0 opacity-60 hover:!bg-rose-500/15 hover:!text-rose-300 hover:opacity-100"
                    >
                      <TrashIcon className="h-3.5 w-3.5" />
                    </button>
                  )}
                </li>
              );
            })}
            {isNew && (
              <li className="relative rounded-lg bg-cyan-400/10">
                <span className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-cyan-400" aria-hidden />
                <span className="block truncate px-3 py-2 text-sm font-medium text-cyan-100">
                  {label.trim() || "New template"}
                  <span className="ml-2 text-xs font-normal text-slate-500">draft</span>
                </span>
              </li>
            )}
          </ul>
        </Card>

        {/* Editor */}
        <Card
          title={isNew ? "New template" : "Edit template"}
          description={tab === "opener" ? "Message 1 · Opener" : "Message 2 · Follow-up"}
          className="min-w-0"
          actions={
            !isNew && tabTemplates.length > 1 ? (
              <button
                type="button"
                onClick={() => void onDelete()}
                disabled={busy}
                className="btn btn-danger btn-sm"
              >
                <TrashIcon className="h-3.5 w-3.5" />
                Delete
              </button>
            ) : undefined
          }
        >
          <div className="flex flex-col gap-5">
            {/* Stacked at xl, where the preview column narrows the editor. */}
            <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
              <div>
                <label htmlFor="tpl-label" className="field-label">
                  Template name
                </label>
                <input
                  id="tpl-label"
                  type="text"
                  value={label}
                  onChange={(e) => {
                    setLabel(e.target.value);
                    setDirty(true);
                  }}
                  placeholder="e.g. Collaboration suggestion"
                  className="input"
                />
              </div>

              <div>
                <label htmlFor="tpl-subject" className="field-label">
                  Subject
                </label>
                <input
                  id="tpl-subject"
                  type="text"
                  value={subject}
                  onChange={(e) => {
                    setSubject(e.target.value);
                    setDirty(true);
                  }}
                  className="input"
                />
                {tab === "followup" && (
                  <p className="field-hint">
                    Ignored when sent — follow-ups reuse the opener&apos;s subject
                    as{" "}
                    <span className="font-mono text-violet-300">Re: …</span> so
                    they thread correctly. Only the body is used.
                  </p>
                )}
              </div>
            </div>

            <div>
              <label htmlFor="tpl-body" className="field-label">
                Body
              </label>
              <textarea
                id="tpl-body"
                value={body}
                onChange={(e) => {
                  setBody(e.target.value);
                  setDirty(true);
                }}
                rows={12}
                className="input min-h-[22rem] resize-y font-mono text-[13px]"
              />
              <div className="field-hint flex flex-wrap items-center gap-1.5">
                <span className="mr-0.5">Placeholders</span>
                {PLACEHOLDERS.map((p) => (
                  <code key={p} className="badge badge-neutral font-mono">
                    {p}
                  </code>
                ))}
                <span className="ml-0.5">
                  <code className="font-mono text-slate-400">{"{{url}}"}</code> ={" "}
                  <code className="font-mono text-slate-400">{"{{url_upwork}}"}</code>
                </span>
              </div>
            </div>
          </div>
        </Card>

        <TemplatePreviewCard
          subject={subject}
          body={body}
          kind={tab}
          openerSubject={openerSubject}
          className="self-start lg:col-start-2 xl:col-start-auto"
        />
      </div>
    </PageBody>
  );
}
