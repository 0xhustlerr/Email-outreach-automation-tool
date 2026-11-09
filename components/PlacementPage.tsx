"use client";

// Spam check: send a real Opener from a Sender to seed inboxes and see where
// each copy landed (Inbox, a Gmail tab, Spam). Results are collected while
// this page polls; nothing runs in the background.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import PlacementSummaryBadge from "@/components/PlacementSummaryBadge";
import { Card, EmptyState, PageBody, PageHeader, Segmented, SettingRow } from "@/components/ui/dashboard";
import {
  PLACEMENT_LABEL,
  type Placement,
  type PlacementProviderId,
  type PlacementTestView,
} from "@/lib/placement/types";

type Snapshot = {
  sendingDisabled: boolean;
  providers: { id: PlacementProviderId; label: string; configured: boolean; reason: string }[];
  senders: {
    email: string;
    name: string;
    seeds: string[];
    latest: PlacementTestView | null;
    history: PlacementTestView[];
  }[];
  seedInboxes: { email: string; createdAt: string }[];
  seedOptions: { email: string; kind: "sender" | "extra"; enabled: boolean }[];
  glockapps: { configured: boolean; projectId: string; providerGroupIds: string[] };
  templates: { id: string; label: string }[];
};

const PROVIDER_KEY = "placement.provider";
const TEMPLATE_KEY = "placement.template";
const POLL_MS = 10_000;

function readLocal(key: string): string {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}
function writeLocal(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // ignore
  }
}

const isActive = (t: PlacementTestView | null) =>
  !!t && (t.status === "sending" || t.status === "running");

const PLACEMENT_BADGE: Record<Placement, string> = {
  inbox: "badge-success",
  tab: "badge-warning",
  spam: "badge-danger",
  other: "badge-violet",
  missing: "badge-warning",
  error: "badge-neutral",
  send_failed: "badge-neutral",
  pending: "badge-info",
};

const BAR_COLOR: Partial<Record<Placement, string>> = {
  inbox: "bg-emerald-400",
  tab: "bg-amber-300",
  other: "bg-violet-400",
  spam: "bg-rose-500",
  missing: "bg-amber-600",
  error: "bg-slate-600",
  send_failed: "bg-slate-600",
  pending: "bg-slate-700",
};
const BAR_ORDER: Placement[] = ["inbox", "tab", "other", "spam", "missing", "error", "send_failed", "pending"];

function PlacementBar({ test }: { test: PlacementTestView }) {
  const total = test.counts.total;
  if (total === 0) return <div className="h-2 rounded-full bg-white/5" />;
  return (
    <div className="flex h-2 overflow-hidden rounded-full bg-white/5" role="img" aria-label="Placement breakdown">
      {BAR_ORDER.filter((p) => test.counts[p] > 0).map((p) => (
        <div
          key={p}
          className={BAR_COLOR[p]}
          style={{ width: `${(test.counts[p] / total) * 100}%` }}
          title={`${PLACEMENT_LABEL[p]}: ${test.counts[p]}`}
        />
      ))}
    </div>
  );
}

function formatDateTime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

