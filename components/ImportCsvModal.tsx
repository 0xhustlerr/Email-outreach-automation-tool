"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { CountryFlag } from "@/components/CountryFlag";
import EmailScoreBadge from "@/components/EmailScoreBadge";
import { useTemplates } from "@/hooks/useTemplates";
import { parseLeadCsv, type CsvLead } from "@/lib/csv";

// Bulk import: pick a CSV of leads, then let the server filter by region, find
// each contact's best current email from their GitHub footprint, and queue a
// two-step sequence. Progress streams back as NDJSON, one line per lead.

type RowResult = {
  index: number;
  name: string;
  githubUrl: string;
  login: string;
  status: "queued" | "skipped" | "failed";
  email?: string;
  cc?: string;
  score?: number;
  country?: string;
  countrySource?: string;
  candidates?: { email: string; score: number; reasons: string[] }[];
  reason?: string;
};

// Read-only view of the queue's global settings. The import never writes them —
// rate, cap and window are edited in the Queue modal; we only read the few
// values that shape what this modal shows and sends.
type QueueSettings = {
  dailyCap: number;
  enabled: boolean;
};

const OPENER_KEY = "mail.import.openerIds";
const FOLLOWUP_KEY = "mail.import.followupId";

function SectionHead({ children }: { children: ReactNode }) {
  return (
    <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">
      {children}
    </div>
  );
}

function CloseIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className={className}>
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}

function UploadIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="M17 8l-5-5-5 5" />
      <path d="M12 3v12" />
    </svg>
  );
}

const inputCls =
  "w-full rounded-md border border-white/10 bg-slate-950 px-2 py-1 text-xs text-slate-100 outline-none focus:border-cyan-400/40";

