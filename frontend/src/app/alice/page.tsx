"use client";

import { useCallback, useEffect, useState } from "react";
import { useFreighter } from "@/hooks/useFreighter";
import { useTestnetAddresses } from "@/hooks/useTestnetAddresses";
import { FlowStep, StatusBadge } from "@/components/FlowStep";
import { Button, FieldLabel, Kicker } from "@/components/ui/primitives";
import {
  ArrowUpRightIcon,
  WalletIcon,
  PlusIcon,
  ShieldIcon,
  SendIcon,
  GlobeIcon,
  CopyIcon,
  CheckIcon,
} from "@/components/ui/icons";
import { runSep24Deposit, openSep24Popup } from "@/lib/sep24";
import { buildDepositTx, buildTransferTx, getPoolRoot, rootToHex } from "@/lib/pool";
import { submitTransaction } from "@/lib/transactions";
import {
  generateComplianceProof,
  proveDeposit,
  generateShieldedTransferProof,
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
import { fundTestnetAccount, getClassicAssetBalance, buildAddTrustlineTx, hasTrustline } from "@/lib/stellar";

type Step = 1 | 2 | 3;

/** Parse any numeric string (including "9.0", "9.5") to a whole-number string.
 *  Noir circuits and BigInt() both require plain integers — no decimal point. */
function toIntStr(v: string): string {
  return String(Math.floor(parseFloat(v)));
}

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
  const [copied, setCopied]           = useState(false);

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

  // Update stale default status once wallet is connected (header + page share state)
  useEffect(() => {
    if (connected && address) {
      setStatus((prev) =>
        prev === "Connect Freighter to begin"
          ? `Wallet connected — start with a SEP-24 deposit or shield existing SRT`
          : prev
      );
    }
  }, [connected, address]);

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

  const handleAddTrustline = () =>
    run(async () => {
      if (!address) throw new Error("Connect wallet first");
      if (!assetIssuer) throw new Error("Asset issuer not loaded yet");
      const already = await hasTrustline(address, assetCode, assetIssuer);
      if (already) { setStatus("Trustline already exists"); return; }
      setStatus(`Adding ${assetCode} trustline…`);
      const xdr = await buildAddTrustlineTx(address, assetCode, assetIssuer);
      setStatus("Sign trustline in Freighter…");
      const signed = await sign(xdr);
      const { submitTransaction } = await import("@/lib/transactions");
      await submitTransaction(signed);
      await refreshBalance();
      setStatus(`${assetCode} trustline added — ready to receive from anchor`);
    });

  const handleSep24Deposit = () => {
    if (!address) { setStatus("Connect wallet first"); setStatusType("error"); return; }
    if (!isCorrectNetwork) { setStatus("Switch Freighter to testnet"); setStatusType("error"); return; }
    // Open the blank popup NOW while the click gesture is live — browsers block
    // window.open() called from inside async callbacks.
    const popup = openSep24Popup("about:blank");
    run(async () => {
      // Auto-add trustline if missing so the anchor can send SRT
      if (assetIssuer) {
        const already = await hasTrustline(address, assetCode, assetIssuer);
        if (!already) {
          setStatus(`Adding ${assetCode} trustline first…`);
          const { buildAddTrustlineTx: batt } = await import("@/lib/stellar");
          const xdr = await batt(address, assetCode, assetIssuer);
          setStatus("Sign trustline in Freighter…");
          const signed = await sign(xdr);
          const { submitTransaction } = await import("@/lib/transactions");
          await submitTransaction(signed);
          setStatus("Trustline added — proceeding with SEP-24 deposit…");
        }
      }
      const { transaction } = await runSep24Deposit({
        account: address, signXdr: sign, amount: depositAmount, onStatus: setStatus, popup,
      });
      if (transaction.amount_out) setDepositAmount(toIntStr(transaction.amount_out));
      setStatus(`SEP-24 deposit ${transaction.status}`);
      await refreshBalance();
      setActiveStep(2);
    });
  };

  const handleShield = () =>
    run(async () => {
      if (!address) throw new Error("Connect wallet first");

      // --- Generate fresh note randomness for this deposit ---
      const ownerField              = await addressToField(address);
      const { blinding, secretKey } = generateNoteRandomness();
      // Sanitize: anchor returns "9.0"; Noir circuits need a plain integer string.
      const value                   = toIntStr(depositAmount);

      setStatus("Computing note commitment and new pool root (hash_util)...");
      const { commitment, newRoot } = await proveDeposit({
        ownerField, value, assetId: "3", blinding, secretKey,
      });

      setStatus("Generating compliance proof for deposit amount...");
      const complianceProof = await generateComplianceProof({
        amount: BigInt(value), ownerField,
      });

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

      // Save the note to localStorage so the Buyer can spend it later
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
      if (!bobRecipientField.trim()) throw new Error("Enter the Seller's recipient field");

      setStatus("Loading real pool tree + computing Merkle path (tree_builder)...");

      // Derive the Seller's ownerField from their Stellar address if it looks like one
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

      // Build note receipt for the Seller
      if (shieldedProof.bobNote) {
        const receipt = walletEncodeReceipt(shieldedProof.bobNote as NoteReceipt);
        setNoteReceipt(receipt);
        setStatus(
          `Transfer confirmed. Copy the receipt below and send it to the Seller: ${result.hash.slice(0, 12)}...`
        );
      } else {
        setStatus(`Transfer confirmed: ${result.hash.slice(0, 12)}...`);
      }
    });

  const copyReceipt = () => {
    if (!noteReceipt) return;
    navigator.clipboard?.writeText(noteReceipt).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    });
  };

  return (
    <div className="mx-auto max-w-3xl px-5 pb-28 pt-32">
      {/* Header */}
      <div className="mb-10">
        <Kicker icon={<SendIcon size={13} className="text-accent" />}>
          Buyer · sender
        </Kicker>
        <h1 className="display mt-4 text-display-md text-balance">
          Send privately,{" "}
          <span className="serif-accent text-fg-soft">end to end.</span>
        </h1>
        <p className="mt-3 max-w-xl text-fg-muted">
          Deposit fiat via SEP-24, shield it with fresh note randomness, then
          send a private transfer to the Seller.
        </p>
      </div>

      {!connected && (
        <div className="mb-8 flex flex-col items-center gap-4 rounded-2xl border border-accent/25 bg-accent/[0.06] p-8 text-center">
          <WalletIcon size={26} className="text-accent" />
          <p className="text-fg-soft">Connect Freighter to run the sender flow.</p>
          <Button
            onClick={() => connect().catch((e: Error) => setStatus(e.message))}
            icon={<WalletIcon size={16} />}
          >
            Connect wallet
          </Button>
        </div>
      )}

      {/* Account summary */}
      {connected && address && (
        <div className="mb-6 grid gap-px overflow-hidden rounded-2xl border border-surface-border bg-surface-border sm:grid-cols-3">
          <Stat label="Account" value={`${address.slice(0, 10)}…`} tone="fg" />
          <Stat label={`${assetCode} balance`} value={srtBalance} tone="accent" />
          <Stat label="Pool root" value={poolRoot ? `${poolRoot.slice(0, 14)}…` : "—"} tone="shield" small />
        </div>
      )}

      {/* Spendable notes */}
      {myNotes.length > 0 && (
        <div className="mb-8 rounded-2xl border border-surface-border bg-ink-850/50 p-4">
          <p className="kicker mb-3">
            <ShieldIcon size={13} className="text-accent" />
            Spendable notes
          </p>
          <div className="space-y-1.5">
            {myNotes.map((n, i) => {
              const active = activeNote?.commitment === n.commitment;
              return (
                <button
                  key={n.commitment}
                  onClick={() => { setActiveNote(n); setSendAmount(n.value); setActiveStep(3); }}
                  className={`flex w-full items-center justify-between rounded-xl border px-3.5 py-2.5 text-left transition-colors ${
                    active
                      ? "border-accent/40 bg-accent/10"
                      : "border-transparent hover:border-surface-border hover:bg-surface-raised"
                  }`}
                >
                  <span className="flex items-center gap-3">
                    <span className="text-sm text-fg-soft">Note {i + 1}</span>
                    <span className="num text-sm font-semibold text-accent">{n.value} {assetCode}</span>
                  </span>
                  <span className="num text-xs text-fg-faint">{n.commitment.slice(0, 16)}…</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Flow */}
      <div>
        <FlowStep step={1} title="SEP-24 deposit"
          description="Interactive anchor flow — deposit fiat, receive SRT on Stellar."
          status={activeStep === 1 ? "active" : activeStep > 1 ? "done" : "pending"}>
          <FieldLabel label="Deposit amount" hint={assetCode}>
            <input type="text" value={depositAmount}
              onChange={(e) => setDepositAmount(e.target.value)}
              placeholder="Amount"
              className="field max-w-40" />
          </FieldLabel>
          <div className="mt-4 flex flex-wrap gap-2.5">
            <Button variant="ghost" onClick={handleFund} disabled={!connected} icon={<PlusIcon size={16} />}>
              Fund XLM
            </Button>
            <Button variant="ghost" onClick={handleAddTrustline} disabled={!connected}>
              Add {assetCode} trustline
            </Button>
            <Button onClick={handleSep24Deposit} disabled={!connected} icon={<GlobeIcon size={16} />}>
              Open SEP-24 deposit
            </Button>
          </div>
        </FlowStep>

        <FlowStep step={2} title="Shield funds"
          description="Fresh note randomness and a compliance proof for the exact deposited amount."
          status={activeStep === 2 ? "active" : activeStep > 2 ? "done" : "pending"}>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
            <p className="text-sm text-fg-soft">
              Shielding <span className="num font-semibold text-accent">{depositAmount} {assetCode}</span>
              <span className="ml-2 text-xs text-fg-faint">from the SEP-24 deposit</span>
            </p>
            <Button variant="shield" onClick={handleShield} disabled={!connected || activeStep < 2} icon={<ShieldIcon size={16} />}>
              Shield into pool
            </Button>
          </div>
        </FlowStep>

        <FlowStep step={3} title="Send privately"
          description="Real Merkle path from chain — the proof is generated against live pool state."
          status={activeStep === 3 ? "active" : "pending"}
          last>
          <div className="space-y-4">
            <FieldLabel label="Seller recipient" hint="Stellar address or pool field ID">
              <input type="text" value={bobRecipientField}
                onChange={(e) => setBobRecipientField(e.target.value)}
                placeholder="G… or pool Field ID"
                className="field" />
            </FieldLabel>
            <div className="flex flex-wrap items-end gap-3">
              <FieldLabel label="Amount to send" hint={assetCode}>
                <input type="text" value={sendAmount}
                  onChange={(e) => setSendAmount(e.target.value)}
                  placeholder="Amount"
                  className="field max-w-40" />
              </FieldLabel>
              <Button onClick={handleSendPrivate}
                disabled={!connected || activeStep < 3 || !activeNote}
                icon={<SendIcon size={16} />}>
                Send privately
              </Button>
            </div>
          </div>

          {noteReceipt && (
            <div className="mt-5 rounded-xl border border-shield/30 bg-shield/[0.06] p-4">
              <div className="mb-2 flex items-center justify-between">
                <p className="kicker" style={{ color: "#46d6a6" }}>
                  <ShieldIcon size={13} />
                  Note receipt — send to the Seller off-chain
                </p>
                <button onClick={copyReceipt} className="btn btn-ghost px-2.5 py-1.5 text-xs">
                  {copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
              <textarea readOnly value={noteReceipt} rows={3}
                className="field num resize-none text-xs"
                onClick={(e) => (e.target as HTMLTextAreaElement).select()} />
              <p className="mt-2 text-xs text-fg-faint">
                Share via an encrypted channel. The Seller pastes this to claim the funds.
              </p>
            </div>
          )}
        </FlowStep>
      </div>

      {/* Status footer */}
      <div className="mt-8 space-y-3">
        <StatusBadge status={statusType} message={status} />
        {txHash && (
          <a href={`https://stellar.expert/explorer/testnet/tx/${txHash}`}
            target="_blank" rel="noreferrer"
            className="num inline-flex items-center gap-1.5 text-xs text-fg-muted transition-colors hover:text-accent">
            Last tx: {txHash.slice(0, 24)}…
            <ArrowUpRightIcon size={13} />
          </a>
        )}
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
  small,
}: {
  label: string;
  value: string;
  tone: "fg" | "accent" | "shield";
  small?: boolean;
}) {
  const color = tone === "accent" ? "text-accent" : tone === "shield" ? "text-shield" : "text-fg";
  return (
    <div className="bg-ink-900/80 px-4 py-4">
      <span className="text-[11px] uppercase tracking-wider text-fg-faint">{label}</span>
      <p className={`num mt-1 ${small ? "text-sm" : "text-lg"} font-semibold ${color}`}>{value}</p>
    </div>
  );
}
