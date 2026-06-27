"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import {
  isConnected,
  getAddress,
  requestAccess,
  signTransaction,
  getNetwork,
} from "@stellar/freighter-api";
import type { Networks } from "@stellar/stellar-sdk";
import { config } from "@/lib/stellar";

interface FreighterContextValue {
  connected: boolean;
  address: string | null;
  network: string | null;
  installed: boolean;
  isCorrectNetwork: boolean;
  connect: () => Promise<string>;
  disconnect: () => void;
  sign: (xdr: string, networkPassphrase?: Networks) => Promise<string>;
  refresh: () => Promise<void>;
}

const FreighterContext = createContext<FreighterContextValue | null>(null);

export function FreighterProvider({ children }: { children: ReactNode }) {
  const [connected, setConnected] = useState(false);
  const [address, setAddress] = useState<string | null>(null);
  const [network, setNetwork] = useState<string | null>(null);
  const [installed, setInstalled] = useState(false);

  const checkConnection = useCallback(async () => {
    const { isConnected: extInstalled, error } = await isConnected();
    if (error || !extInstalled) {
      setInstalled(false);
      setConnected(false);
      setAddress(null);
      setNetwork(null);
      return;
    }
    setInstalled(true);

    const { address: addr, error: addressError } = await getAddress();
    if (addressError || !addr) {
      setConnected(false);
      setAddress(null);
      setNetwork(null);
      return;
    }

    const { network: net, error: networkError } = await getNetwork();
    if (networkError) {
      setConnected(false);
      return;
    }

    setConnected(true);
    setAddress(addr);
    setNetwork(net);
  }, []);

  useEffect(() => {
    checkConnection();
    // Re-sync when user returns from Freighter popup or switches tabs
    const onFocus = () => { checkConnection(); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [checkConnection]);

  const connect = useCallback(async () => {
    const { isConnected: extInstalled, error } = await isConnected();
    if (error || !extInstalled) {
      throw new Error("Freighter extension not installed");
    }

    const { address: addr, error: accessError } = await requestAccess();
    if (accessError) throw new Error(accessError.message);

    const { network: net, error: networkError } = await getNetwork();
    if (networkError) throw new Error(networkError.message);

    setInstalled(true);
    setConnected(true);
    setAddress(addr);
    setNetwork(net);
    return addr;
  }, []);

  const disconnect = useCallback(() => {
    setConnected(false);
    setAddress(null);
    setNetwork(null);
  }, []);

  const sign = useCallback(
    async (xdr: string, networkPassphrase = config.networkPassphrase) => {
      const { signedTxXdr, error } = await signTransaction(xdr, {
        networkPassphrase,
      });
      if (error) throw new Error(error.message);
      return signedTxXdr;
    },
    []
  );

  const isCorrectNetwork =
    network === config.networkPassphrase ||
    (network === "TESTNET" && config.networkPassphrase.includes("Test"));

  return (
    <FreighterContext.Provider
      value={{
        connected,
        address,
        network,
        installed,
        isCorrectNetwork,
        connect,
        disconnect,
        sign,
        refresh: checkConnection,
      }}
    >
      {children}
    </FreighterContext.Provider>
  );
}

export function useFreighter(): FreighterContextValue {
  const ctx = useContext(FreighterContext);
  if (!ctx) {
    throw new Error("useFreighter must be used within FreighterProvider");
  }
  return ctx;
}
