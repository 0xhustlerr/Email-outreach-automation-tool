"use client";

import "@knocklabs/react/dist/index.css";
import { KnockFeedProvider, KnockProvider } from "@knocklabs/react";
import { Toaster } from "sonner";
import type { ReactNode } from "react";
import NotificationToasts from "@/components/knock/NotificationToasts";
import { useKnockIdentify } from "@/hooks/useKnockIdentify";

const publicKey = process.env.NEXT_PUBLIC_KNOCK_PUBLIC_API_KEY?.trim() ?? "";
const feedChannelId =
  process.env.NEXT_PUBLIC_KNOCK_FEED_CHANNEL_ID?.trim() ?? "";

export function isKnockClientConfigured(): boolean {
  return !!publicKey && !!feedChannelId;
}

type Props = {
  children: ReactNode;
  onReplyNotification?: (data: {
    rowId?: number;
    contact?: string;
    name?: string;
  }) => void;
};

/** Optional Knock real-time toasts. Main UI uses ReplyNotificationsBell. */
export default function KnockAppShell({
  children,
  onReplyNotification,
}: Props) {
  const enabled = isKnockClientConfigured();
  const { userId, ready } = useKnockIdentify(enabled);

  // The Toaster must render even when Knock is off, otherwise toast() calls
  // (queue confirmations, etc.) silently do nothing.
  if (!enabled || !ready || !userId) {
    return (
      <>
        <Toaster richColors closeButton position="bottom-right" />
        {children}
      </>
    );
  }

  return (
    <KnockProvider apiKey={publicKey} userId={userId}>
      <KnockFeedProvider feedId={feedChannelId}>
        <NotificationToasts onReplyNotification={onReplyNotification} />
        <Toaster richColors closeButton position="bottom-right" />
        {children}
      </KnockFeedProvider>
    </KnockProvider>
  );
}
