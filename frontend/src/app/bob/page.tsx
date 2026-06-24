"use client";

import { useCallback, useEffect, useState } from "react";
import { useFreighter } from "@/hooks/useFreighter";
import { useTestnetAddresses } from "@/hooks/useTestnetAddresses";
import { FlowStep, StatusBadge } from "@/components/FlowStep";
import { buildWithdrawTx, getPoolRoot, rootToHex } from "@/lib/pool";
import { submitTransaction } from "@/lib/transactions";
import { generateWithdrawProof, decodeNoteReceipt } from "@/lib/proofs";
import type { NoteReceipt } from "@/lib/proofs";
import {
  addressToField,
  saveNote,
  getSpendableNotes,
  markNoteSpent,
} from "@/lib/noteWallet";
import type { ShieldedNote } from "@/lib/noteWallet";
import { getClassicAssetBalance } from "@/lib/stellar";
import { runSep24Withdraw } from "@/lib/sep24";

export default function BobPage() {
  const { address, connected, connect, sign, isCorrectNetwork } = useFreighter();
  const { addresses } = useTestnetAddresses();

  const [activeStep, setActiveStep]   = useState<1 | 2 | 3>(1);
  const [status, setStatus]           = useState("Connect Freighter to begin");
  const [statusType, setStatusType]   = useState<"idle" | "loading" | "success" | "error">("idle");
  const [noteInput, setNoteInput]     = useState("");
  const [activeNote, setActiveNote]   = useState<ShieldedNote | null>(null);
  const [myNotes, setMyNotes]         = useState<ShieldedNote[]>([]);
  const [srtBalance, setSrtBalance]   = useState("0");
  const [poolRoot, setPoolRoot]       = useState<string | null>(null);
  const [txHash, setTxHash]           = useState<string | null>(null);
  const [withdrawAddr, setWithdrawAddr] = useState("");

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

  useEffect(() => { if (address) setWithdrawAddr(address); }, [address]);
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

  // Step 1: Decode the note receipt Alice sent
  const handleClaimNote = () =>
    run(async () => {
      if (!noteInput.trim()) throw new Error("Paste the note receipt from Alice");

      const receipt: NoteReceipt = decodeNoteReceipt(noteInput.trim());

      // Override owner with our own Field (the note receipt has Alice's computed field for Bob)
      // If we need to re-derive: addressToField from our own address
      const ourField = address ? await addressToField(address) : receipt.owner;

      const note: ShieldedNote = {
        owner:      ourField,
        value:      receipt.value,
        assetId:    receipt.assetId,
        blinding:   receipt.blinding,
        secretKey:  receipt.secretKey,
        commitment: receipt.commitment,
      };

      if (poolAddress) saveNote(poolAddress, note);
      setActiveNote(note);
      refreshNotes();

      setStatus(
        `Note claimed: ${receipt.value} ${assetCode} ` +
        `(commitment ${receipt.commitment.slice(0, 12)}...)`
      );
      setActiveStep(2);
    });

  // Step 2: Withdraw (shielded proof + pool call)
  const handlePoolWithdraw = () =>
    run(async () => {
      if (!address) throw new Error("Connect wallet");
      if (!activeNote) throw new Error("Claim your note first");

      // The owner field of the note we're spending must match who we sign as
      const ourField = await addressToField(address);

      setStatus("Loading pool tree + building real Merkle path (tree_builder)...");
      const proof = await generateWithdrawProof({
        ownerField: ourField,
        value:      activeNote.value,
        assetId:    activeNote.assetId,
        blinding:   activeNote.blinding,
        secretKey:  activeNote.secretKey,
        recipient:  ourField,
      });

      setStatus("Building withdraw transaction...");
      const xdr = await buildWithdrawTx({
        recipient:  address,
        amount:     activeNote.value,
        nullifier:  proof.spendNullifier,
        newRoot:    proof.newRoot,
        shieldedProof: proof,
      });

      setStatus("Sign in Freighter...");
      const signed = await sign(xdr);
      const result = await submitTransaction(signed);
      setTxHash(result.hash);

      if (poolAddress) markNoteSpent(poolAddress, activeNote.commitment);
      refreshNotes();
      setActiveNote(null);
      await refreshBalance();
      await refreshRoot();

      setStatus(`Withdraw confirmed: ${result.hash.slice(0, 12)}...`);
      setActiveStep(3);
    });

  // Step 3: SEP-24 off-ramp
  const handleSep24Withdraw = () =>
    run(async () => {
      if (!address) throw new Error("Connect wallet");
      if (!isCorrectNetwork) throw new Error("Switch Freighter to testnet");
      await runSep24Withdraw({
        account: address, signXdr: sign,
        amount: activeNote?.value ?? "100",
        onStatus: setStatus,
      });
      await refreshBalance();
      setStatus("SEP-24 off-ramp withdrawal initiated");
    });

  return (
    <div className="mx-auto max-w-3xl px-6 py-12">
      <div className="mb-10">
        <p className="text-sm font-medium text-shield">Recipient persona</p>
        <h1 className="mt-1 text-3xl font-bold text-slate-50">Bob&apos;s corridor</h1>
        <p className="mt-2 text-slate-400">
          Receive Alice&apos;s note receipt &rarr; generate spend proof &rarr; withdraw &rarr; SEP-24 off-ramp
        </p>
      </div>

      {!connected && (
        <div className="mb-8 rounded-xl border border-shield/30 bg-shield/5 p-6 text-center">
          <p className="mb-4 text-slate-300">Connect Freighter to run the receiver flow</p>
          <button
            onClick={() => connect().catch((e: Error) => setStatus(e.message))}
            className="rounded-lg bg-shield px-5 py-2 text-sm font-medium text-surface"
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
            <p className="font-mono text-shield">{srtBalance}</p>
          </div>
          <div>
            <span className="text-slate-500">Pool root</span>
            <p className="font-mono text-xs text-accent">{poolRoot?.slice(0, 16) ?? "---"}...</p>
          </div>
        </div>
      )}

      {myNotes.length > 0 && (
        <div className="mb-6 rounded-xl border border-shield/20 bg-shield/5 p-4 text-sm">
          <p className="text-xs font-medium text-shield mb-2">Spendable notes in wallet</p>
          {myNotes.map((n, i) => (
            <div
              key={n.commitment}
              onClick={() => { setActiveNote(n); setActiveStep(2); }}
              className={`cursor-pointer rounded-lg px-3 py-2 mb-1 ${activeNote?.commitment === n.commitment ? "bg-shield/20 border border-shield/50" : "hover:bg-shield/10"}`}
            >
              <span className="text-slate-300">Note {i + 1}</span>
              <span className="ml-3 font-mono text-shield">{n.value} SRT</span>
              <span className="ml-3 text-xs text-slate-500">{n.commitment.slice(0, 14)}...</span>
            </div>
          ))}
        </div>
      )}

      <div className="space-y-6">
        <FlowStep step={1} title="Claim note"
          description="Paste the base64 receipt Alice sent you off-chain"
          status={activeStep === 1 ? "active" : activeStep > 1 ? "done" : "pending"}>
          <div className="space-y-3">
            <textarea
              value={noteInput}
              onChange={(e) => setNoteInput(e.target.value)}
              placeholder="Paste base64 note receipt from Alice..."
              rows={3}
              className="w-full rounded-lg border border-surface-border bg-surface px-3 py-2 font-mono text-xs text-slate-200 resize-none"
            />
            <button onClick={handleClaimNote} disabled={!connected || !noteInput}
              className="rounded-lg bg-shield px-4 py-2 text-sm font-medium text-surface disabled:opacity-40">
              Claim note
            </button>
          </div>
        </FlowStep>

        <FlowStep step={2} title="Withdraw from pool"
          description="Proving server generates spend proof against live Merkle tree"
          status={activeStep === 2 ? "active" : activeStep > 2 ? "done" : "pending"}>
          {activeNote && (
            <div className="mb-3 rounded-lg border border-shield/30 bg-shield/5 p-3 text-sm">
              <span className="text-slate-400">Note to spend: </span>
              <span className="font-mono text-shield">{activeNote.value} SRT</span>
              <span className="ml-3 text-xs text-slate-500">{activeNote.commitment.slice(0, 16)}...</span>
            </div>
          )}
          <div className="flex flex-wrap gap-3 items-center">
            <input type="text" value={withdrawAddr}
              onChange={(e) => setWithdrawAddr(e.target.value)}
              placeholder="Destination Stellar address"
              className="flex-1 min-w-48 rounded-lg border border-surface-border bg-surface px-3 py-2 text-sm text-slate-200" />
            <button onClick={handlePoolWithdraw}
              disabled={!connected || activeStep < 2 || !activeNote}
              className="rounded-lg bg-shield px-4 py-2 text-sm font-medium text-surface disabled:opacity-40">
              Withdraw privately
            </button>
          </div>
        </FlowStep>

        <FlowStep step={3} title="SEP-24 off-ramp"
          description="Convert SRT back to fiat via the anchor"
          status={activeStep === 3 ? "active" : "pending"}>
          <button onClick={handleSep24Withdraw}
            disabled={!connected || activeStep < 3}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-surface disabled:opacity-40">
            Open SEP-24 off-ramp
          </button>
        </FlowStep>
      </div>

      <div className="mt-8 space-y-2">
        <StatusBadge status={statusType} message={status} />
        {txHash && (
          <p className="font-mono text-xs text-slate-500">
            Last tx:{" "}
            <a href={`https://stellar.expert/explorer/testnet/tx/${txHash}`}
              target="_blank" rel="noreferrer" className="text-shield hover:underline">
              {txHash}
            </a>
          </p>
        )}
      </div>
    </div>
  );
}