export default function PlacementPage() {
  const [data, setData] = useState<Snapshot | null>(null);
  // This page only mounts on the client (the view comes from the URL), so the
  // remembered choices can seed state directly.
  const [provider, setProvider] = useState<PlacementProviderId>(() =>
    readLocal(PROVIDER_KEY) === "glockapps" ? "glockapps" : "seeds",
  );
  const [templateId, setTemplateId] = useState(() => readLocal(TEMPLATE_KEY));
  const [starting, setStarting] = useState<string[]>([]);
  // Spam/failed results already shown, so a poll only toasts what is new.
  const seen = useRef<Set<string> | null>(null);

  const announce = useCallback((snap: Snapshot) => {
    const keys = new Set<string>();
    const fresh: { kind: "spam" | "error"; text: string }[] = [];
    for (const s of snap.senders) {
      for (const t of s.history) {
        // A failed test, or a check that hit an error (shown once per message).
        if (t.status === "failed" || t.error) {
          const k = `${t.id}:${t.status === "failed" ? "failed" : "error"}:${t.error}`;
          keys.add(k);
          if (seen.current && !seen.current.has(k)) {
            fresh.push({
              kind: "error",
              text:
                t.status === "failed"
                  ? `Placement test for ${s.email} failed${t.error ? `: ${t.error}` : "."}`
                  : `Couldn't check ${s.email}'s placement test: ${t.error}`,
            });
          }
        }
        for (const r of t.results) {
          if (r.placement !== "spam") continue;
          const k = `${t.id}:${r.seed}`;
          keys.add(k);
          if (seen.current && !seen.current.has(k)) {
            fresh.push({ kind: "spam", text: `${s.email} landed in Spam at ${r.seed}` });
          }
        }
      }
    }
    // The first load only records what is already there.
    if (seen.current) {
      for (const f of fresh) {
        if (f.kind === "spam") toast.warning(f.text);
        else toast.error(f.text);
      }
      for (const k of keys) seen.current.add(k);
    } else {
      seen.current = keys;
    }
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/placement", { cache: "no-store" });
      const body = await res.json();
      if (!res.ok || !body.ok) throw new Error(body.error ?? "Could not load spam check results.");
      setData(body as Snapshot);
      announce(body as Snapshot);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not load spam check results.", {
        id: "placement-load",
      });
    }
  }, [announce]);

  useEffect(() => {
    // Deferred a tick so the effect body itself sets no state.
    const t = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(t);
  }, [load]);

  const anyActive = !!data?.senders.some((s) => isActive(s.latest));
  useEffect(() => {
    if (!anyActive) return;
    const t = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(t);
  }, [anyActive, load]);

  // Fall back to the first Opener when the remembered one is gone.
  const template = useMemo(() => {
    const list = data?.templates ?? [];
    return list.find((t) => t.id === templateId) ?? list[0] ?? null;
  }, [data, templateId]);

  const providerInfo = data?.providers.find((p) => p.id === provider);
  const providerLabels = Object.fromEntries(
    (data?.providers ?? []).map((p) => [p.id, p.label]),
  ) as Record<PlacementProviderId, string>;
  // Senders "Check all" can test: with seed inboxes, only those with a seed;
  // one already running is skipped rather than doubled.
  const runnable = (data?.senders ?? [])
    .filter((s) => !isActive(s.latest) && (provider !== "seeds" || s.seeds.length > 0))
    .map((s) => s.email);

  const start = async (senders: string[]) => {
    if (!template) {
      toast.error("Add an Opener template first (Templates page).");
      return;
    }
    setStarting(senders);
    try {
      const res = await fetch("/api/placement", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ senders, provider, templateId: template.id }),
      });
      const body = await res.json();
      if (!res.ok || !body.ok) {
        toast.error(body.error ?? "Could not start the placement test.");
        return;
      }
      setData(body as Snapshot);
      announce(body as Snapshot);
      toast.success(
        senders.length === 1 ? `Placement test started for ${senders[0]}.` : `Placement tests started for ${senders.length} Senders.`,
      );
    } catch {
      toast.error("Network error while starting the placement test.");
    } finally {
      setStarting([]);
    }
  };

  const runDisabledReason = !data
    ? "Loading…"
    : data.sendingDisabled
      ? "Sending is disabled on this server (NEXT_PUBLIC_SEND_DISABLED=1)."
      : !providerInfo?.configured
        ? providerInfo?.reason || "Set up this test type first."
        : !template
          ? "Add an Opener template first."
          : "";

  return (
    <PageBody>
      <PageHeader
        title="Spam check"
        icon={<ShieldIcon className="h-5 w-5" />}
        description="Send a real Opener to seed inboxes and see whether each Sender lands in Inbox, a tab, or Spam."
        meta={
          data?.sendingDisabled ? (
            <span className="badge badge-warning" title="NEXT_PUBLIC_SEND_DISABLED=1">
              Sending disabled
            </span>
          ) : undefined
        }
        actions={
          <button
            type="button"
            className="btn btn-primary"
            disabled={!!runDisabledReason || starting.length > 0 || runnable.length === 0}
            title={runDisabledReason || "Run a placement test for every Sender"}
            onClick={() => void start(runnable)}
          >
            {starting.length > 1 ? "Starting…" : "Check all Senders"}
          </button>
        }
      />

      <Card title="Test setup">
        <SettingRow
          title="Test with"
          description={
            provider === "seeds"
              ? "Your other Senders with reply sync, plus any seed inboxes below. Free; Gmail only."
              : "GlockApps' seed list across Gmail, Outlook, Yahoo and more. Uses one GlockApps credit per Sender."
          }
        >
          <Segmented
            value={provider}
            onChange={(v) => {
              setProvider(v);
              writeLocal(PROVIDER_KEY, v);
            }}
            options={(data?.providers ?? [{ id: "seeds" as const, label: "Seed inboxes", configured: true, reason: "" }]).map((p) => ({
              value: p.id,
              label: p.configured ? p.label : `${p.label} (not set up)`,
            }))}
          />
        </SettingRow>
        <SettingRow title="Opener template" description="The test is the real email a prospect would get, with your Signature.">
          <select
            value={template?.id ?? ""}
            onChange={(e) => {
              setTemplateId(e.target.value);
              writeLocal(TEMPLATE_KEY, e.target.value);
            }}
            className="input min-w-[16rem]"
            disabled={!data?.templates.length}
          >
            {(data?.templates ?? []).map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </SettingRow>
        {/* Why the run buttons are off — a hint, not an error. */}
        {runDisabledReason && data && (
          <p className="flex flex-wrap items-center gap-2 pt-3 text-xs text-slate-400">
            {runDisabledReason}
            {!data.sendingDisabled && !providerInfo?.configured && (
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() =>
                  document
                    .getElementById(`placement-setup-${provider}`)
                    ?.scrollIntoView({ behavior: "smooth", block: "start" })
                }
              >
                Set up
              </button>
            )}
          </p>
        )}
      </Card>

      {data && data.senders.length === 0 && (
        <Card>
          <EmptyState
            icon={<ShieldIcon className="h-5 w-5" />}
            title="No Senders yet"
            description="Add a sending account on the Accounts page, then check where its email lands."
          />
        </Card>
      )}

      {data?.senders.map((s) => (
        <SenderCard
          key={s.email}
          sender={s}
          provider={provider}
          providerLabels={providerLabels}
          starting={starting.includes(s.email)}
          disabledReason={
            runDisabledReason ||
            (provider === "seeds" && s.seeds.length === 0
              ? "No checked seed inbox to send to: check one below, add one, or turn on reply sync for another Sender."
              : "")
          }
          onRun={() => void start([s.email])}
        />
      ))}

      {data && (
        <div id="placement-setup-seeds" className="scroll-mt-6">
          <SeedInboxesCard data={data} onChanged={load} />
        </div>
      )}
      {data && (
        <div id="placement-setup-glockapps" className="scroll-mt-6">
          {/* Keyed on the saved settings so the form resets after a save/remove. */}
          <GlockAppsCard
            key={`${data.glockapps.configured}|${data.glockapps.projectId}|${data.glockapps.providerGroupIds.join(",")}`}
            data={data}
            onChanged={() => void load()}
          />
        </div>
      )}
    </PageBody>
  );
}

