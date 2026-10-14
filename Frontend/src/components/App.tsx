"use client";

import { NetworkProvider } from "@/lib/network";
import { NetworkStatus, Planner } from "./Planner";

export function App() {
  return (
    <NetworkProvider fallback={(s) => <NetworkStatus {...s} />}>
      <Planner />
    </NetworkProvider>
  );
}
