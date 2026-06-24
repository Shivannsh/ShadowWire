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
  proveDeposit,
  generateShieldedTransferProof,
  encodeNoteReceipt,
} from "@/lib/proofs";
import type { NoteReceipt } from "@/lib/proofs";
import {
  addressToField,
  generateNoteRandomness,
  saveNote,
  getSpendableNotes,
  markNoteSpent,
  encodeNoteReceipt as walletEncodeReceipt,
} from "@/lib/noteWallet";
import type { ShieldedNote } from "@/lib/noteWallet";
import { fundTestnetAccount, getClassicAssetBalance } from "@/lib/stellar";

type Step = 1 | 2 | 3;

export default function AlicePage() {
  const { address, connected, connect, sign, isCorrectNetwork } = useFreighter();
  const { addresses } = useTestnetAddresses();

  const [activeStep, setActiveStep]   = useState<Step>(1);
  const [status, setStatus]           = useState("Connect Freighter to begin");
  const [statusType, setStatusType]   = useState<"idle" | "loading" | "success" | "error">("idle");
  const [srtBalance, setSrtBalance]   = useState("0");
  const [poolRoot, setPoolRoot]       = useState<string | null>(null);
  const [depositAmount, setDepositAmount] = useState("100");
  const [bobRecipientField, setBobRecipientField] = useState("");
  const [sendAmount, setSendAmount]   = useState("90");
  const [txHash, setTxHash]           = useState<string | null>(null);
  const [noteReceipt, setNoteReceipt] = useState<string | null>(null);
  const [myNotes, setMyNotes]         = useState<ShieldedNote[]>([]);
  const [activeNote, setActiveNote]   = useState<ShieldedNote | null>(null);

  const poolAddress = addresses?.contracts?.shielded_pool ?? "";
  const assetCode   = addresses?.anchor?.asset_code   ?? "SRT";
  const assetIssuer = addresses?.anchor?.asset_issuer ?? "";

  const refreshBalance = useCallback(async () => {
    if (!address || !assetIssuer) return;
    const bal = await getClassicAssetBalance(address, assetCode, assetIssuer);
    setSrtBalance(bal);
  }, [address, assetCode, assetIssuer]);

  const refreshRoot = useCallback(async () => {
    try { setPoolRoot(rootToHex(await getPoolRoot())); } catch { setPoolRoot(null); }
  }, []);

  const refreshNotes = useCallback(() => {
    if (!poolAddress || !address) return;
    const notes = getSpendableNotes(poolAddress);
    setMyNotes(notes);
    if (notes.length > 0 && !activeNote) setActiveNote(notes[0]);
  }, [poolAddress, address, activeNote]);

  useEffect(() => {
    if (addresses?.accounts?.bob) setBobRecipientField(addresses.accounts.bob);
  }, [addresses?.accounts?.bob]);

  useEffect(() => { refreshBalance(); refreshRoot(); refreshNotes(); },
    [refreshBalance, refreshRoot, refreshNotes]);

  const run = async (fn: () => Promise<void>) => {
    setStatusType("loading");
    try { await fn(); setStatusType("success"); }
    catch (err: unknown) {
      setStatusType("error");
      setStatus(err instanceof Error ? err.message : "Unknown error");
    }
  };

  const handleFund = () =>
    run(async () => {
      if (!address) throw new Error("Connect wallet first");
      setStatus("Funding account via Friendbot...");
      await fundTestnetAccount(address);
      await refreshBalance();
      setStatus("Account funded with testnet XLM");
    });

  const handleSep24Deposit = () =>
    run(async () => {
      if (!address) throw new Error("Connect wallet first");
      if (!isCorrectNetwork) throw new Error("Switch Freighter to testnet");
      const { transaction } = await runSep24Deposit({
        account: address, signXdr: sign, amount: depositAmount, onStatus: setStatus,
      });
      setStatus(`SEP-24 deposit ${transaction.status}`);
      await refreshBalance();
      setActiveStep(2);
    });

  const handleShield = () =>
    run(async () => {
      if (!address) throw new Error("Connect wallet first");

      // --- Generate fresh note randomness for this deposit ---
      const ownerField              = await addressToField(address);
      const { blinding, secretKey } = generateNoteRandomness();
      const value                   = depositAmount;

      setStatus("Computing note commitment and new pool root (hash_util)...");
      const { commitment, newRoot } = await proveDeposit({
        ownerField, value, assetId: "3", blinding, secretKey,
      });

      setStatus("Generating compliance proof for deposit amount...");
      const complianceProof = await generateComplianceProof({ amount: BigInt(value) });

      setStatus("Building shielded deposit transaction...");
      const xdr = await buildDepositTx({
        depositor:            address,
        amount:               value,
        commitment,
        newRoot,
        complianceNullifier:  complianceProof.complianceNullifier,
        complianceProof,
      });

      setStatus("Sign in Freighter...");
      const signed  = await sign(xdr);
      setStatus("Submitting to Soroban...");
      const result  = await submitTransaction(signed);
      setTxHash(result.hash);

      // Save the note to localStorage so Alice can spend it later
      const commitmentHex = "0x" + Buffer.from(commitment).toString("hex");
      const note: ShieldedNote = {
        owner:      ownerField,
        value,
        assetId:    "3",
        blinding,
        secretKey,
        commitment: commitmentHex,
        depositedAt: Date.now(),
      };
      if (poolAddress) saveNote(poolAddress, note);
      setActiveNote(note);
      refreshNotes();
      await refreshRoot();

      setStatus(`Shielded deposit confirmed. Amount hidden on-chain: ${result.hash.slice(0, 12)}...`);
      setActiveStep(3);
    });

  const handleSendPrivate = () =>
    run(async () => {
      if (!address || !activeNote) throw new Error("Shield funds first");
      if (!bobRecipientField.trim()) throw new Error("Enter Bob's recipient field");

      setStatus("Loading real pool tree + computing Merkle path (tree_builder)...");

      // Derive Bob's ownerField from his Stellar address if it looks like one
      let recipientField = bobRecipientField;
      if (bobRecipientField.startsWith("G") && bobRecipientField.length === 56) {
        recipientField = await addressToField(bobRecipientField);
      }

      setStatus("Generating shielded transfer proof (real Merkle path, real Groth16)...");
      const shieldedProof = await generateShieldedTransferProof({
        ownerField:   activeNote.owner,
        value:        activeNote.value,
        assetId:      activeNote.assetId,
        blinding:     activeNote.blinding,
        secretKey:    activeNote.secretKey,
        recipient:    recipientField,
        outputValue:  sendAmount,
        fee:          "0",
      });

      setStatus("Building private transfer transaction...");
      const xdr = await buildTransferTx({
        sender:          address,
        nullifier:       shieldedProof.spendNullifier,
        newCommitment1:  shieldedProof.newCommitment1,
        newCommitment2:  shieldedProof.newCommitment2,
        newRoot:         shieldedProof.newRoot,
        shieldedProof,
      });

      setStatus("Sign in Freighter...");
      const signed = await sign(xdr);
      const result = await submitTransaction(signed);
      setTxHash(result.hash);

      // Mark the spent note
      if (poolAddress) markNoteSpent(poolAddress, activeNote.commitment);
      refreshNotes();
      setActiveNote(null);
      await refreshRoot();

      // Build note receipt for Bob
      if (shieldedProof.bobNote) {
        const receipt = walletEncodeReceipt(shieldedProof.bobNote as NoteReceipt);
        setNoteReceipt(receipt);
        setStatus(
          `Transfer confirmed. Copy the receipt below and send to Bob: ${result.hash.slice(0, 12)}...`
        );
      } else {
        setStatus(`Transfer confirmed: ${result.hash.slice(0, 12)}...`);
      }
    });

  return (
    <div className="mx-auto max-w-3xl px-6 py-12">
      <div className="mb-10">
        <p className="text-sm font-medium text-accent">Sender persona</p>
        <h1 className="mt-1 text-3xl font-bold text-slate-50">Alice&apos;s corridor</h1>
        <p className="mt-2 text-slate-400">
          Deposit fiat via SEP-24 &rarr; shield with fresh note randomness &rarr; send privately to Bob
        </p>
      </div>

      {!connected && (
        <div className="mb-8 rounded-xl border border-accent/30 bg-accent/5 p-6 text-center">
          <p className="mb-4 text-slate-300">Connect Freighter to run the sender flow</p>
          <button
            onClick={() => connect().catch((e: Error) => setStatus(e.message))}
            className="rounded-lg bg-accent px-5 py-2 text-sm font-medium text-surface"
          >Connect wallet</button>
        </div>
      )}

      {connected && address && (
        <div className="mb-8 grid gap-4 rounded-xl border border-surface-border bg-surface-raised/40 p-4 text-sm sm:grid-cols-3">
          <div>
            <span className="text-slate-500">Account</span>
            <p className="font-mono text-slate-200">{address.slice(0, 12)}...</p>
          </div>
          <div>
            <span className="text-slate-500">{assetCode} balance</span>
            <p className="font-mono text-accent">{srtBalance}</p>
          </div>
          <div>
            <span className="text-slate-500">Pool root</span>
            <p className="font-mono text-xs text-shield">{poolRoot?.slice(0, 16) ?? "---"}...</p>
          </div>
        </div>
      )}

      {myNotes.length > 0 && (
        <div className="mb-6 rounded-xl border border-accent/20 bg-accent/5 p-4 text-sm">
          <p className="text-xs font-medium text-accent mb-2">Spendable notes in wallet</p>
          {myNotes.map((n, i) => (
            <div
              key={n.commitment}
              onClick={() => { setActiveNote(n); setSendAmount(n.value); setActiveStep(3); }}
              className={`cursor-pointer rounded-lg px-3 py-2 mb-1 ${activeNote?.commitment === n.commitment ? "bg-accent/20 border border-accent/50" : "hover:bg-accent/10"}`}
            >
              <span className="text-slate-300">Note {i + 1}</span>
              <span className="ml-3 font-mono text-accent">{n.value} SRT</span>
              <span className="ml-3 text-xs text-slate-500">{n.commitment.slice(0, 14)}...</span>
            </div>
          ))}
        </div>
      )}

      <div className="space-y-6">
        <FlowStep step={1} title="SEP-24 deposit"
          description="Interactive anchor -- deposit fiat, receive SRT on Stellar"
          status={activeStep === 1 ? "active" : activeStep > 1 ? "done" : "pending"}>
          <div className="flex flex-wrap gap-3">
            <input type="text" value={depositAmount}
              onChange={(e) => setDepositAmount(e.target.value)}
              placeholder="Amount"
              className="rounded-lg border border-surface-border bg-surface px-3 py-2 text-sm text-slate-200" />
            <button onClick={handleFund} disabled={!connected}
              className="rounded-lg border border-surface-border px-4 py-2 text-sm text-slate-300 hover:border-accent/50 disabled:opacity-40">
              Fund XLM
            </button>
            <button onClick={handleSep24Deposit} disabled={!connected}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-surface disabled:opacity-40">
              Open SEP-24 deposit
            </button>
          </div>
        </FlowStep>

        <FlowStep step={2} title="Shield funds"
          description="Fresh note randomness -- compliance proof for the exact deposited amount"
          status={activeStep === 2 ? "active" : activeStep > 2 ? "done" : "pending"}>
          <div className="flex flex-wrap gap-3 items-center">
            <span className="text-sm text-slate-400">Shielding {depositAmount} SRT</span>
            <span className="text-xs text-slate-500">(from SEP-24 deposit)</span>
            <button onClick={handleShield} disabled={!connected || activeStep < 2}
              className="rounded-lg bg-shield px-4 py-2 text-sm font-medium text-surface disabled:opacity-40">
              Shield into pool
            </button>
          </div>
        </FlowStep>

        <FlowStep step={3} title="Send privately"
          description="Real Merkle path from chain -- proof generated against live pool state"
          status={activeStep === 3 ? "active" : "pending"}>
          <div className="space-y-3">
            <input type="text" value={bobRecipientField}
              onChange={(e) => setBobRecipientField(e.target.value)}
              placeholder="Bob's Stellar address or pool Field ID"
              className="w-full rounded-lg border border-surface-border bg-surface px-3 py-2 text-sm text-slate-200" />
            <div className="flex flex-wrap gap-3">
              <input type="text" value={sendAmount}
                onChange={(e) => setSendAmount(e.target.value)}
                placeholder="Amount to send"
                className="rounded-lg border border-surface-border bg-surface px-3 py-2 text-sm text-slate-200" />
              <button onClick={handleSendPrivate}
                disabled={!connected || activeStep < 3 || !activeNote}
                className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-surface disabled:opacity-40">
                Send privately
              </button>
            </div>
          </div>

          {noteReceipt && (
            <div className="mt-4 rounded-lg border border-shield/40 bg-shield/5 p-4">
              <p className="mb-2 text-xs font-medium text-shield">
                Note receipt -- send this to Bob off-chain (encrypted message, Signal, etc.)
              </p>
              <textarea readOnly value={noteReceipt} rows={3}
                className="w-full rounded-lg border border-surface-border bg-surface px-3 py-2 font-mono text-xs text-slate-300 select-all"
                onClick={(e) => (e.target as HTMLTextAreaElement).select()} />
              <p className="mt-1 text-xs text-slate-500">
                Click to select all, then copy. Bob pastes this to claim his funds.
              </p>
            </div>
          )}
        </FlowStep>
      </div>

      <div className="mt-8 space-y-2">
        <StatusBadge status={statusType} message={status} />
        {txHash && (
          <p className="font-mono text-xs text-slate-500">
            Last tx:{" "}
            <a href={`https://stellar.expert/explorer/testnet/tx/${txHash}`}
              target="_blank" rel="noreferrer" className="text-accent hover:underline">
              {txHash}
            </a>
          </p>
        )}
      </div>
    </div>
  );
}
