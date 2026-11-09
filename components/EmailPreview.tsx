"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Card } from "@/components/ui/dashboard";
import { EmailFrame } from "@/components/ui/email-frame";
import type { TemplateKind } from "@/hooks/useTemplates";
import { composeEmail, signatureApplies } from "@/lib/mail-html";
import {
  displayName,
  replySubject,
  senderVars,
  substitute,
  urlVars,
} from "@/lib/template-vars";
import type { MailIdentity, SignatureScope } from "@/lib/types";

// A template as a recipient would get it: contact placeholders filled from a
// sample contact, then composed by the same function sendMail uses, from the
// Sender picked in "From" — its name, address and Signature.

type SampleContact = {
  name: string;
  upwork: string;
  linkedin: string;
  github: string;
};

const DEFAULT_SAMPLE: SampleContact = {
  name: "Alex",
  upwork: "https://www.upwork.com/freelancers/~0123456789abcdef",
  linkedin: "https://www.linkedin.com/in/alex-example",
  github: "https://github.com/alex-example",
};

const SAMPLE_KEY = "templates.preview.sample";
const FROM_KEY = "templates.preview.from";

// Shown when no Sender is connected (or the list could not be loaded).
const PLACEHOLDER_SENDER: MailIdentity = { name: "Your name", email: "you@example.com" };

type SignatureInfo = { signature: string; scope: SignatureScope };
const NO_SIGNATURE: SignatureInfo = { signature: "", scope: "all" };

function readStored<T>(key: string, fallback: T): T {
  try {
    const raw = typeof window === "undefined" ? null : localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as T;
    // Objects merge over the defaults so a field added later still has a value.
    return typeof fallback === "object" && fallback !== null
      ? { ...fallback, ...parsed }
      : typeof parsed === typeof fallback
        ? parsed
        : fallback;
  } catch {
    return fallback;
  }
}

function writeStored(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private window / blocked storage: the preview just forgets on reload.
  }
}

/** Connected Senders and their Signatures, from the Accounts page's own API. */
function useSenders() {
  const [identities, setIdentities] = useState<MailIdentity[]>([]);
  const [signatures, setSignatures] = useState<Record<string, SignatureInfo>>({});
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/senders");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as {
          identities?: MailIdentity[];
          signatures?: Record<string, SignatureInfo>;
        };
        if (cancelled) return;
        setIdentities(data.identities ?? []);
        // Keyed by lowercase address, like the Accounts page.
        setSignatures(
          Object.fromEntries(
            Object.entries(data.signatures ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
          ),
        );
      } catch {
        if (!cancelled) {
          toast.error("Could not load your accounts, so the preview uses a placeholder sender.", {
            id: "preview-senders",
          });
        }
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return { identities, signatures, loaded };
}

