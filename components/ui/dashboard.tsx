"use client";

// Dashboard page primitives. Every page in the app is built from these so
// headers, cards, stats and toolbars look the same everywhere. Styling lives
// in app/globals.css under "Dashboard design system" (.card, .btn, .badge,
// .seg, .input, .table-modern) — use those classes for anything not covered.

import type { ReactNode } from "react";

const cx = (...parts: (string | false | null | undefined)[]) =>
  parts.filter(Boolean).join(" ");

/** Title row at the top of every page: title + description left, actions right. */
export function PageHeader({
  title,
  description,
  icon,
  meta,
  actions,
}: {
  title: ReactNode;
  description?: ReactNode;
  /** Small icon shown in a tinted tile before the title. */
  icon?: ReactNode;
  /** Inline status next to the title (e.g. a Running badge). */
  meta?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="flex min-w-0 items-start gap-3">
        {icon && (
          <span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-cyan-400/10 text-cyan-300 ring-1 ring-inset ring-cyan-400/25">
            {icon}
          </span>
        )}
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <h2 className="truncate text-2xl font-semibold tracking-tight text-slate-50">
              {title}
            </h2>
            {meta}
          </div>
          {description && (
            <p className="mt-1 text-sm text-slate-400">{description}</p>
          )}
        </div>
      </div>
      {actions && (
        <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
      )}
    </div>
  );
}

/** Vertical stack for a page body: header, stats, cards. */
export function PageBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("fade-in flex flex-col gap-6", className)}>{children}</div>;
}

export type StatTone = "default" | "info" | "success" | "warning" | "danger" | "violet";

const TONE_TEXT: Record<StatTone, string> = {
  default: "text-slate-50",
  info: "text-cyan-300",
  success: "text-emerald-300",
  warning: "text-amber-300",
  danger: "text-rose-300",
  violet: "text-violet-300",
};

/** KPI tile: label, big number, optional hint and icon. */
export function StatCard({
  label,
  value,
  hint,
  icon,
  tone = "default",
  onClick,
  active,
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  icon?: ReactNode;
  tone?: StatTone;
  /** Makes the tile a button (e.g. a filter shortcut). */
  onClick?: () => void;
  active?: boolean;
}) {
  const body = (
    <>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-slate-400">{label}</span>
        {icon && <span className="text-slate-500">{icon}</span>}
      </div>
      <div className={cx("mt-2 text-2xl font-semibold tabular-nums tracking-tight", TONE_TEXT[tone])}>
        {value}
      </div>
      {hint && <div className="mt-1 text-xs text-slate-500">{hint}</div>}
    </>
  );
  const cls = cx(
    "card px-4 py-3.5 text-left",
    onClick && "transition hover:border-white/20",
    active && "border-cyan-400/50 ring-1 ring-cyan-400/30",
  );
  return onClick ? (
    <button type="button" onClick={onClick} className={cls}>
      {body}
    </button>
  ) : (
    <div className={cls}>{body}</div>
  );
}

/** Responsive grid for StatCards (2 → 4 columns). */
export function StatGrid({ children, cols = 4 }: { children: ReactNode; cols?: 2 | 3 | 4 | 5 }) {
  const lg = { 2: "lg:grid-cols-2", 3: "lg:grid-cols-3", 4: "lg:grid-cols-4", 5: "lg:grid-cols-5" }[cols];
  return <div className={cx("grid grid-cols-2 gap-3", lg)}>{children}</div>;
}

/** The standard surface. Pass `title` for a header row; `flush` drops body padding (tables, lists). */
export function Card({
  title,
  description,
  actions,
  children,
  flush,
  className,
  bodyClassName,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  flush?: boolean;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={cx("card overflow-hidden", className)}>
      {(title || actions) && (
        <div className="card-header">
          <div className="min-w-0">
            {title && <h3 className="card-title">{title}</h3>}
            {description && <p className="card-description">{description}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </div>
      )}
      <div className={cx(!flush && "card-body", bodyClassName)}>{children}</div>
    </section>
  );
}

/** Row above a list/table: search + filters left, actions right. */
export function Toolbar({ children, actions }: { children?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">{children}</div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function SearchInput({
  value,
  onChange,
  placeholder = "Search…",
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
}) {
  return (
    <div className={cx("relative w-full sm:max-w-xs", className)}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500">
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-3.5-3.5" />
      </svg>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="input pl-9"
        spellCheck={false}
      />
    </div>
  );
}

/** Filter tabs / segmented control. */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: ReactNode; count?: number; icon?: ReactNode }[];
}) {
  return (
    <div className="seg" role="tablist">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={value === o.value}
          onClick={() => onChange(o.value)}
          className={cx("seg-item", value === o.value && "seg-item-active")}
        >
          {o.icon}
          {o.label}
          {o.count !== undefined && <span className="seg-count">{o.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      {icon && (
        <span className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-white/5 text-slate-400 ring-1 ring-inset ring-white/10">
          {icon}
        </span>
      )}
      <p className="text-sm font-medium text-slate-200">{title}</p>
      {description && <p className="mt-1 max-w-sm text-xs text-slate-500">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/** Settings-style row: label + description left, control right. */
export function SettingRow({
  title,
  description,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 border-b border-white/5 py-4 last:border-0 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="text-sm font-medium text-slate-200">{title}</p>
        {description && <p className="mt-0.5 text-xs text-slate-500">{description}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}
