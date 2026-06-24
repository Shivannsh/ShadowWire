"use client";

import { useCallback, useEffect, useState } from "react";
import { useFreighter } from "@/hooks/useFreighter";
import { useTestnetAddresses } from "@/hooks/useTestnetAddresses";
import { FlowStep, StatusBadge } from "@/components/FlowStep";
import { runSep24Deposit } from "@/lib/sep24";
import { buildDepositTx, buildTransferTx, getPoolRoot, rootToHex } from "@/lib/pool";
import { submitTransaction } from "@/lib/transactions";
import {
  generateComplianceProof,
  generateShieldedTransferProof,
  loadDemoNoteForAlice,
  loadDemoTransferFields,
} from "@/lib/proofs";
import { fundTestnetAccount, getClassicAssetBalance } from "@/lib/stellar";
import type { Note } from "@/lib/proofs";

type Step = 1 | 2 | 3;

export default function AlicePage() {
  const { address, connected, connect, sign, isCorrectNetwork } = useFreighter();
  const { addresses } = useTestnetAddresses();

  const [activeStep, setActiveStep] = useState<Step>(1);
  const [status, setStatus] = useState("Connect Freighter to begin");
  const [statusType, setStatusType] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [srtBalance, setSrtBalance] = useState("0");
  const [poolRoot, setPoolRoot] = useState<string | null>(null);
  const [depositAmount, setDepositAmount] = useState("100");
  const [shieldAmount, setShieldAmount] = useState("100");
  const [bobPubkey, setBobPubkey] = useState(
    addresses?.accounts?.bob ?? ""
  );
  const [sendAmount, setSendAmount] = useState("50");
  const [note, setNote] = useState<Note | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);

  const assetCode = addresses?.anchor.asset_code ?? "SRT";
  const assetIssuer = addresses?.anchor.asset_issuer ?? "";

  const refreshBalance = useCallback(async () => {
    if (!address || !assetIssuer) return;
    const bal = await getClassicAssetBalance(address, assetCode, assetIssuer);
    setSrtBalance(bal);
  }, [address, assetCode, assetIssuer]);

  const refreshRoot = useCallback(async () => {
    try {
      const root = await getPoolRoot();
      setPoolRoot(rootToHex(root));
    } catch {
      setPoolRoot(null);
    }
  }, []);

  useEffect(() => {
    if (addresses?.accounts?.bob) {
      setBobPubkey(addresses.accounts.bob);
    }
  }, [addresses?.accounts?.bob]);

  const run = async (fn: () => Promise<void>) => {
    setStatusType("loading");
    try {
      await fn();
      setStatusType("success");
    } catch (err: unknown) {
      setStatusType("error");
      setStatus(err instanceof Error ? err.message : "Unknown error");
    }
  };

  const handleFund = () =>
    run(async () => {
      if (!address) throw new Error("Connect wallet first");
      setStatus("Funding account via Friendbot…");
      await fundTestnetAccount(address);
      await refreshBalance();
      setStatus("Account funded with testnet XLM");
    });

  const handleSep24Deposit = () =>
    run(async () => {
      if (!address) throw new Error("Connect wallet first");
      if (!isCorrectNetwork) throw new Error("Switch Freighter to testnet");

      const { transaction } = await runSep24Deposit({
        account: address,
        signXdr: sign,
        amount: depositAmount,
        onStatus: setStatus,
      });

      setStatus(`SEP-24 deposit ${transaction.status}`);
      await refreshBalance();
      setActiveStep(2);
    });

  const handleShield = () =>
    run(async () => {
      if (!address) throw new Error("Connect wallet first");

      setStatus("Generating compliance proof…");
      const merkleRoot = poolRoot
        ? Uint8Array.from(Buffer.from(poolRoot, "hex"))
        : new Uint8Array(32);

      const complianceProof = await generateComplianceProof({
        amount: BigInt(500),
        merkleRoot: new Uint8Array(32),
        corridorId: 1,
        minKycTier: 1,
        maxAmount: BigInt(1_000_000),
      });

      const demo = await loadDemoNoteForAlice(address);
      const newNote = demo.note;
      const commitment = demo.commitment;
      const newRoot = demo.merkleRoot;

      setStatus("Building pool deposit transaction…");
      const xdr = await buildDepositTx({
        depositor: address,
        amount: "500",
        commitment,
        newRoot,
        complianceProof,
      });

      setStatus("Sign in Freighter…");
      const signed = await sign(xdr);
      setStatus("Submitting to Soroban…");
      const result = await submitTransaction(signed);
      setNote(newNote);
      setTxHash(result.hash);
      setStatus(`Shielded deposit confirmed: ${result.hash.slice(0, 12)}…`);
      await refreshRoot();
      setActiveStep(3);
    });

  const handleSendPrivate = () =>
    run(async () => {
      if (!address || !note) throw new Error("Shield funds first");
      if (!bobPubkey) throw new Error("Enter Bob's pool public key");

      const demoFields = await loadDemoTransferFields();

      setStatus("Generating shielded transfer proof…");
      const shieldedProof = await generateShieldedTransferProof({
        inputNote: note,
        merklePath: [],
        merkleRoot: demoFields.merkleRoot,
        recipientPubkey: new TextEncoder().encode(bobPubkey.slice(0, 32).padEnd(32, "0")),
        outputValue: BigInt(990),
      });

      setStatus("Building private transfer…");
      const xdr = await buildTransferTx({
        sender: address,
        nullifier: demoFields.nullifier,
        newCommitment: demoFields.newCommitment,
        newRoot: demoFields.merkleRoot,
        shieldedProof,
      });

      setStatus("Sign in Freighter…");
      const signed = await sign(xdr);
      const result = await submitTransaction(signed);
      setTxHash(result.hash);
      setStatus(`Private transfer submitted — amount hidden on-chain: ${result.hash.slice(0, 12)}…`);
      await refreshRoot();
    });

  return (
    <div className="mx-auto max-w-3xl px-6 py-12">
      <div className="mb-10">
        <p className="text-sm font-medium text-accent">Sender persona</p>
        <h1 className="mt-1 text-3xl font-bold text-slate-50">Alice&apos;s corridor</h1>
        <p className="mt-2 text-slate-400">
          Deposit fiat via SEP-24 → shield into the pool → send privately to Bob
        </p>
      </div>

      {!connected && (
        <div className="mb-8 rounded-xl border border-accent/30 bg-accent/5 p-6 text-center">
          <p className="mb-4 text-slate-300">Connect Freighter to run the sender flow</p>
          <button
            onClick={() => connect().catch((e: Error) => setStatus(e.message))}
            className="rounded-lg bg-accent px-5 py-2 text-sm font-medium text-surface"
          >
            Connect wallet
          </button>
        </div>
      )}

      {connected && address && (
        <div className="mb-8 grid gap-4 rounded-xl border border-surface-border bg-surface-raised/40 p-4 text-sm sm:grid-cols-3">
          <div>
            <span className="text-slate-500">Account</span>
            <p className="font-mono text-slate-200">{address.slice(0, 12)}…</p>
          </div>
          <div>
            <span className="text-slate-500">{assetCode} balance</span>
            <p className="font-mono text-accent">{srtBalance}</p>
          </div>
          <div>
            <span className="text-slate-500">Pool root</span>
            <p className="font-mono text-xs text-shield">{poolRoot?.slice(0, 16) ?? "—"}…</p>
          </div>
        </div>
      )}

      <div className="space-y-6">
        <FlowStep
          step={1}
          title="SEP-24 deposit"
          description="Interactive anchor flow at testanchor.stellar.org — deposit fiat, receive SRT"
          status={activeStep === 1 ? "active" : activeStep > 1 ? "done" : "pending"}
        >
          <div className="flex flex-wrap gap-3">
            <input
              type="text"
              value={depositAmount}
              onChange={(e) => setDepositAmount(e.target.value)}
              placeholder="Amount"
              className="rounded-lg border border-surface-border bg-surface px-3 py-2 text-sm text-slate-200"
            />
            <button
              onClick={handleFund}
              disabled={!connected}
              className="rounded-lg border border-surface-border px-4 py-2 text-sm text-slate-300 hover:border-accent/50 disabled:opacity-40"
            >
              Fund XLM
            </button>
            <button
              onClick={handleSep24Deposit}
              disabled={!connected}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-surface disabled:opacity-40"
            >
              Open SEP-24 deposit
            </button>
          </div>
        </FlowStep>

        <FlowStep
          step={2}
          title="Shield funds"
          description="Compliance proof + pool deposit — convert visible SRT into a private note"
          status={activeStep === 2 ? "active" : activeStep > 2 ? "done" : "pending"}
        >
          <div className="flex flex-wrap gap-3">
            <input
              type="text"
              value={shieldAmount}
              onChange={(e) => setShieldAmount(e.target.value)}
              className="rounded-lg border border-surface-border bg-surface px-3 py-2 text-sm text-slate-200"
            />
            <button
              onClick={handleShield}
              disabled={!connected || activeStep < 2}
              className="rounded-lg bg-shield px-4 py-2 text-sm font-medium text-surface disabled:opacity-40"
            >
              Shield into pool
            </button>
          </div>
        </FlowStep>

        <FlowStep
          step={3}
          title="Send privately"
          description="Shielded transfer — only nullifier + commitment visible on-chain"
          status={activeStep === 3 ? "active" : "pending"}
        >
          <div className="space-y-3">
            <input
              type="text"
              value={bobPubkey}
              onChange={(e) => setBobPubkey(e.target.value)}
              placeholder="Bob's Stellar public key"
              className="w-full rounded-lg border border-surface-border bg-surface px-3 py-2 text-sm text-slate-200"
            />
            <div className="flex flex-wrap gap-3">
              <input
                type="text"
                value={sendAmount}
                onChange={(e) => setSendAmount(e.target.value)}
                placeholder="Amount"
                className="rounded-lg border border-surface-border bg-surface px-3 py-2 text-sm text-slate-200"
              />
              <button
                onClick={handleSendPrivate}
                disabled={!connected || activeStep < 3}
                className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-surface disabled:opacity-40"
              >
                Send privately
              </button>
            </div>
          </div>
        </FlowStep>
      </div>

      <div className="mt-8 space-y-2">
        <StatusBadge status={statusType} message={status} />
        {txHash && (
          <p className="font-mono text-xs text-slate-500">
            Last tx:{" "}
            <a
              href={`https://stellar.expert/explorer/testnet/tx/${txHash}`}
              target="_blank"
              rel="noreferrer"
              className="text-accent hover:underline"
            >
              {txHash}
            </a>
          </p>
        )}
      </div>
    </div>
  );
}
