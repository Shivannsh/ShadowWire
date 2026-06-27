"use client";

import { ReactNode } from "react";
import { FreighterProvider } from "@/context/FreighterContext";

export function Providers({ children }: { children: ReactNode }) {
  return <FreighterProvider>{children}</FreighterProvider>;
}
