import type { SheetHistoryRow } from "@/lib/sheets";
import type { ReplyNotification } from "@/lib/reply-alerts";
import { replyThreadKey } from "@/lib/sheet-active";

export type CustomReplyTab = {
  id: string;
  name: string;
  /** Single emoji shown on the tab button. */
  icon: string;
  threadKeys: string[];
};

const STORAGE_KEY = "email-finder-custom-reply-tabs";

export const TAB_ICON_PRESETS = ["💬", "📧", "⭐", "🔥", "📁", "💼", "🎯", "✨", "📌", "🟢"];

export function loadCustomReplyTabs(): CustomReplyTab[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: CustomReplyTab[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const o = item as CustomReplyTab;
      if (typeof o.id !== "string" || typeof o.name !== "string") continue;
      const icon = typeof o.icon === "string" && o.icon.trim() ? o.icon.trim() : "💬";
      const threadKeys = Array.isArray(o.threadKeys)
        ? o.threadKeys.filter((k): k is string => typeof k === "string" && !!k)
        : [];
      out.push({ id: o.id, name: o.name.trim() || "Tab", icon, threadKeys });
    }
    return out;
  } catch {
    return [];
  }
}

export function saveCustomReplyTabs(tabs: CustomReplyTab[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(tabs));
}

export function threadKeyForRow(
  row: SheetHistoryRow & { _alert?: ReplyNotification },
  receivedInboxByRow?: Record<string, string>,
): string {
  return replyThreadKey(row, null, row._alert, receivedInboxByRow);
}

export function newTabId(): string {
  return `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}
