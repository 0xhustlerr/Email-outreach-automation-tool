import type { SheetHistoryRow } from "@/lib/sheets";

export function isYes(value: string | undefined): boolean {
  const v = (value ?? "").trim().toLowerCase();
  return v === "yes" || v === "y" || v === "true" || v === "1";
}

export function isActiveRow(row: SheetHistoryRow): boolean {
  return isYes(row.active) || isYes(row.replied);
}

export function primaryEmail(contact: string): string {
  const part = contact.split(/[/,;]/)[0]?.trim() ?? "";
  const match = part.match(/[^\s@]+@[^\s@]+\.[^\s@]+/i);
  return match ? match[0].toLowerCase() : part.toLowerCase();
}

export function rowKey(row: SheetHistoryRow): number | null {
  const n = row._row;
  return typeof n === "number" && n >= 2 ? n : null;
}

export { replyThreadKey, replyInboxContext, inboxContextLabel } from "@/lib/reply-inbox";
export type { ReplyInboxContext } from "@/lib/reply-inbox";
