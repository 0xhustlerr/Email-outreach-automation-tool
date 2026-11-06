"use client";

import { useCallback, useEffect, useSyncExternalStore, type ReactNode } from "react";

export type SidebarItem = {
  key: string;
  label: string;
  icon: ReactNode;
  onClick: () => void;
  title?: string;
  active?: boolean;
  disabled?: boolean;
  /** Count shown as a pill (expanded) or a dot on the icon (collapsed). */
  badge?: number;
  /** Small pulsing dot, e.g. "loading in background". */
  busy?: boolean;
};

export type SidebarGroup = { label: string; items: SidebarItem[] };

const STORAGE_KEY = "sidebar-collapsed";

const CHANGE_EVENT = "sidebar-collapsed-change";

// In-memory fallback so the toggle still works when storage is blocked.
let memoryCollapsed = false;

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return memoryCollapsed;
  }
}

function writeCollapsed(next: boolean) {
  memoryCollapsed = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
  } catch {
    // storage blocked — memoryCollapsed carries it for this session
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function subscribe(onChange: () => void) {
  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

/**
 * Collapsed state for the dashboard sidebar, remembered across sessions.
 * The server render is always expanded, so hydration never mismatches.
 * Ctrl/Cmd+B toggles it from anywhere.
 */
export function useSidebarCollapsed() {
  const collapsed = useSyncExternalStore(subscribe, readCollapsed, () => false);

  const toggle = useCallback(() => writeCollapsed(!readCollapsed()), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "b") {
        e.preventDefault();
        toggle();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle]);

  return [collapsed, toggle] as const;
}

export default function AppSidebar({
  brand,
  logo,
  groups,
  footer,
  collapsed,
  onToggleCollapsed,
  mobileOpen,
  onMobileClose,
}: {
  brand: string;
  logo: ReactNode;
  groups: SidebarGroup[];
  /** Rendered above the collapse toggle; receives the collapsed flag. */
  footer?: (collapsed: boolean) => ReactNode;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  mobileOpen: boolean;
  onMobileClose: () => void;
}) {
  // Escape closes the mobile drawer.
  useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onMobileClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mobileOpen, onMobileClose]);

  // On mobile the drawer always shows labels; the rail is a desktop concept.
  const body = (isRail: boolean, inDrawer: boolean) => (
    <div className="flex h-full flex-col">
      {/* Brand */}
      <div
        className={
          "flex h-16 shrink-0 items-center gap-2.5 border-b border-white/5 " +
          (isRail ? "justify-center px-2" : "px-5")
        }
      >
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-cyan-400/10 ring-1 ring-cyan-400/30">
          {logo}
        </span>
        {!isRail && (
          <span className="truncate text-[13px] font-semibold uppercase tracking-[0.2em] text-cyan-300">
            {brand}
          </span>
        )}
      </div>

      {/* Navigation */}
      <nav className="no-scrollbar flex-1 overflow-y-auto overflow-x-hidden px-3 py-4">
        {groups.map((group, gi) => (
          <div key={group.label} className={gi > 0 ? "mt-5" : ""}>
            {isRail ? (
              gi > 0 && <div className="mx-2 mb-3 h-px bg-white/5" aria-hidden />
            ) : (
              <p className="mb-1.5 px-3 text-[10px] font-semibold uppercase tracking-[0.22em] text-slate-500">
                {group.label}
              </p>
            )}
            <ul className="space-y-0.5">
              {group.items.map((item) => (
                <li key={item.key}>
                  <button
                    type="button"
                    onClick={() => {
                      item.onClick();
                      if (inDrawer) onMobileClose();
                    }}
                    disabled={item.disabled}
                    title={isRail ? item.label + (item.title ? ` — ${item.title}` : "") : item.title}
                    aria-current={item.active ? "page" : undefined}
                    className={
                      "sidebar-item" +
                      (item.active ? " sidebar-item-active" : "") +
                      (isRail ? " justify-center px-0" : "")
                    }
                  >
                    <span className="relative flex h-5 w-5 shrink-0 items-center justify-center">
                      {item.icon}
                      {isRail && (item.badge ?? 0) > 0 && (
                        <span className="absolute -right-1.5 -top-1 h-2 w-2 rounded-full bg-cyan-300 ring-2 ring-[rgb(var(--chrome))]" />
                      )}
                    </span>
                    {!isRail && (
                      <>
                        <span className="flex-1 truncate text-left">{item.label}</span>
                        {item.busy && (
                          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-cyan-300" />
                        )}
                        {(item.badge ?? 0) > 0 && (
                          <span className="nav-badge">{item.badge}</span>
                        )}
                      </>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>

      {/* Footer */}
      <div className="shrink-0 space-y-1 border-t border-white/5 p-3">
        {footer?.(isRail)}
        {!inDrawer && (
          <button
            type="button"
            onClick={onToggleCollapsed}
            className={"sidebar-item" + (isRail ? " justify-center px-0" : "")}
            title={isRail ? "Expand sidebar (Ctrl+B)" : "Collapse sidebar (Ctrl+B)"}
            aria-label={isRail ? "Expand sidebar" : "Collapse sidebar"}
          >
            <CollapseIcon
              className={
                "h-4 w-4 shrink-0 transition-transform duration-200 " +
                (isRail ? "rotate-180" : "")
              }
            />
            {!isRail && <span className="flex-1 text-left">Collapse</span>}
            {!isRail && (
              <kbd className="rounded border border-white/10 px-1 font-sans text-[10px] text-slate-500">
                Ctrl B
              </kbd>
            )}
          </button>
        )}
      </div>
    </div>
  );

  return (
    <>
      {/* Desktop: in-flow rail that animates its width */}
      <aside
        className={
          "sidebar-shell relative z-30 hidden h-full shrink-0 md:block " +
          (collapsed ? "w-[68px]" : "w-60")
        }
      >
        {body(collapsed, false)}
      </aside>

      {/* Mobile: off-canvas drawer */}
      <div
        className={
          "fixed inset-0 z-50 md:hidden " + (mobileOpen ? "" : "pointer-events-none")
        }
        aria-hidden={!mobileOpen}
      >
        <div
          className={
            "absolute inset-0 bg-slate-950/70 transition-opacity duration-200 " +
            (mobileOpen ? "opacity-100" : "opacity-0")
          }
          onClick={onMobileClose}
        />
        <aside
          className={
            "sidebar-shell absolute inset-y-0 left-0 w-64 transition-transform duration-200 " +
            (mobileOpen ? "translate-x-0" : "-translate-x-full")
          }
        >
          {body(false, true)}
        </aside>
      </div>
    </>
  );
}

function CollapseIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16" />
      <path d="m15 10-2 2 2 2" />
    </svg>
  );
}

export function MenuIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M4 6h16M4 12h16M4 18h16" />
    </svg>
  );
}