export function TemplatePreviewCard({
  subject,
  body,
  kind,
  openerSubject,
  className,
}: {
  subject: string;
  body: string;
  /** "followup" previews it as a Pitch: threaded subject, sent as a reply. */
  kind: TemplateKind;
  /** The Opener subject a Pitch threads under ("Re: …"). */
  openerSubject: string;
  className?: string;
}) {
  const { identities, signatures, loaded } = useSenders();
  // Read straight from browser storage: the Templates view only ever renders on
  // the client (useDashboardView's server snapshot is the scanner), so there is
  // no server render to mismatch.
  const [fromEmail, setFromEmail] = useState(() => readStored(FROM_KEY, ""));
  const [sample, setSample] = useState<SampleContact>(() => readStored(SAMPLE_KEY, DEFAULT_SAMPLE));

  const picked =
    identities.find((i) => i.email.toLowerCase() === fromEmail.toLowerCase()) ??
    identities[0] ??
    null;
  // A nameless Sender signs with its address, as in sendMail.
  const sender: MailIdentity = picked
    ? { name: picked.name.trim() || picked.email, email: picked.email }
    : PLACEHOLDER_SENDER;
  const sig: SignatureInfo = (picked && signatures[picked.email.toLowerCase()]) || NO_SIGNATURE;

  const pickFrom = (email: string) => {
    setFromEmail(email);
    writeStored(FROM_KEY, email);
  };

  const updateSample = (patch: Partial<SampleContact>) => {
    const next = { ...sample, ...patch };
    setSample(next);
    writeStored(SAMPLE_KEY, next);
  };

  // Contact placeholders first, exactly as the queue renders them; the sender
  // ones are left for composeEmail, as they are left for sendMail.
  const vars = {
    name: displayName(sample.name),
    ...senderVars(),
    ...urlVars({ upwork: sample.upwork, linkedin: sample.linkedin, github: sample.github }),
  };
  const isPitch = kind === "followup";
  // A Pitch reuses the Opener's subject as "Re: …" so it threads — the same
  // rule the queue worker sends with.
  const email = composeEmail({
    subject: substitute(isPitch ? replySubject(openerSubject) : subject, vars),
    body: substitute(body, vars),
    sender,
    signature: sig.signature,
    signatureScope: sig.scope,
    isReply: isPitch,
  });
  const hasSig = !!sig.signature.trim();
  const sigHeldBack = hasSig && !signatureApplies(sig.scope, isPitch);

  return (
    <Card
      title="Preview"
      description="As the recipient sees it. Updates as you type."
      className={"min-w-0 " + (className ?? "")}
    >
      <div className="flex flex-col gap-4">
        {/* The made-up contact the {{name}} / {{url…}} placeholders are filled
            from. Remembered in this browser. */}
        <div role="group" aria-labelledby="pv-sample" className="min-w-0">
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <span id="pv-sample" className="field-label !mb-0">
              Sample contact
            </span>
            <button
              type="button"
              onClick={() => updateSample(DEFAULT_SAMPLE)}
              className="btn btn-ghost btn-sm h-6 px-2 text-xs"
            >
              Reset
            </button>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <SampleField
              label="Name"
              placeholder="{{name}}"
              value={sample.name}
              onChange={(v) => updateSample({ name: v })}
            />
            <SampleField
              label="Upwork URL"
              placeholder="{{url}} · {{url_upwork}}"
              value={sample.upwork}
              onChange={(v) => updateSample({ upwork: v })}
            />
            <SampleField
              label="LinkedIn URL"
              placeholder="{{url_linkedin}}"
              value={sample.linkedin}
              onChange={(v) => updateSample({ linkedin: v })}
            />
            <SampleField
              label="GitHub URL"
              placeholder="{{url_github}}"
              value={sample.github}
              onChange={(v) => updateSample({ github: v })}
            />
          </div>
        </div>

        {/* Envelope, like the top of a message in a mail client. "From" is
            the Sender picker: switching it re-renders as that Sender. */}
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-1 border-t border-white/5 pt-4 text-xs">
          <dt className="text-slate-500">
            {identities.length > 0 ? <label htmlFor="pv-from">From</label> : "From"}
          </dt>
          <dd className="min-w-0 text-slate-200">
            {identities.length > 0 ? (
              <select
                id="pv-from"
                value={sender.email}
                onChange={(e) => pickFrom(e.target.value)}
                title="Preview as sent from this account"
                className="input h-8 w-full py-0 text-xs"
              >
                {identities.map((i) => (
                  <option key={i.email} value={i.email}>
                    {i.name.trim() && i.name !== i.email ? `${i.name} <${i.email}>` : i.email}
                  </option>
                ))}
              </select>
            ) : (
              <span className="block truncate" title={`${sender.name} <${sender.email}>`}>
                {sender.name} <span className="text-slate-400">&lt;{sender.email}&gt;</span>
              </span>
            )}
          </dd>
          <dt className="text-slate-500">To</dt>
          <dd className="min-w-0 truncate text-slate-200">
            {sample.name.trim() || <span className="italic text-slate-500">(no name)</span>}
          </dd>
          <dt className="text-slate-500">Subject</dt>
          <dd className="min-w-0 break-words font-medium text-slate-100">
            {email.subject.trim() || <span className="font-normal italic text-slate-500">(no subject)</span>}
          </dd>
        </dl>

        <EmailFrame html={email.html} title="Email preview" minHeight={120} maxHeight={900} />

        <div className="flex flex-col gap-1 empty:hidden">
          {loaded && !picked && (
            <p className="field-hint">
              No account connected, so this uses a placeholder sender. Connect one on the
              Accounts page to preview its name and signature.
            </p>
          )}
          {picked && !hasSig && (
            <p className="field-hint">This account has no signature. Add one on the Accounts page.</p>
          )}
          {sigHeldBack && (
            <p className="field-hint">
              This account&apos;s signature is set to Openers only, so it is left off follow-ups.
            </p>
          )}
          {isPitch && (
            <p className="field-hint">
              The subject comes from whichever opener the contact got; this shows the first one.
            </p>
          )}
        </div>
      </div>
    </Card>
  );
}

/** One compact sample-contact field. The placeholder it fills shows in the
 *  label, and in the box when it is empty. */
function SampleField({
  label,
  placeholder,
  value,
  onChange,
}: {
  label: string;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="block min-w-0">
      <span className="mb-1 block truncate text-[11px] text-slate-500">
        {label} <span className="font-mono">{placeholder}</span>
      </span>
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="input h-8 py-0 text-xs"
      />
    </label>
  );
}
