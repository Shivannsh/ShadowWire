import { useState, useEffect, useCallback } from "react";
import {
  isConnected,
  getAddress,
  requestAccess,
  signTransaction,
  getNetwork,
} from "@stellar/freighter-api";
import { config } from "@/lib/stellar";

export function useFreighter() {
  const [connected, setConnected] = useState(false);
  const [address, setAddress] = useState<string | null>(null);
  const [network, setNetwork] = useState<string | null>(null);
  const [installed, setInstalled] = useState(false);

  const checkConnection = useCallback(async () => {
    const { isConnected: extInstalled, error } = await isConnected();
    if (error || !extInstalled) {
      setInstalled(false);
      return;
    }
    setInstalled(true);

    const { address: addr, error: addressError } = await getAddress();
    if (addressError || !addr) return;

    const { network: net, error: networkError } = await getNetwork();
    if (networkError) return;

    setConnected(true);
    setAddress(addr);
    setNetwork(net);
  }, []);

  useEffect(() => {
    checkConnection();
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
      if (!connected) throw new Error("Wallet not connected");
      const { signedTxXdr, error } = await signTransaction(xdr, {
        networkPassphrase,
      });
      if (error) throw new Error(error.message);
      return signedTxXdr;
    },
    [connected]
  );

  const isCorrectNetwork =
    network === config.networkPassphrase ||
    (network === "TESTNET" && config.networkPassphrase.includes("Test"));

  return {
    connected,
    address,
    network,
    installed,
    isCorrectNetwork,
    connect,
    disconnect,
    sign,
    refresh: checkConnection,
  };
}
