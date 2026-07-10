"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { EMAIL_TEMPLATES } from "@/lib/email-templates";

export type TemplateKind = "opener" | "followup";

export type UiTemplate = {
  id: string;
  label: string;
  subject: string;
  body: string;
  kind: TemplateKind;
};

const SELECTED_KEY = "mail.templateId";

// One-time migration: template content used to live in localStorage
// (mail.template.<id>.subject/body). Push any such edits into the database
// the first time this hook runs, then drop the keys.
const MIGRATED_KEY = "mail.templates.migrated-to-db";
async function migrateLocalStorageOnce(): Promise<boolean> {
  if (localStorage.getItem(MIGRATED_KEY)) return false;
  let pushed = false;
  for (const t of EMAIL_TEMPLATES) {
    const subject = localStorage.getItem(`mail.template.${t.id}.subject`);
    const body = localStorage.getItem(`mail.template.${t.id}.body`);
    if (subject === null && body === null) continue;
    try {
      await fetch("/api/templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: t.id,
          label: t.label,
          subject: subject ?? t.subject,
          body: body ?? t.body,
        }),
      });
      pushed = true;
    } catch {
      return false; // retry next load; keys stay put
    }
    localStorage.removeItem(`mail.template.${t.id}.subject`);
    localStorage.removeItem(`mail.template.${t.id}.body`);
  }
  localStorage.setItem(MIGRATED_KEY, "1");
  return pushed;
}

// Built-in pitch templates are follow-ups; a bridge opener renders instantly
// until the DB copy (with real openers) arrives.
const BUILTIN_UI: UiTemplate[] = [
  {
    id: "opener-call",
    label: "Quick call",
    subject: "Quick question, {{name}}",
    body: "Hi {{name}},\n\nDo you have a moment for a quick call this week?\n\nBest,\nWael",
    kind: "opener",
  },
  ...EMAIL_TEMPLATES.map((t) => ({ ...t, kind: "followup" as const })),
];

export function useTemplates() {
  // Built-in defaults render instantly; the DB copy replaces them right after.
  const [templates, setTemplates] = useState<UiTemplate[]>(BUILTIN_UI);
  const [loaded, setLoaded] = useState(false);
  const saveTimerRef = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/templates");
      const data = (await res.json()) as {
        ok?: boolean;
        templates?: UiTemplate[];
      };
      if (res.ok && data.ok && data.templates?.length) {
        setTemplates(data.templates);
        setLoaded(true);
      }
    } catch {
      // Defaults keep working; next refresh retries.
    }
  }, []);

  useEffect(() => {
    void (async () => {
      await migrateLocalStorageOnce();
      await refresh();
    })();
  }, [refresh]);

  /** Persist a template's content (debounced - used by live edits in the
   *  Send modal so tweaks made there stick for future messages). */
  const saveContentDebounced = useCallback(
    (id: string, subject: string, body: string) => {
      const t = templates.find((x) => x.id === id);
      if (!t) return;
      // Keep local state in sync immediately so modals reopen with the edit.
      // Bail out on no-op updates: this callback's identity depends on
      // `templates`, and callers persist from an effect - an unconditional
      // state change here would loop.
      setTemplates((prev) => {
        const cur = prev.find((x) => x.id === id);
        if (!cur || (cur.subject === subject && cur.body === body)) return prev;
        return prev.map((x) => (x.id === id ? { ...x, subject, body } : x));
      });
      if (t.subject === subject && t.body === body) return;
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = window.setTimeout(() => {
        void fetch("/api/templates", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, label: t.label, subject, body, kind: t.kind }),
        }).catch(() => {});
      }, 800);
    },
    [templates],
  );

  /** Explicit save from the Manage Templates modal. */
  const saveTemplate = useCallback(
    async (input: {
      id?: string;
      label: string;
      subject: string;
      body: string;
      kind?: TemplateKind;
    }): Promise<{ ok: boolean; error?: string; id?: string }> => {
      try {
        const res = await fetch("/api/templates", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        });
        const data = (await res.json()) as {
          ok?: boolean;
          template?: UiTemplate;
          error?: string;
        };
        if (!res.ok || !data.ok) {
          return { ok: false, error: data.error ?? "Failed to save." };
        }
        await refresh();
        return { ok: true, id: data.template?.id };
      } catch {
        return { ok: false, error: "Network error while saving." };
      }
    },
    [refresh],
  );

  const deleteTemplate = useCallback(
    async (id: string): Promise<{ ok: boolean; error?: string }> => {
      try {
        const res = await fetch(`/api/templates?id=${encodeURIComponent(id)}`, {
          method: "DELETE",
        });
        const data = (await res.json()) as { ok?: boolean; error?: string };
        if (!res.ok || !data.ok) {
          return { ok: false, error: data.error ?? "Failed to delete." };
        }
        await refresh();
        return { ok: true };
      } catch {
        return { ok: false, error: "Network error while deleting." };
      }
    },
    [refresh],
  );

  const openers = templates.filter((t) => t.kind === "opener");
  const followups = templates.filter((t) => t.kind === "followup");

  return {
    templates,
    openers,
    followups,
    templatesLoaded: loaded,
    refreshTemplates: refresh,
    saveContentDebounced,
    saveTemplate,
    deleteTemplate,
  };
}

export function loadSelectedTemplateIdRaw(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(SELECTED_KEY);
}

export function saveSelectedTemplateIdRaw(id: string): void {
  localStorage.setItem(SELECTED_KEY, id);
}
