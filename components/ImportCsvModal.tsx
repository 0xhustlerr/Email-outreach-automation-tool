"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { CountryFlag } from "@/components/CountryFlag";
import EmailScoreBadge from "@/components/EmailScoreBadge";
import { Card, PageBody, PageHeader } from "@/components/ui/dashboard";
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

function UploadIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="M17 8l-5-5-5 5" />
      <path d="M12 3v12" />
    </svg>
  );
}

export default function ImportCsvModal({
  onClose,
  onQueued,
}: {
  onClose: () => void;
  asPage?: boolean;
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
    <PageBody>
      <PageHeader
        title="Import CSV"
        description="Load a lead file, find each contact's best email, and queue a two-step sequence."
        icon={<UploadIcon className="h-5 w-5" />}
        meta={running ? <span className="badge badge-info">Importing</span> : undefined}
        actions={
          <>
            {running ? (
              <button type="button" onClick={stop} className="btn btn-secondary">
                Stop
              </button>
            ) : (
              <button type="button" onClick={onClose} className="btn btn-secondary">
                View queue
              </button>
            )}
            <button
              type="button"
              onClick={() => void run()}
              disabled={!canRun}
              className="btn btn-primary"
              title={
                openerIds.length === 0
                  ? "Select at least one opener template"
                  : "Discover emails and queue every eligible lead"
              }
            >
              {running ? "Importing…" : `Import & queue${rows.length ? ` (${rows.length})` : ""}`}
            </button>
          </>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
        <div className="flex min-w-0 flex-col gap-6">
          {/* File picker */}
          <Card
            title="Lead file"
            description="A CSV with one lead per row."
            actions={
              <span className={"badge tabular-nums " + (rows.length > 0 ? "badge-info" : "badge-neutral")}>
                {running && progress
                  ? `Processing ${progress.done}/${progress.total}…`
                  : rows.length > 0
                    ? `${rows.length} lead${rows.length === 1 ? "" : "s"} ready`
                    : "No file loaded"}
              </span>
            }
          >
            <label
              className="flex cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed border-white/10 bg-slate-950/40 px-6 py-10 text-center transition hover:border-cyan-400/40 hover:bg-cyan-400/[0.03]"
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
              <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-white/5 text-slate-400 ring-1 ring-inset ring-white/10">
                <UploadIcon className="h-5 w-5" />
              </span>
              <span className="min-w-0 max-w-full">
                <span className="block truncate text-sm font-medium text-slate-200">
                  {fileName || "Choose a CSV file, or drop one here"}
                </span>
                <span className="mt-1 block text-xs text-slate-500">
                  {fileName ? "Click or drop to replace" : "Click to browse"}
                </span>
              </span>
              {rows.length > 0 && (
                <span className="badge badge-info tabular-nums">
                  {rows.length} lead{rows.length === 1 ? "" : "s"}
                </span>
              )}
            </label>
            <p className="field-hint">
              Columns: Name, Country (optional), Upwork URL (optional), GitHub
              URL, LinkedIn URL (optional)
            </p>
            {unmapped.length > 0 && (
              <p className="field-hint">
                Ignored column{unmapped.length === 1 ? "" : "s"}:{" "}
                {unmapped.join(", ")}
              </p>
            )}
            {parseErrors.length > 0 && (
              <details className="mt-2 text-xs text-amber-300/80">
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
            <p className="field-hint">
              Only contacts in the US, Canada or Europe are queued. Missing
              countries are resolved from the GitHub profile; leads whose country
              can&apos;t be determined are skipped.
            </p>
          </Card>

          {/* Run log */}
          {(results.length > 0 || running || runError) && (
            <Card
              title="Import log"
              actions={
                <div className="flex flex-wrap items-center justify-end gap-1.5">
                  <span className="badge badge-success tabular-nums">Queued {queuedCount}</span>
                  <span className="badge badge-neutral tabular-nums">Skipped {skippedCount}</span>
                  {failedCount > 0 && (
                    <span className="badge badge-danger tabular-nums">Failed {failedCount}</span>
                  )}
                  {results.length > queuedCount && (
                    <button type="button" onClick={copySkipped} className="btn btn-ghost btn-sm">
                      Copy
                    </button>
                  )}
                </div>
              }
            >
              {progress && (
                <div className="mb-4 h-1.5 w-full overflow-hidden rounded-full bg-white/10">
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
                <p className="mb-3 rounded-lg border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
                  {runError}
                </p>
              )}

              <div className="max-h-[32rem] divide-y divide-white/5 overflow-y-auto">
                {results.map((r) => (
                  <div key={`${r.index}-${r.githubUrl}`} className="py-2.5 first:pt-0 last:pb-0">
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
                      <span className="min-w-0 flex-1 truncate text-sm text-slate-100">
                        {r.name || r.login || r.githubUrl}
                      </span>
                      {r.country && (
                        <span className="shrink-0 text-xs text-slate-400">
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
                    <div className="mt-0.5 flex items-center gap-1.5 pl-3.5 text-xs">
                      {r.email ? (
                        <>
                          <span className="truncate font-mono text-cyan-200/90">{r.email}</span>
                          {r.cc && (
                            <span className="badge badge-neutral shrink-0" title={`Also CC'd: ${r.cc}`}>
                              CC {r.cc}
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
                          className="btn btn-ghost btn-sm ml-auto h-6 shrink-0 px-2"
                        >
                          {expanded === r.index ? "Hide" : "Why?"}
                        </button>
                      )}
                    </div>
                    {expanded === r.index && r.candidates && (
                      <ul className="mt-1.5 space-y-1 border-t border-white/5 pt-1.5 pl-3.5 text-[11px] text-slate-500">
                        {r.candidates.map((c) => (
                          <li key={c.email}>
                            <span className="font-mono text-slate-300">{c.email}</span>{" "}
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
                {results.length === 0 && !runError && (
                  <p className="text-xs text-slate-500">Waiting for the first lead…</p>
                )}
              </div>
            </Card>
          )}
        </div>

        {/* Message + queue settings */}
        <Card
          title="Sequence"
          description="Opener and follow-up sent to every queued lead."
          className="self-start"
          actions={
            <button
              type="button"
              onClick={() => setSettingsOpen((v) => !v)}
              className="btn btn-ghost btn-sm"
              aria-expanded={settingsOpen}
            >
              {settingsOpen ? "Hide" : "Show"}
            </button>
          }
          bodyClassName={settingsOpen ? undefined : "hidden"}
        >
          {settingsOpen && (
            <div className="flex flex-col gap-5">
              {/* Openers */}
              <div>
                <p className="field-label">Opener (message 1) — rotated across leads</p>
                <div className="max-h-56 space-y-0.5 overflow-y-auto rounded-lg border border-white/[0.08] bg-slate-950/40 p-1.5">
                  {openers.map((o) => (
                    <label
                      key={o.id}
                      className="flex cursor-pointer items-start gap-2.5 rounded-md px-2 py-1.5 text-xs text-slate-300 transition hover:bg-white/5"
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
                        <span className="block truncate text-[11px] text-slate-500">
                          {o.subject}
                        </span>
                      </span>
                    </label>
                  ))}
                  {openers.length === 0 && (
                    <p className="px-2 py-1.5 text-xs text-amber-300/80">
                      No opener templates yet — add one under Setup → Templates.
                    </p>
                  )}
                </div>
                {openerIds.length > 0 && settings && (
                  <p className="field-hint tabular-nums">
                    {openerIds.length} opener{openerIds.length === 1 ? "" : "s"} ·
                    ~{Math.round(settings.dailyCap / openerIds.length)} sends per
                    template per day at the current cap
                  </p>
                )}
              </div>

              {/* Follow-up */}
              <div>
                <p className="field-label">Follow-up (message 2)</p>
                <label className="mb-2 flex cursor-pointer items-center gap-2 text-xs text-slate-300">
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
                  className="input disabled:opacity-40"
                >
                  {followups.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.label}
                    </option>
                  ))}
                </select>
                <p className="field-hint">
                  Sent as a reply in the opener&apos;s thread. The queue sends it
                  fast once they reply, or after the follow-up delay set in
                  Queue settings.
                </p>
              </div>

              {/* Rate, cap and window are the queue's own global settings —
                  edited on the Queue page, shown here only as context. */}
              {settings && (
                <p className="border-t border-white/5 pt-4 text-xs leading-relaxed text-slate-500">
                  Sending rate, daily cap and window come from{" "}
                  <span className="text-slate-300">Queue settings</span>.
                  {settings.enabled
                    ? " The queue is running — imported leads start dripping right away."
                    : " The queue is paused — imported leads wait until you resume it."}
                </p>
              )}
            </div>
          )}
        </Card>
      </div>
    </PageBody>
  );
}
