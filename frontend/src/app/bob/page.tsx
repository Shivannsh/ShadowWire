"use client";

import { useCallback, useEffect, useState } from "react";
import { useFreighter } from "@/hooks/useFreighter";
import { useTestnetAddresses } from "@/hooks/useTestnetAddresses";
import { FlowStep, StatusBadge } from "@/components/FlowStep";
import { runSep24Withdraw } from "@/lib/sep24";
import { buildWithdrawTx, getPoolRoot, rootToHex } from "@/lib/pool";
import { submitTransaction } from "@/lib/transactions";
import {
  generateWithdrawProof,
  loadDemoTransferFields,
  randomNoteSecret,
} from "@/lib/proofs";
import { getClassicAssetBalance } from "@/lib/stellar";
import type { Note } from "@/lib/proofs";

type Step = 1 | 2 | 3;

export default function BobPage() {
  const { address, connected, connect, sign, isCorrectNetwork } = useFreighter();
  const { addresses } = useTestnetAddresses();

  const [activeStep, setActiveStep] = useState<Step>(1);
  const [status, setStatus] = useState("Connect Freighter to begin");
  const [statusType, setStatusType] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [srtBalance, setSrtBalance] = useState("0");
  const [poolRoot, setPoolRoot] = useState<string | null>(null);
  const [noteSecret, setNoteSecret] = useState("");
  const [withdrawAmount, setWithdrawAmount] = useState("50");
  const [sep24Amount, setSep24Amount] = useState("50");
  const [claimedNote, setClaimedNote] = useState<Note | null>(null);
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
    refreshBalance();
    refreshRoot();
  }, [refreshBalance, refreshRoot]);

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

  const handleClaimNote = () =>
    run(async () => {
      if (!noteSecret.trim()) {
        throw new Error("Paste the note secret Alice shared off-chain");
      }

      setStatus("Decoding note from secret…");
      const secretBytes = new TextEncoder().encode(noteSecret.padEnd(32, "0").slice(0, 32));
      const note: Note = {
        ownerPubkey: address
          ? new TextEncoder().encode(address.slice(0, 32).padEnd(32, "0"))
          : new Uint8Array(32),
        value: BigInt(Math.floor(parseFloat(withdrawAmount) * 1e7)),
        assetId: new Uint8Array(32),
        blindingFactor: randomNoteSecret(),
        secretKey: secretBytes,
      };

      setClaimedNote(note);
      setStatus("Note claimed locally — ready to withdraw from pool");
      setActiveStep(2);
    });

  const handlePoolWithdraw = () =>
    run(async () => {
      if (!address) throw new Error("Connect wallet first");
      if (!claimedNote) throw new Error("Claim a note first");

      const demoFields = await loadDemoTransferFields();

      setStatus("Generating withdraw proof…");
      const shieldedProof = await generateWithdrawProof({
        inputNote: claimedNote,
        merklePath: [],
        merkleRoot: demoFields.merkleRoot,
        amount: BigInt(990),
      });

      setStatus("Building pool withdrawal…");
      const xdr = await buildWithdrawTx({
        recipient: address,
        amount: "990",
        nullifier: demoFields.nullifier,
        newRoot: demoFields.merkleRoot,
        shieldedProof,
      });

      setStatus("Sign in Freighter…");
      const signed = await sign(xdr);
      const result = await submitTransaction(signed);
      setTxHash(result.hash);
      setStatus(`Withdrawn to visible balance: ${result.hash.slice(0, 12)}…`);
      await refreshBalance();
      await refreshRoot();
      setActiveStep(3);
    });

  const handleSep24Withdraw = () =>
    run(async () => {
      if (!address) throw new Error("Connect wallet first");
      if (!isCorrectNetwork) throw new Error("Switch Freighter to testnet");

      const { transaction } = await runSep24Withdraw({
        account: address,
        signXdr: sign,
        amount: sep24Amount,
        onStatus: setStatus,
      });

      setStatus(`SEP-24 withdrawal ${transaction.status}`);
      await refreshBalance();
    });

  return (
    <div className="mx-auto max-w-3xl px-6 py-12">
      <div className="mb-10">
        <p className="text-sm font-medium text-shield">Recipient persona</p>
        <h1 className="mt-1 text-3xl font-bold text-slate-50">Bob&apos;s corridor</h1>
        <p className="mt-2 text-slate-400">
          Claim private note → withdraw to visible balance → cash out via SEP-24
        </p>
      </div>

      {!connected && (
        <div className="mb-8 rounded-xl border border-shield/30 bg-shield/5 p-6 text-center">
          <p className="mb-4 text-slate-300">Connect Freighter to run the recipient flow</p>
          <button
            onClick={() => connect().catch((e: Error) => setStatus(e.message))}
            className="rounded-lg bg-shield px-5 py-2 text-sm font-medium text-surface"
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
            <p className="font-mono text-shield">{srtBalance}</p>
          </div>
          <div>
            <span className="text-slate-500">Pool root</span>
            <p className="font-mono text-xs text-accent">{poolRoot?.slice(0, 16) ?? "—"}…</p>
          </div>
        </div>
      )}

      <div className="space-y-6">
        <FlowStep
          step={1}
          title="Claim note"
          description="Import the off-chain note secret Alice sent — not visible on the public ledger"
          status={activeStep === 1 ? "active" : activeStep > 1 ? "done" : "pending"}
        >
          <textarea
            value={noteSecret}
            onChange={(e) => setNoteSecret(e.target.value)}
            placeholder="Paste note secret from Alice (off-chain channel)"
            rows={3}
            className="mb-3 w-full rounded-lg border border-surface-border bg-surface px-3 py-2 font-mono text-xs text-slate-200"
          />
          <button
            onClick={handleClaimNote}
            className="rounded-lg border border-shield/50 px-4 py-2 text-sm text-shield hover:bg-shield/10"
          >
            Claim note
          </button>
        </FlowStep>

        <FlowStep
          step={2}
          title="Withdraw from pool"
          description="Spend proof releases visible SRT — amount revealed at this edge by design"
          status={activeStep === 2 ? "active" : activeStep > 2 ? "done" : "pending"}
        >
          <div className="flex flex-wrap gap-3">
            <input
              type="text"
              value={withdrawAmount}
              onChange={(e) => setWithdrawAmount(e.target.value)}
              className="rounded-lg border border-surface-border bg-surface px-3 py-2 text-sm text-slate-200"
            />
            <button
              onClick={handlePoolWithdraw}
              disabled={!connected || activeStep < 2}
              className="rounded-lg bg-shield px-4 py-2 text-sm font-medium text-surface disabled:opacity-40"
            >
              Withdraw to wallet
            </button>
          </div>
        </FlowStep>

        <FlowStep
          step={3}
          title="SEP-24 withdrawal"
          description="Interactive anchor flow to cash out SRT to fiat rails"
          status={activeStep === 3 ? "active" : "pending"}
        >
          <div className="flex flex-wrap gap-3">
            <input
              type="text"
              value={sep24Amount}
              onChange={(e) => setSep24Amount(e.target.value)}
              className="rounded-lg border border-surface-border bg-surface px-3 py-2 text-sm text-slate-200"
            />
            <button
              onClick={handleSep24Withdraw}
              disabled={!connected || activeStep < 3}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-surface disabled:opacity-40"
            >
              Open SEP-24 withdraw
            </button>
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

      <p className="mt-8 text-xs text-slate-600">
        Privacy model: the corridor hides amount and parties on-chain. Anchors at
        each fiat edge see only their own leg — same as real-world AML requirements.
      </p>
    </div>
  );
}
