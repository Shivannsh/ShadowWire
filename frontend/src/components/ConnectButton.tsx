"use client";

import { useFreighter } from "@/hooks/useFreighter";
import { truncateAddress } from "@/lib/stellar";

export function ConnectButton() {
  const {
    connected,
    address,
    installed,
    isCorrectNetwork,
    connect,
    disconnect,
  } = useFreighter();

  if (connected && address) {
    return (
      <div className="flex items-center gap-3">
        <div className="hidden sm:flex flex-col items-end text-xs">
          <span className="font-mono text-slate-300">
            {truncateAddress(address, 6)}
          </span>
          {!isCorrectNetwork && (
            <span className="text-warn">Wrong network — switch to testnet</span>
          )}
        </div>
        <button
          onClick={disconnect}
          className="rounded-lg border border-surface-border bg-surface-raised px-4 py-2 text-sm text-slate-300 transition hover:border-red-500/50 hover:text-red-300"
        >
          Disconnect
        </button>
      </div>
    );
  }

  return (
    <button
      onClick={() => connect().catch((e: Error) => alert(e.message))}
      className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-surface shadow-glow transition hover:bg-accent-glow"
    >
      {installed ? "Connect Freighter" : "Install Freighter"}
    </button>
  );
}
