"use client";

import { useCallback, useEffect, useState } from "react";
import {
  loadCustomReplyTabs,
  newTabId,
  saveCustomReplyTabs,
  type CustomReplyTab,
} from "@/lib/reply-custom-tabs";

export function useReplyCustomTabs() {
  const [tabs, setTabs] = useState<CustomReplyTab[]>([]);

  useEffect(() => {
    setTabs(loadCustomReplyTabs());
  }, []);

  const persist = useCallback((next: CustomReplyTab[]) => {
    setTabs(next);
    saveCustomReplyTabs(next);
  }, []);

  const createTab = useCallback(
    (name: string, icon: string) => {
      const tab: CustomReplyTab = {
        id: newTabId(),
        name: name.trim() || "Custom",
        icon: icon.trim() || "💬",
        threadKeys: [],
      };
      persist([...tabs, tab]);
      return tab.id;
    },
    [tabs, persist],
  );

  const addThreadToTab = useCallback(
    (tabId: string, threadKey: string) => {
      persist(
        tabs.map((t) => {
          if (t.id !== tabId) return t;
          if (t.threadKeys.includes(threadKey)) return t;
          return { ...t, threadKeys: [...t.threadKeys, threadKey] };
        }),
      );
    },
    [tabs, persist],
  );

  const removeTab = useCallback(
    (tabId: string) => {
      persist(tabs.filter((t) => t.id !== tabId));
    },
    [tabs, persist],
  );

  const updateTab = useCallback(
    (tabId: string, patch: { name?: string; icon?: string }) => {
      persist(
        tabs.map((t) =>
          t.id === tabId
            ? {
                ...t,
                name: patch.name?.trim() ? patch.name.trim() : t.name,
                icon: patch.icon?.trim() ? patch.icon.trim() : t.icon,
              }
            : t,
        ),
      );
    },
    [tabs, persist],
  );

  return {
    customTabs: tabs,
    createTab,
    addThreadToTab,
    removeTab,
    updateTab,
  };
}
