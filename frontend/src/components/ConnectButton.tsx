"use client";

import { useFreighter } from "@/hooks/useFreighter";
import { truncateAddress } from "@/lib/stellar";
import { Button } from "./ui/primitives";
import { WalletIcon } from "./ui/icons";

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
      <div className="flex items-center gap-2.5">
        <div className="hidden flex-col items-end leading-tight sm:flex">
          <span className="num text-xs text-fg-soft">
            {truncateAddress(address, 6)}
          </span>
          {isCorrectNetwork ? (
            <span className="flex items-center gap-1 text-[10px] font-medium text-shield">
              <span className="h-1.5 w-1.5 rounded-full bg-shield animate-pulse-ring" />
              Testnet
            </span>
          ) : (
            <span className="text-[10px] font-medium text-warn">
              Switch to testnet
            </span>
          )}
        </div>
        <Button variant="danger-ghost" onClick={disconnect} className="px-3 py-2">
          Disconnect
        </Button>
      </div>
    );
  }

  return (
    <Button
      onClick={() => connect().catch((e: Error) => alert(e.message))}
      icon={<WalletIcon size={16} />}
      className="px-3.5 py-2"
    >
      {installed ? "Connect" : "Install Freighter"}
    </Button>
  );
}
