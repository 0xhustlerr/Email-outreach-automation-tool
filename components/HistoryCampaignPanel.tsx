"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Portal } from "@/components/ui/portal";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "sonner";
import { useTemplates } from "@/hooks/useTemplates";

// Re-engage past contacts with a two-step sequence. Reuses each contact's
// stored name/url and original sender; enqueues onto the scheduled queue.

export default function HistoryCampaignPanel({
  from,
  to,
  periodLabel,
  emails,
  onClose,
  onQueued,
}: {
  from: Date;
  to: Date;
  periodLabel: string;
  /** Explicit per-email selection. When set, overrides the date range. */
  emails?: string[];
  onClose: () => void;
  onQueued?: () => void;
}) {
  const { openers, followups, templatesLoaded } = useTemplates();
  // Openers to ROTATE across contacts (round-robin). Rotating N of them makes
  // each template land ~dailyCap/N times a day — keep that in the 5–7 range.
  const [openerIds, setOpenerIds] = useState<string[]>([]);
  const [dailyCap, setDailyCap] = useState(80);
  const [followupId, setFollowupId] = useState("");
  // The follow-up is the PITCH, sent in-thread ONLY when the contact replies.
  const [pitchOn, setPitchOn] = useState(true);
  const [onlyNonReplied, setOnlyNonReplied] = useState(true);
  const [count, setCount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const initedOpeners = useRef(false);

  const bySelection = !!emails && emails.length > 0;

  // Rotate across ALL openers by default (max spread). Wait for the REAL
  // templates — useTemplates returns a 1-item placeholder first, and defaulting
  // against that would select only one opener.
  useEffect(() => {
    if (!initedOpeners.current && templatesLoaded && openers.length > 0) {
      setOpenerIds(openers.map((o) => o.id));
      initedOpeners.current = true;
    }
    if (!followupId && followups[0]) setFollowupId(followups[0].id);
  }, [openers, followups, followupId, templatesLoaded]);

  // Pull the daily cap so we can show the per-template/day estimate.
  useEffect(() => {
    fetch("/api/queue")
      .then((r) => r.json())
      .then((d) => {
        const cap = d?.settings?.dailyCap;
        if (typeof cap === "number" && cap > 0) setDailyCap(cap);
      })
      .catch(() => {});
  }, []);

  const fromIso = from.toISOString();
  const toIso = to.toISOString();

  const loadCount = useCallback(async () => {
    if (bySelection) {
      setCount(emails!.length);
      return;
    }
    setCount(null);
    try {
      const res = await fetch(
        `/api/queue/from-history?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(
          toIso,
        )}&onlyNonReplied=${onlyNonReplied ? "1" : "0"}`,
      );
      const data = (await res.json()) as { ok?: boolean; count?: number };
      if (res.ok && data.ok) setCount(data.count ?? 0);
    } catch {
      setCount(0);
    }
  }, [bySelection, emails, fromIso, toIso, onlyNonReplied]);

  useEffect(() => {
    void loadCount();
  }, [loadCount]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const selectedOpeners = openers.filter((o) => openerIds.includes(o.id));
  const allOpenersOn =
    openers.length > 0 && selectedOpeners.length === openers.length;
  const perTemplatePerDay =
    selectedOpeners.length > 0 ? dailyCap / selectedOpeners.length : 0;
  const followup =
    pitchOn && followupId ? followups.find((f) => f.id === followupId) : null;

  const toggleOpener = (id: string) =>
    setOpenerIds((cur) =>
      cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id],
    );

  const submit = async () => {
    if (selectedOpeners.length === 0 || busy) return;
    if (
      !window.confirm(
        `Queue a 2-step sequence to ${count ?? "?"} contact${count === 1 ? "" : "s"} from ${periodLabel}?\n\nThese are people you've already emailed — re-contacting is best kept to non-repliers and low volume.`,
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/queue/from-history", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(bySelection
            ? { emails }
            : { from: fromIso, to: toIso, onlyNonReplied }),
          openers: selectedOpeners.map((o) => ({
            subject: o.subject,
            body: o.body,
          })),
          followUp: followup ? { body: followup.body } : undefined,
        }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        added?: number;
        skipped?: number;
        error?: string;
      };
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Failed.");
      toast.success(
        `Queued ${data.added ?? 0} contact${data.added === 1 ? "" : "s"}` +
          (data.skipped ? ` · ${data.skipped} skipped (already queued)` : ""),
      );
      onQueued?.();
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to queue.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Portal>
    <div
      className="fade-in fixed inset-0 z-[80] flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="card flex max-h-[calc(100vh-2rem)] w-full max-w-lg flex-col overflow-hidden bg-slate-900 shadow-2xl shadow-black/60"
        role="dialog"
        aria-modal="true"
        aria-label="Send 2-step to history"
      >
        <div className="card-header">
          <div className="min-w-0">
            <h3 className="card-title">Send 2-step to history</h3>
            <p className="card-description">
              {bySelection ? (
                <>
                  Targets your <span className="text-cyan-300">{emails!.length}</span>{" "}
                  selected contact{emails!.length === 1 ? "" : "s"}
                </>
              ) : (
                <>
                  Targets contacts from{" "}
                  <span className="text-cyan-300">{periodLabel}</span>
                </>
              )}
              , reusing each one&apos;s saved name, URL, and original sender.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="btn btn-ghost btn-sm btn-icon -mr-1 -mt-1"
            aria-label="Close"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-4 w-4" aria-hidden>
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="card-body flex min-h-0 flex-col gap-5 overflow-y-auto">
          <div className="flex items-center justify-between gap-3 rounded-lg border border-cyan-400/20 bg-cyan-400/[0.05] px-4 py-3">
            <span className="text-sm text-slate-300">
              Contact{count === 1 ? "" : "s"} matching
            </span>
            <span className="text-2xl font-semibold tabular-nums tracking-tight text-slate-50">
              {count === null ? "…" : count}
            </span>
          </div>

          {!bySelection && (
            <label className="-mt-2 flex items-center gap-2 text-xs text-slate-300">
              <input
                type="checkbox"
                checked={onlyNonReplied}
                onChange={(e) => setOnlyNonReplied(e.target.checked)}
                className="accent-cyan-500"
              />
              Only contacts who never replied (recommended)
            </label>
          )}

          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <span className="field-label mb-0">Message 1 · Openers to rotate</span>
              <button
                type="button"
                onClick={() =>
                  setOpenerIds(allOpenersOn ? [] : openers.map((o) => o.id))
                }
                className="btn btn-ghost btn-sm h-6 px-2"
              >
                {allOpenersOn ? "Clear all" : "Select all"}
              </button>
            </div>
            <div className="max-h-40 space-y-0.5 overflow-y-auto rounded-lg border border-white/10 bg-slate-950/50 p-1.5">
              {openers.map((t) => {
                const on = openerIds.includes(t.id);
                return (
                  <label
                    key={t.id}
                    className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm text-slate-200 transition hover:bg-white/[0.04]"
                  >
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() => toggleOpener(t.id)}
                      className="accent-cyan-500"
                    />
                    <span className="truncate">{t.label}</span>
                  </label>
                );
              })}
            </div>
            {selectedOpeners.length > 0 ? (
              <p
                className={
                  "field-hint " +
                  (perTemplatePerDay > 7
                    ? "text-amber-300"
                    : perTemplatePerDay < 5
                      ? "text-slate-400"
                      : "text-emerald-300")
                }
              >
                Rotating {selectedOpeners.length} opener
                {selectedOpeners.length === 1 ? "" : "s"} · ≈
                {Math.round(perTemplatePerDay)} send
                {Math.round(perTemplatePerDay) === 1 ? "" : "s"} each per day
                {perTemplatePerDay > 7
                  ? ` — add ~${Math.max(1, Math.ceil(dailyCap / 7) - selectedOpeners.length)} more to reach 5–7/day`
                  : perTemplatePerDay < 5
                    ? " (under your 5–7 target)"
                    : " (in your 5–7 target)"}
              </p>
            ) : (
              <p className="field-hint text-rose-300">
                Select at least one opener to rotate.
              </p>
            )}
          </div>

          <div>
            <label className="field-label flex items-center gap-2">
              <input
                type="checkbox"
                checked={pitchOn}
                onChange={(e) => setPitchOn(e.target.checked)}
                className="accent-cyan-500"
              />
              Message 2 · Pitch
              <span className="font-normal text-slate-500">
                sent in-thread only when they reply
              </span>
            </label>
            <select
              value={followupId}
              onChange={(e) => setFollowupId(e.target.value)}
              disabled={!pitchOn}
              className="input disabled:opacity-40"
            >
              {followups.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
            <p className="field-hint">
              {pitchOn
                ? "Non-repliers get a short link-free bump automatically (set in Queue settings) — no timed pitch is sent to cold inboxes."
                : "Opener only — no pitch or bump will be sent."}
            </p>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-white/5 px-5 py-3.5">
          <button type="button" onClick={onClose} className="btn btn-ghost">
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy || selectedOpeners.length === 0 || count === 0}
            data-ripple
            className="btn btn-primary tabular-nums"
          >
            {busy && <Spinner />}
            {busy ? "Queuing…" : `Add ${count ?? 0} to queue`}
          </button>
        </div>
      </div>
    </div>
    </Portal>
  );
}