function SenderCard({
  sender,
  provider,
  providerLabels,
  starting,
  disabledReason,
  onRun,
}: {
  sender: Snapshot["senders"][number];
  provider: PlacementProviderId;
  providerLabels: Record<PlacementProviderId, string>;
  starting: boolean;
  disabledReason: string;
  onRun: () => void;
}) {
  const latest = sender.latest;
  const older = sender.history.slice(1);
  const active = isActive(latest);
  return (
    <Card
      title={
        <span className="flex flex-wrap items-center gap-2">
          <span className="truncate">{sender.name || sender.email}</span>
          <PlacementSummaryBadge test={latest} />
        </span>
      }
      description={
        <>
          {sender.name ? `${sender.email} · ` : ""}
          {provider === "seeds"
            ? `${sender.seeds.length} seed inbox${sender.seeds.length === 1 ? "" : "es"}`
            : `${providerLabels[provider]} seed list`}
          {latest ? ` · last test ${formatDateTime(latest.createdAt)}` : ""}
        </>
      }
      actions={
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={!!disabledReason || starting || active}
          title={disabledReason || (active ? "A test is still running" : "Run a placement test now")}
          onClick={onRun}
        >
          {starting ? "Starting…" : active ? "Testing…" : "Check this Sender"}
        </button>
      }
    >
      {!latest ? (
        <p className="text-sm text-slate-500">Not tested yet.</p>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <PlacementBar test={latest} />
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-400">
              {BAR_ORDER.filter((p) => latest.counts[p] > 0).map((p) => (
                <span key={p}>
                  <span className={`mr-1.5 inline-block h-2 w-2 rounded-full ${BAR_COLOR[p]}`} />
                  {PLACEMENT_LABEL[p]} {latest.counts[p]}
                </span>
              ))}
              <span className="text-slate-500">
                {providerLabels[latest.provider]} · “{latest.subject}”
              </span>
            </div>
          </div>

          {latest.results.length > 0 && (
            <div className="overflow-x-auto">
              <table className="table-modern w-full">
                <thead>
                  <tr>
                    <th>Seed</th>
                    <th>Provider</th>
                    <th>Landed in</th>
                    <th>Detail</th>
                    <th>Checked</th>
                  </tr>
                </thead>
                <tbody>
                  {latest.results.map((r) => (
                    <tr key={r.seed}>
                      <td className="font-mono text-xs">{r.seed}</td>
                      <td className="text-xs text-slate-400">{r.seedProvider || "—"}</td>
                      <td>
                        <span className={`badge ${PLACEMENT_BADGE[r.placement]}`}>
                          {r.placement === "tab" && r.detail ? r.detail : PLACEMENT_LABEL[r.placement]}
                        </span>
                      </td>
                      <td className="max-w-[28rem] truncate text-xs text-slate-500" title={r.detail}>
                        {r.placement === "tab" ? "" : r.detail}
                      </td>
                      <td className="whitespace-nowrap text-xs text-slate-500">
                        {formatDateTime(r.checkedAt) || "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {older.length > 0 && (
            <div>
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                Earlier tests
              </p>
              <ul className="flex flex-col gap-1.5">
                {older.map((t) => (
                  <li key={t.id} className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
                    <PlacementSummaryBadge test={t} />
                    <span>{formatDateTime(t.createdAt)}</span>
                    <span className="text-slate-500">{providerLabels[t.provider]}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function SeedInboxesCard({ data, onChanged }: { data: Snapshot; onChanged: () => Promise<void> }) {
  const [email, setEmail] = useState("");
  const [token, setToken] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [ownClient, setOwnClient] = useState(false);
  const [busy, setBusy] = useState(false);
  // Checkbox changes waiting on the server, shown immediately.
  const [pending, setPending] = useState<Record<string, boolean>>({});

  const options = data.seedOptions;
  const isChecked = (s: { email: string; enabled: boolean }) => pending[s.email] ?? s.enabled;
  const checkedCount = options.filter(isChecked).length;

  const toggle = async (seed: string, enabled: boolean) => {
    setPending((p) => ({ ...p, [seed]: enabled }));
    try {
      const res = await fetch("/api/placement/seeds", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: seed, enabled }),
      });
      const body = await res.json();
      if (!res.ok || !body.ok) {
        toast.error(body.error ?? "Could not update the seed inbox.");
        return;
      }
      // Reload so the per-Sender seed counts follow; the reloaded snapshot
      // carries the saved state, so the optimistic value can go after it.
      await onChanged();
    } catch {
      toast.error("Network error while updating the seed inbox.");
    } finally {
      setPending((p) => {
        const next = { ...p };
        delete next[seed];
        return next;
      });
    }
  };

  const add = async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/placement/seeds", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          refreshToken: token,
          ...(ownClient ? { clientId, clientSecret } : {}),
        }),
      });
      const body = await res.json();
      if (!res.ok || !body.ok) {
        toast.error(body.error ?? "Could not add the seed inbox.");
        return;
      }
      toast.success(`${email.trim().toLowerCase()} is now a seed inbox.`);
      setEmail("");
      setToken("");
      setClientId("");
      setClientSecret("");
      void onChanged();
    } catch {
      toast.error("Network error while adding the seed inbox.");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (seed: string) => {
    try {
      const res = await fetch("/api/placement/seeds", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: seed }),
      });
      const body = await res.json();
      if (!res.ok || !body.ok) {
        toast.error(body.error ?? "Could not remove the seed inbox.");
        return;
      }
      void onChanged();
    } catch {
      toast.error("Network error while removing the seed inbox.");
    }
  };

  return (
    <Card
      title="Seed inboxes"
      description="Checked inboxes receive the test and are read (read-only) to see where it landed. A Sender is never sent its own test. A personal Gmail you never send outreach from gives the most honest result."
      actions={
        options.length > 0 ? (
          <span className="text-xs text-slate-400">
            {checkedCount} of {options.length} checked
          </span>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1 text-sm">
          {options.map((s) => (
            <div key={s.email} className="flex items-center justify-between gap-3">
              <label className="flex min-w-0 cursor-pointer items-center gap-2.5 py-0.5">
                <input
                  type="checkbox"
                  className="h-4 w-4 shrink-0 cursor-pointer accent-cyan-400"
                  checked={isChecked(s)}
                  onChange={(e) => void toggle(s.email, e.target.checked)}
                  aria-label={`Send test emails to ${s.email}`}
                />
                <span
                  className={`truncate font-mono text-xs ${isChecked(s) ? "text-slate-300" : "text-slate-500 line-through"}`}
                >
                  {s.email}
                </span>
              </label>
              {s.kind === "sender" ? (
                <span className="badge badge-neutral shrink-0" title="A Sender with reply sync. Manage it on the Accounts page.">
                  Sender
                </span>
              ) : (
                <button type="button" className="btn btn-ghost btn-sm shrink-0" onClick={() => void remove(s.email)}>
                  Remove
                </button>
              )}
            </div>
          ))}
          {options.length === 0 && (
            <p className="text-xs text-slate-500">
              None yet. Turn on reply sync for a second Sender, or add a Gmail inbox here.
            </p>
          )}
        </div>

        <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
          <p className="mb-3 text-sm font-medium text-slate-200">Add a Gmail seed inbox</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <input
              className="input"
              placeholder="seed@gmail.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              spellCheck={false}
            />
            <input
              className="input font-mono"
              placeholder="Refresh token (1//…)"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              spellCheck={false}
              type="password"
              autoComplete="off"
            />
          </div>
          <label className="mt-3 flex items-center gap-2 text-xs text-slate-400">
            <input type="checkbox" checked={ownClient} onChange={(e) => setOwnClient(e.target.checked)} />
            This token was minted with its own OAuth client (not the one your Senders use)
          </label>
          {ownClient && (
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <input className="input font-mono" placeholder="Client ID" value={clientId} onChange={(e) => setClientId(e.target.value)} spellCheck={false} />
              <input
                className="input font-mono"
                placeholder="Client secret"
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
                spellCheck={false}
                type="password"
                autoComplete="off"
              />
            </div>
          )}
          <p className="mt-3 text-xs text-slate-500">
            Get the token the same way as a Sender&apos;s reply sync: in the OAuth Playground, authorize the{" "}
            <span className="font-mono text-slate-300">gmail.readonly</span> scope while signed in as the seed inbox.
          </p>
          <div className="mt-3 flex justify-end">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={busy || !email.trim() || !token.trim()}
              onClick={() => void add()}
            >
              {busy ? "Verifying…" : "Add seed inbox"}
            </button>
          </div>
        </div>
      </div>
    </Card>
  );
}

function GlockAppsCard({ data, onChanged }: { data: Snapshot; onChanged: () => void }) {
  const g = data.glockapps;
  const [apiKey, setApiKey] = useState("");
  const [projectId, setProjectId] = useState(g.projectId);
  const [groups, setGroups] = useState(g.providerGroupIds.join(", "));
  const [projects, setProjects] = useState<{ id: string; name: string }[] | null>(null);
  const [busy, setBusy] = useState<"" | "projects" | "save" | "remove">("");

  const loadProjects = async () => {
    setBusy("projects");
    try {
      const res = await fetch("/api/placement/glockapps", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey }),
      });
      const body = await res.json();
      if (!res.ok || !body.ok) {
        toast.error(body.error ?? "Could not load GlockApps projects.");
        return;
      }
      setProjects(body.projects);
      if (!projectId && body.projects[0]) setProjectId(body.projects[0].id);
      if (body.projects.length === 0) toast.warning("Key accepted, but no projects were listed. Enter the project ID by hand.");
    } catch {
      toast.error("Network error while contacting GlockApps.");
    } finally {
      setBusy("");
    }
  };

  const save = async () => {
    setBusy("save");
    try {
      const res = await fetch("/api/placement/glockapps", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiKey,
          projectId,
          providerGroupIds: groups.split(/[\s,]+/).filter(Boolean),
        }),
      });
      const body = await res.json();
      if (!res.ok || !body.ok) {
        toast.error(body.error ?? "Could not save GlockApps settings.");
        return;
      }
      toast.success("GlockApps is set up.");
      setApiKey("");
      void onChanged();
    } catch {
      toast.error("Network error while saving GlockApps settings.");
    } finally {
      setBusy("");
    }
  };

  const remove = async () => {
    setBusy("remove");
    try {
      const res = await fetch("/api/placement/glockapps", { method: "DELETE" });
      const body = await res.json();
      if (!res.ok || !body.ok) {
        toast.error(body.error ?? "Could not remove GlockApps settings.");
        return;
      }
      setProjects(null);
      void onChanged();
    } catch {
      toast.error("Network error while removing GlockApps settings.");
    } finally {
      setBusy("");
    }
  };

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          GlockApps
          <span className={`badge ${g.configured ? "badge-success" : "badge-neutral"}`}>
            {g.configured ? "Set up" : "Not set up"}
          </span>
        </span>
      }
      description="Paid seed testing across Gmail, Outlook, Yahoo and more. API access needs a GlockApps paid or pay-per-test plan; each test uses one credit."
      actions={
        g.configured ? (
          <button type="button" className="btn btn-ghost btn-sm" disabled={!!busy} onClick={() => void remove()}>
            Remove
          </button>
        ) : undefined
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex gap-2">
          <input
            className="input font-mono"
            placeholder={g.configured ? "API key saved (paste to replace)" : "GlockApps API key"}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            type="password"
            autoComplete="off"
            spellCheck={false}
          />
          <button
            type="button"
            className="btn btn-secondary btn-sm shrink-0"
            disabled={!!busy || (!apiKey.trim() && !g.configured)}
            onClick={() => void loadProjects()}
          >
            {busy === "projects" ? "Loading…" : "Load projects"}
          </button>
        </div>
        {projects && projects.length > 0 ? (
          <select className="input" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.id})
              </option>
            ))}
          </select>
        ) : (
          <input
            className="input font-mono"
            placeholder="Project ID"
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            spellCheck={false}
          />
        )}
        <input
          className="input font-mono sm:col-span-2"
          placeholder="Provider group IDs, comma-separated (blank = all groups in the project)"
          value={groups}
          onChange={(e) => setGroups(e.target.value)}
          spellCheck={false}
        />
      </div>
      <p className="mt-3 text-xs text-slate-500">
        Fewer provider groups means a shorter seed list for your Sender to mail. The test goes out as one email
        to every seed (BCC), which is how GlockApps expects it.
      </p>
      <div className="mt-3 flex justify-end">
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={!!busy || !projectId.trim() || (!apiKey.trim() && !g.configured)}
          onClick={() => void save()}
        >
          {busy === "save" ? "Checking…" : "Save"}
        </button>
      </div>
    </Card>
  );
}

export function ShieldIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M12 3 4 6v6c0 4.5 3.4 8.3 8 9 4.6-.7 8-4.5 8-9V6l-8-3z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}