export default function ImportCsvModal({
  onClose,
  onQueued,
}: {
  onClose: () => void;
  /** Fired after the run finishes so the page can refresh the queue badge. */
  onQueued?: () => void;
}) {
  const { openers, followups, templatesLoaded } = useTemplates();

  const [fileName, setFileName] = useState("");
  const [rows, setRows] = useState<CsvLead[]>([]);
  const [parseErrors, setParseErrors] = useState<string[]>([]);
  const [unmapped, setUnmapped] = useState<string[]>([]);

  const [openerIds, setOpenerIds] = useState<string[]>([]);
  const [followupId, setFollowupId] = useState("");
  const [pitchOn, setPitchOn] = useState(true);
  const [settings, setSettings] = useState<QueueSettings | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(true);

  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<RowResult[]>([]);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(
    null,
  );
  const [runError, setRunError] = useState("");
  const [expanded, setExpanded] = useState<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const initedTemplates = useRef(false);

  // Default template selection: rotate across every opener (max spread), first
  // follow-up as the pitch. Wait for the real templates — useTemplates renders
  // a placeholder first and defaulting against it would select only that one.
  useEffect(() => {
    if (initedTemplates.current || !templatesLoaded || openers.length === 0) return;
    let parsed: string[] | null = null;
    try {
      const saved = localStorage.getItem(OPENER_KEY);
      const raw: unknown = saved ? JSON.parse(saved) : null;
      if (Array.isArray(raw)) parsed = raw.filter((x): x is string => typeof x === "string");
    } catch {
      parsed = null; // stale/corrupt value — fall back to selecting all
    }
    const valid = parsed?.filter((id) => openers.some((o) => o.id === id)) ?? [];
    setOpenerIds(valid.length > 0 ? valid : openers.map((o) => o.id));
    const savedFu = localStorage.getItem(FOLLOWUP_KEY);
    const fu = followups.find((f) => f.id === savedFu) ?? followups[0];
    if (fu) setFollowupId(fu.id);
    initedTemplates.current = true;
  }, [templatesLoaded, openers, followups]);

  // Queue settings are global (one queue_settings row) — the same values the
  // Queue modal edits. Read them here so the import can tune the drip inline.
  const refreshSettings = useCallback(async () => {
    try {
      const res = await fetch("/api/queue");
      const data = (await res.json()) as { ok?: boolean; settings?: QueueSettings };
      if (res.ok && data.ok && data.settings) setSettings(data.settings);
    } catch {
      // Non-fatal: the import still runs with whatever is stored server-side.
    }
  }, []);

  useEffect(() => {
    void refreshSettings();
  }, [refreshSettings]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !running) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, running]);

  // Stop an in-flight import if the modal goes away.
  useEffect(() => () => abortRef.current?.abort(), []);

  const loadFile = async (file: File) => {
    const text = await file.text();
    const parsed = parseLeadCsv(text);
    setFileName(file.name);
    setRows(parsed.rows);
    setParseErrors(parsed.errors);
    setUnmapped(parsed.unmapped);
    setResults([]);
    setProgress(null);
    setRunError("");
    if (parsed.rows.length === 0) {
      toast.error("No rows with a GitHub URL found in that file.");
    }
  };

  const toggleOpener = (id: string) => {
    setOpenerIds((prev) => {
      const next = prev.includes(id)
        ? prev.filter((x) => x !== id)
        : [...prev, id];
      localStorage.setItem(OPENER_KEY, JSON.stringify(next));
      return next;
    });
  };

  const run = async () => {
    const selected = openers.filter((o) => openerIds.includes(o.id));
    if (rows.length === 0 || selected.length === 0) return;
    const fu = pitchOn ? followups.find((f) => f.id === followupId) : undefined;

    setRunning(true);
    setResults([]);
    setRunError("");
    setProgress({ done: 0, total: rows.length });
    setSettingsOpen(false);

    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const res = await fetch("/api/import-csv", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: ac.signal,
        body: JSON.stringify({
          rows,
          openers: selected.map((o) => ({ subject: o.subject, body: o.body })),
          followUp: fu ? { subject: fu.subject, body: fu.body } : undefined,
        }),
      });
      if (!res.ok || !res.body) {
        const msg = await res.text().catch(() => "");
        throw new Error(msg || `Import failed (${res.status}).`);
      }

      // NDJSON: one JSON event per line, rendered as it arrives.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          let ev: Record<string, unknown>;
          try {
            ev = JSON.parse(line) as Record<string, unknown>;
          } catch {
            continue;
          }
          if (ev.type === "row") {
            const row = ev as unknown as RowResult;
            setResults((prev) => [...prev, row]);
            setProgress({ done: row.index, total: Number(ev.total) || rows.length });
          } else if (ev.type === "done") {
            const queued = Number(ev.queued) || 0;
            toast.success(
              queued > 0
                ? `Queued ${queued} contact${queued === 1 ? "" : "s"}.`
                : "Nothing queued — see the log for why.",
            );
            onQueued?.();
          } else if (ev.type === "error") {
            setRunError(String(ev.message ?? "Import failed."));
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setRunError(err instanceof Error ? err.message : "Import failed.");
      }
    } finally {
      abortRef.current = null;
      setRunning(false);
    }
  };

  const stop = () => {
    abortRef.current?.abort();
    setRunning(false);
  };

  const queuedCount = results.filter((r) => r.status === "queued").length;
  const skippedCount = results.filter((r) => r.status === "skipped").length;
  const failedCount = results.filter((r) => r.status === "failed").length;
  const canRun = rows.length > 0 && openerIds.length > 0 && !running;

  const copySkipped = () => {
    const lines = results
      .filter((r) => r.status !== "queued")
      .map((r) => `${r.name || r.login || r.githubUrl}\t${r.reason ?? ""}`);
    void navigator.clipboard.writeText(lines.join("\n"));
    toast.success("Copied to clipboard.");
  };

  return (
    <div
      className="fade-in fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !running) onClose();
      }}
    >
      <div className="glass slide-in relative flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl shadow-2xl shadow-black/50">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
          <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.22em] text-slate-200">
            <UploadIcon className="h-4 w-4 text-cyan-300" />
            Import CSV
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={running}
            className="rounded-full p-2 text-slate-400 transition hover:bg-white/5 hover:text-white disabled:opacity-40"
            title={running ? "Import in progress" : "Close"}
            aria-label="Close"
          >
            <CloseIcon className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">
          {/* File picker */}
          <div>
            <SectionHead>Lead file</SectionHead>
            <label
              className="flex cursor-pointer items-center gap-3 rounded-lg border border-dashed border-white/15 bg-slate-950/40 px-4 py-3 transition hover:border-cyan-400/40"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const f = e.dataTransfer.files?.[0];
                if (f) void loadFile(f);
              }}
            >
              <input
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                disabled={running}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void loadFile(f);
                  e.target.value = "";
                }}
              />
              <UploadIcon className="h-5 w-5 shrink-0 text-slate-500" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs text-slate-200">
                  {fileName || "Choose a CSV file, or drop one here"}
                </p>
                <p className="mt-0.5 text-[10px] text-slate-500">
                  Columns: Name, Country (optional), Upwork URL (optional), GitHub
                  URL, LinkedIn URL (optional)
                </p>
              </div>
              {rows.length > 0 && (
                <span className="shrink-0 rounded-full border border-cyan-400/30 bg-cyan-500/10 px-2 py-0.5 text-[11px] text-cyan-200">
                  {rows.length} lead{rows.length === 1 ? "" : "s"}
                </span>
              )}
            </label>
            {unmapped.length > 0 && (
              <p className="mt-1.5 text-[10px] text-slate-500">
                Ignored column{unmapped.length === 1 ? "" : "s"}:{" "}
                {unmapped.join(", ")}
              </p>
            )}
            {parseErrors.length > 0 && (
              <details className="mt-1.5 text-[10px] text-amber-300/80">
                <summary className="cursor-pointer">
                  {parseErrors.length} row
                  {parseErrors.length === 1 ? "" : "s"} skipped while reading the file
                </summary>
                <ul className="mt-1 max-h-24 space-y-0.5 overflow-y-auto pl-3">
                  {parseErrors.slice(0, 50).map((e) => (
                    <li key={e}>{e}</li>
                  ))}
                </ul>
              </details>
            )}
            <p className="mt-2 text-[10px] text-slate-600">
              Only contacts in the US, Canada or Europe are queued. Missing
              countries are resolved from the GitHub profile; leads whose country
              can&apos;t be determined are skipped.
            </p>
          </div>

          {/* Message + queue settings */}
          <div className="rounded-lg border border-white/10 bg-slate-950/40">
            <button
              type="button"
              onClick={() => setSettingsOpen((v) => !v)}
              className="flex w-full items-center justify-between px-4 py-2.5 text-[11px] uppercase tracking-[0.18em] text-slate-400 transition hover:text-slate-200"
            >
              <span>Opener &amp; follow-up</span>
              <span className="text-slate-500">{settingsOpen ? "−" : "+"}</span>
            </button>

            {settingsOpen && (
              <div className="space-y-4 border-t border-white/10 px-4 py-3.5">
                {/* Openers */}
                <div>
                  <SectionHead>
                    Opener (message 1) — rotated across leads
                  </SectionHead>
                  <div className="max-h-36 space-y-1 overflow-y-auto pr-1">
                    {openers.map((o) => (
                      <label
                        key={o.id}
                        className="flex items-start gap-2 rounded-md px-1.5 py-1 text-[11px] text-slate-300 transition hover:bg-white/5"
                      >
                        <input
                          type="checkbox"
                          checked={openerIds.includes(o.id)}
                          onChange={() => toggleOpener(o.id)}
                          className="mt-0.5 accent-cyan-500"
                        />
                        <span className="min-w-0">
                          <span className="block truncate text-slate-200">
                            {o.label}
                          </span>
                          <span className="block truncate text-[10px] text-slate-500">
                            {o.subject}
                          </span>
                        </span>
                      </label>
                    ))}
                    {openers.length === 0 && (
                      <p className="text-[11px] text-amber-300/80">
                        No opener templates yet — add one under Setup → Templates.
                      </p>
                    )}
                  </div>
                  {openerIds.length > 0 && settings && (
                    <p className="mt-1 text-[10px] text-slate-600">
                      {openerIds.length} opener{openerIds.length === 1 ? "" : "s"} ·
                      ~{Math.round(settings.dailyCap / openerIds.length)} sends per
                      template per day at the current cap
                    </p>
                  )}
                </div>

                {/* Follow-up */}
                <div>
                  <SectionHead>Follow-up (message 2)</SectionHead>
                  <label className="mb-1.5 flex items-center gap-2 text-[11px] text-slate-300">
                    <input
                      type="checkbox"
                      checked={pitchOn}
                      onChange={(e) => setPitchOn(e.target.checked)}
                      className="accent-cyan-500"
                    />
                    Send a threaded follow-up after the opener
                  </label>
                  <select
                    value={followupId}
                    disabled={!pitchOn}
                    onChange={(e) => {
                      setFollowupId(e.target.value);
                      localStorage.setItem(FOLLOWUP_KEY, e.target.value);
                    }}
                    className={inputCls + " disabled:opacity-40"}
                  >
                    {followups.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.label}
                      </option>
                    ))}
                  </select>
                  <p className="mt-1 text-[10px] text-slate-600">
                    Sent as a reply in the opener&apos;s thread. The queue sends it
                    fast once they reply, or after the follow-up delay set in
                    Queue settings.
                  </p>
                </div>

                {/* Rate, cap and window are the queue's own global settings —
                    edited in the Queue modal, shown here only as context. */}
                {settings && (
                  <p className="border-t border-white/5 pt-3 text-[10px] text-slate-600">
                    Sending rate, daily cap and window come from{" "}
                    <span className="text-slate-500">Queue settings</span>.
                    {settings.enabled
                      ? " The queue is running — imported leads start dripping right away."
                      : " The queue is paused — imported leads wait until you resume it."}
                  </p>
                )}
              </div>
            )}
          </div>

          {/* Run log */}
          {(results.length > 0 || running || runError) && (
            <div>
              <div className="mb-2 flex items-center justify-between">
                <SectionHead>Import log</SectionHead>
                <div className="flex items-center gap-3 text-[11px] text-slate-400">
                  <span>
                    Queued <b className="text-emerald-300">{queuedCount}</b>
                  </span>
                  <span>
                    Skipped <b className="text-slate-300">{skippedCount}</b>
                  </span>
                  {failedCount > 0 && (
                    <span>
                      Failed <b className="text-rose-300">{failedCount}</b>
                    </span>
                  )}
                  {results.length > queuedCount && (
                    <button
                      type="button"
                      onClick={copySkipped}
                      className="text-cyan-300 hover:text-cyan-200"
                    >
                      copy
                    </button>
                  )}
                </div>
              </div>

              {progress && (
                <div className="mb-2 h-1 w-full overflow-hidden rounded-full bg-white/10">
                  {/* scaleX, not width — this advances once per imported lead. */}
                  <div
                    className="h-full w-full origin-left rounded-full bg-cyan-400/70 transition-transform"
                    style={{
                      transform: `scaleX(${Math.min(1, progress.done / Math.max(1, progress.total))})`,
                    }}
                  />
                </div>
              )}

              {runError && (
                <p className="mb-2 rounded-md border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-[11px] text-rose-200">
                  {runError}
                </p>
              )}

              <div className="max-h-64 space-y-1 overflow-y-auto">
                {results.map((r) => (
                  <div
                    key={`${r.index}-${r.githubUrl}`}
                    className="rounded-lg border border-white/10 bg-slate-950/50 px-3 py-2"
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className={
                          "h-1.5 w-1.5 shrink-0 rounded-full " +
                          (r.status === "queued"
                            ? "bg-emerald-400"
                            : r.status === "failed"
                              ? "bg-rose-400"
                              : "bg-slate-600")
                        }
                      />
                      <span className="min-w-0 flex-1 truncate text-xs text-slate-100">
                        {r.name || r.login || r.githubUrl}
                      </span>
                      {r.country && (
                        <span className="shrink-0 text-[10px] text-slate-400">
                          <CountryFlag
                            country={r.country}
                            size={10}
                            className="mr-1 align-[-1px]"
                          />
                          {r.country}
                        </span>
                      )}
                      {r.score !== undefined && <EmailScoreBadge score={r.score} />}
                    </div>
                    <div className="mt-0.5 flex items-center gap-1.5 pl-3.5 text-[11px]">
                      {r.email ? (
                        <>
                          <span className="truncate text-cyan-200/90">{r.email}</span>
                          {r.cc && (
                            <span
                              className="shrink-0 rounded border border-white/10 bg-white/5 px-1 py-px text-[10px] uppercase text-slate-400"
                              title={`Also CC'd: ${r.cc}`}
                            >
                              cc {r.cc}
                            </span>
                          )}
                        </>
                      ) : null}
                      {r.reason && (
                        <span className="truncate text-slate-500">
                          {r.email ? "· " : ""}
                          {r.reason}
                        </span>
                      )}
                      {r.candidates && r.candidates.length > 0 && (
                        <button
                          type="button"
                          onClick={() =>
                            setExpanded((v) => (v === r.index ? null : r.index))
                          }
                          className="ml-auto shrink-0 text-[10px] text-slate-500 hover:text-slate-300"
                        >
                          {expanded === r.index ? "hide" : "why?"}
                        </button>
                      )}
                    </div>
                    {expanded === r.index && r.candidates && (
                      <ul className="mt-1.5 space-y-1 border-t border-white/5 pt-1.5 pl-3.5 text-[10px] text-slate-500">
                        {r.candidates.map((c) => (
                          <li key={c.email}>
                            <span className="text-slate-300">{c.email}</span>{" "}
                            <span className="tabular-nums">({c.score})</span>
                            {c.reasons.length > 0 && (
                              <span> — {c.reasons.join(", ")}</span>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-3 border-t border-white/10 px-5 py-3">
          <p className="text-[11px] text-slate-500">
            {running && progress
              ? `Processing ${progress.done}/${progress.total}…`
              : rows.length > 0
                ? `${rows.length} lead${rows.length === 1 ? "" : "s"} ready`
                : "No file loaded"}
          </p>
          <div className="flex items-center gap-2">
            {running ? (
              <button
                type="button"
                onClick={stop}
                className="rounded-full border border-white/15 bg-slate-950/50 px-4 py-1.5 text-xs text-slate-200 transition hover:border-white/30"
              >
                Stop
              </button>
            ) : (
              <button
                type="button"
                onClick={onClose}
                className="rounded-full border border-white/15 bg-slate-950/50 px-4 py-1.5 text-xs text-slate-300 transition hover:border-white/30"
              >
                Close
              </button>
            )}
            <button
              type="button"
              onClick={() => void run()}
              disabled={!canRun}
              className="rounded-full border border-cyan-400/40 bg-cyan-500/15 px-4 py-1.5 text-xs font-medium text-cyan-100 transition hover:bg-cyan-500/25 disabled:cursor-not-allowed disabled:opacity-40"
              title={
                openerIds.length === 0
                  ? "Select at least one opener template"
                  : "Discover emails and queue every eligible lead"
              }
            >
              {running ? "Importing…" : `Import & queue${rows.length ? ` (${rows.length})` : ""}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
