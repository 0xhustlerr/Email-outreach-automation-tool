"use client";

import { useKnockFeed } from "@knocklabs/react";
import { useCallback, useEffect } from "react";
import { toast } from "sonner";
import ReplyToast from "@/components/knock/ReplyToast";

type Props = {
  onReplyNotification?: (data: {
    rowId?: number;
    contact?: string;
    name?: string;
  }) => void;
};

type IncomingNotification = {
  id: string;
  data?: Record<string, unknown> | null;
  blocks?: { rendered?: string }[];
};

export default function NotificationToasts({ onReplyNotification }: Props) {
  const { feedClient } = useKnockFeed();

  const onNotificationsReceived = useCallback(
    (payload: unknown) => {
      const items = (payload as { items?: IncomingNotification[] })?.items;
      if (!items?.length) return;

      items.forEach((notification) => {
        const data = notification.data;
        if (data?.showToast === false) return;

        const message =
          (typeof data?.message === "string" ? data.message : null) ??
          notification.blocks?.[0]?.rendered ??
          "New reply received";

        const rowId =
          typeof data?.rowId === "number" ? data.rowId : undefined;
        const contact =
          typeof data?.contact === "string" ? data.contact : undefined;
        const name = typeof data?.name === "string" ? data.name : undefined;

        toast.custom(
          () => (
            <ReplyToast
              title="New reply"
              description={message}
              onOpen={() => {
                void feedClient.markAsSeen(
                  notification as Parameters<typeof feedClient.markAsSeen>[0],
                );
                onReplyNotification?.({ rowId, contact, name });
              }}
            />
          ),
          {
            duration: 12_000,
            position: "bottom-right",
            onDismiss: () =>
              void feedClient.markAsSeen(
                notification as Parameters<typeof feedClient.markAsSeen>[0],
              ),
            onAutoClose: () =>
              void feedClient.markAsSeen(
                notification as Parameters<typeof feedClient.markAsSeen>[0],
              ),
          },
        );
      });
    },
    [feedClient, onReplyNotification],
  );

  useEffect(() => {
    feedClient.on("items.received.realtime", onNotificationsReceived);
    return () =>
      feedClient.off("items.received.realtime", onNotificationsReceived);
  }, [feedClient, onNotificationsReceived]);

  return null;
}
