"use client";

import { createContext, useContext, type ReactNode } from "react";

const KnockShellContext = createContext<{ bell: ReactNode | null }>({
  bell: null,
});

export function KnockShellProvider({
  bell,
  children,
}: {
  bell: ReactNode;
  children: ReactNode;
}) {
  return (
    <KnockShellContext.Provider value={{ bell }}>
      {children}
    </KnockShellContext.Provider>
  );
}

export function useKnockBell(): ReactNode | null {
  return useContext(KnockShellContext).bell;
}
