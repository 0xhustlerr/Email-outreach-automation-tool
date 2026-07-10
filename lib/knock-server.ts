import { Knock } from "@knocklabs/node";
import { primaryEmail } from "@/lib/sheet-active";
import type { SheetHistoryRow } from "@/lib/sheets";

function envOpt(name: string): string | null {
  const v = process.env[name]?.trim();
  return v ? v : null;
}

export function isKnockConfigured(): boolean {
  return !!(
    envOpt("KNOCK_SECRET_API_KEY") &&
    envOpt("KNOCK_RECIPIENT_USER_ID") &&
    envOpt("KNOCK_WORKFLOW_KEY")
  );
}

function knockClient(): Knock | null {
  const key = envOpt("KNOCK_SECRET_API_KEY");
  if (!key) return null;
  return new Knock({ apiKey: key });
}

export type ReplyKnockPayload = {
  rowId: number;
  name: string;
  contact: string;
  sender: string;
  site: string;
};

export async function notifyNewReply(
  row: SheetHistoryRow,
  rowId: number,
  preview?: string,
): Promise<void> {
  const client = knockClient();
  const recipient = envOpt("KNOCK_RECIPIENT_USER_ID");
  const workflow = envOpt("KNOCK_WORKFLOW_KEY") ?? "in-app";
  if (!client || !recipient) return;

  const contact = primaryEmail(row.contact);
  const name = (row.name ?? "").trim() || contact;
  const detail = (preview ?? "").trim().slice(0, 120);

  try {
    await client.workflows.trigger(workflow, {
      recipients: [recipient],
      actor: recipient,
      data: {
        message: detail
          ? `${name}: ${detail}`
          : `${name} replied (${contact})`,
        showToast: true,
        templateType: "reply",
        rowId,
        name,
        contact,
        sender: row.sender,
        site: row.site,
      },
    });
  } catch {
    // Best-effort.
  }
}
