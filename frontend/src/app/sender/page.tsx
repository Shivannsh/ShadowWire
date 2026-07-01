"use client";

import { useCallback, useEffect, useState } from "react";
import { useFreighter } from "@/hooks/useFreighter";
import { useTestnetAddresses } from "@/hooks/useTestnetAddresses";
import { FlowStep, StatusBadge } from "@/components/FlowStep";
import { CorridorBanner } from "@/components/CorridorBanner";
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
import { runSep24Deposit } from "@/lib/sep24";
import { buildDepositTx, buildTransferTx, getPoolRoot, getPoolCommitmentCount, formatPoolRoot, rootToHex } from "@/lib/pool";
import { submitTransaction } from "@/lib/transactions";
import {
  generateComplianceProof,
  proveDeposit,
  generateShieldedTransferProof,
  sealNoteReceipt,
} from "@/lib/proofs";
import type { NoteReceipt } from "@/lib/proofs";
import { toQrDataUrl } from "@/lib/qr";
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
import { KycBadge } from "@/components/KycBadge";
import { ensureKycAttestation, uidBytesToHex, loadKycProfile } from "@/lib/kyc";

type Step = 1 | 2 | 3;

/** Parse any numeric string (including "9.0", "9.5") to a whole-number string.
 *  Noir circuits and BigInt() both require plain integers, no decimal point. */
function toIntStr(v: string): string {
  return String(Math.floor(parseFloat(v)));
}

export default function SenderPage() {
  const { address, connected, connect, sign, isCorrectNetwork } = useFreighter();
  const { addresses } = useTestnetAddresses();

  const [activeStep, setActiveStep]   = useState<Step>(1);
  const [status, setStatus]           = useState("Connect Freighter to begin");
  const [statusType, setStatusType]   = useState<"idle" | "loading" | "success" | "error">("idle");
  const [srtBalance, setSrtBalance]   = useState("0");
  const [poolRoot, setPoolRoot]       = useState<string | null>(null);
  const [poolNotes, setPoolNotes]       = useState<number | null>(null);
  const [kycVerified, setKycVerified]   = useState(false);
  const [depositAmount, setDepositAmount] = useState("100");
  const [bobRecipientField, setBobRecipientField] = useState("");
  const [sendAmount, setSendAmount]   = useState("");
  const [txHash, setTxHash]           = useState<string | null>(null);
  const [noteReceipt, setNoteReceipt] = useState<string | null>(null);
  const [noteSealed, setNoteSealed]   = useState(false);
  const [noteQr, setNoteQr]           = useState<string | null>(null);
  const [noteDeepLink, setNoteDeepLink] = useState<string | null>(null);
  const [receivingKey, setReceivingKey] = useState("");
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
    try {
      const [root, count] = await Promise.all([getPoolRoot(), getPoolCommitmentCount()]);
      setPoolRoot(rootToHex(root));
      setPoolNotes(count);
    } catch {
      setPoolRoot(null);
      setPoolNotes(null);
    }
  }, []);

  const refreshNotes = useCallback(() => {
    if (!poolAddress || !address) return;
    const notes = getSpendableNotes(poolAddress);
    setMyNotes(notes);
    if (notes.length > 0 && !activeNote) setActiveNote(notes[0]);
  }, [poolAddress, address, activeNote]);

  // Pre-fill recipient address from ?recipient=G… link (shared from the Recipient page).
  useEffect(() => {
    if (typeof window === "undefined") return;
    const recipient =
      new URLSearchParams(window.location.search).get("recipient") ??
      new URLSearchParams(window.location.search).get("seller");
    if (recipient?.startsWith("G") && recipient.length === 56) {
      setBobRecipientField(recipient);
    }
  }, []);

  // Keep send amount in sync with the active shielded note.
  useEffect(() => {
    if (activeNote?.value) setSendAmount(activeNote.value);
  }, [activeNote?.commitment, activeNote?.value]);

  // Update stale default status once wallet is connected (header + page share state)
  useEffect(() => {
    if (connected && address) {
      setStatus((prev) =>
        prev === "Connect Freighter to begin"
          ? `Wallet connected, start with a SEP-24 deposit or shield existing SRT`
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
      setStatus(`${assetCode} trustline added, ready to receive from anchor`);
    });

  const handleSep24Deposit = () => {
    if (!address) { setStatus("Connect wallet first"); setStatusType("error"); return; }
    if (!isCorrectNetwork) { setStatus("Switch Freighter to testnet"); setStatusType("error"); return; }
    if (!kycVerified) {
      setStatus("Complete on-chain KYC first, verify your identity above");
      setStatusType("error");
      return;
    }
    const profile = loadKycProfile(address);
    if (!profile) {
      setStatus("KYC profile missing, re-verify your identity above");
      setStatusType("error");
      return;
    }
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
          setStatus("Trustline added, proceeding with SEP-24 deposit…");
        }
      }
      // No popup needed — deposit is submitted headlessly to the anchor reference server.
      const { transaction } = await runSep24Deposit({
        account: address,
        signXdr: sign,
        amount: depositAmount,
        customer: {
          firstName: profile.firstName,
          lastName: profile.lastName,
          email: profile.email,
        },
        onStatus: setStatus,
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
      const { commitment, newRoot, rootSignature } = await proveDeposit({
        ownerField, value, assetId: "3", blinding, secretKey,
      });

      // Tier C: ensure an on-chain AttestProtocol KYC attestation exists for the
      // depositor (enrolling via the issuer if needed). The pool verifies it AND
      // binds the compliance proof to its UID, so we need it BEFORE proving.
      const kycAttestationUid = await ensureKycAttestation(address, "send", setStatus);

      setStatus("Generating compliance proof for deposit amount...");
      const complianceProof = await generateComplianceProof({
        amount: BigInt(value), ownerField,
        attestationUid: uidBytesToHex(kycAttestationUid),
      });

      setStatus("Building shielded deposit transaction...");
      const xdr = await buildDepositTx({
        depositor:            address,
        amount:               value,
        commitment,
        newRoot,
        rootSignature,
        complianceNullifier:  complianceProof.complianceNullifier,
        complianceProof,
        kycAttestationUid,
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
      setSendAmount(value);
      refreshNotes();
      await refreshRoot();

      setStatus(`Shielded deposit confirmed. Amount hidden on-chain: ${result.hash.slice(0, 12)}...`);
      setActiveStep(3);
    });

  const handleSendPrivate = () =>
    run(async () => {
      if (!address || !activeNote) throw new Error("Shield funds first");
      if (!bobRecipientField.trim()) throw new Error("Enter the recipient's Stellar public key");

      const amount = toIntStr(sendAmount.trim() || activeNote.value);

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
        outputValue:  amount,
        fee:          "0",
      });

      setStatus("Building private transfer transaction...");
      const xdr = await buildTransferTx({
        sender:          address,
        nullifier:       shieldedProof.spendNullifier,
        newCommitment1:  shieldedProof.newCommitment1,
        newCommitment2:  shieldedProof.newCommitment2,
        newRoot:         shieldedProof.newRoot,
        rootSignature:   shieldedProof.rootSignature,
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

      // Build note receipt for the Seller. Prefer the sealed (encrypted) channel:
      // the note carries spend authority, so a plaintext receipt is a bearer token
      // anyone can intercept and spend. If the Seller's receiving key is present we
      // seal to it; otherwise we fall back to legacy plaintext with a clear warning.
      if (shieldedProof.bobNote) {
        const bobNote = shieldedProof.bobNote as NoteReceipt;
        const key = receivingKey.trim();
        let receipt: string;
        let sealed = false;
        if (key) {
          receipt = sealNoteReceipt(bobNote, key);
          sealed = true;
        } else {
          receipt = walletEncodeReceipt(bobNote);
        }
        setNoteReceipt(receipt);
        setNoteSealed(sealed);

        if (sealed && typeof window !== "undefined") {
          const link = `${window.location.origin}/recipient?note=${encodeURIComponent(receipt)}`;
          setNoteDeepLink(link);
          try { setNoteQr(await toQrDataUrl(link)); } catch { setNoteQr(null); }
        } else {
          setNoteDeepLink(null);
          setNoteQr(null);
        }

        setStatus(
          sealed
            ? `Transfer confirmed. Sealed note ready, scan the QR or send the link to the recipient: ${result.hash.slice(0, 12)}...`
            : `Transfer confirmed. ⚠ No receiving key, sending a PLAINTEXT receipt. Paste the recipient's receiving key to encrypt: ${result.hash.slice(0, 12)}...`
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
          Sender
        </Kicker>
        <h1 className="display mt-4 text-display-md text-balance">
          Send from bank to bank,{" "}
          <span className="serif-accent text-fg-soft">privately.</span>
        </h1>
        <p className="mt-3 max-w-xl text-sm leading-relaxed text-fg-muted">
          Deposit fiat through a SEP-24 anchor, pass the AttestProtocol KYC gate,
          shield with a Groth16 compliance proof, then send a zero-knowledge
          transfer to the recipient, amount hidden on-chain.
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
          <Stat label="Pool root" value={formatPoolRoot(poolRoot, poolNotes)} tone="shield" small />
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

      {/* Cross-border corridor */}
      <CorridorBanner />

      {/* On-chain KYC attestation (AttestProtocol) */}
      {connected && address && (
        <KycBadge
          address={address}
          side="send"
          onStatus={setStatus}
          onVerifiedChange={setKycVerified}
        />
      )}

      {/* Flow */}
      <div>
        <FlowStep step={1} title="Bank on-ramp (SEP-24)"
          description="Deposit fiat through the regulated Stellar anchor. In production this is your bank's own interface, the anchor independently verifies the sending leg before crediting SRT."
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
            <Button onClick={handleSep24Deposit} disabled={!connected || !kycVerified} icon={<GlobeIcon size={16} />}>
              Deposit via bank anchor
            </Button>
          </div>
          {!kycVerified && connected && (
            <p className="mt-3 text-xs text-fg-faint">
              Complete on-chain KYC above first, the anchor gate requires it.
            </p>
          )}
          {kycVerified && activeStep === 1 && statusType !== "loading" && (
            <p className="mt-3 text-xs text-fg-faint">
              Your KYC details are forwarded automatically — no form to fill. The anchor processes the deposit in the background.
            </p>
          )}
          {statusType === "loading" && activeStep === 1 && (
            <div className="mt-4 flex items-center gap-3 rounded-xl border border-accent/20 bg-accent/[0.06] px-4 py-3">
              <svg className="h-5 w-5 shrink-0 animate-spin text-accent" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                <path className="opacity-80" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              <div className="min-w-0">
                <p className="text-sm font-medium text-accent">Processing deposit…</p>
                <p className="truncate text-xs text-fg-faint">{status}</p>
              </div>
            </div>
          )}
        </FlowStep>

        <FlowStep step={2} title="KYC gate + shield"
          description="AttestProtocol verifies your on-chain KYC attestation. A Groth16 compliance proof binds to it and the deposit amount, then funds enter the shielded pool."
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
          {statusType === "loading" && activeStep === 2 && (
            <StepSpinner color="shield" label="Shielding funds…" detail={status} />
          )}
        </FlowStep>

        <FlowStep step={3} title="Private ZK transfer"
          description="Groth16 shielded-transfer proof against live pool state, only a nullifier and new commitment hit the chain. Amount and parties stay hidden."
          status={activeStep === 3 ? "active" : "pending"}
          last>
          <div className="space-y-4">
            <FieldLabel label="Recipient's Stellar public key" hint="Freighter G-address">
              <input type="text" value={bobRecipientField}
                onChange={(e) => setBobRecipientField(e.target.value)}
                placeholder="G… (copy from Recipient page)"
                className="field num text-xs" />
            </FieldLabel>
            <p className="text-xs text-fg-faint">
              The recipient&apos;s visible Stellar account, the same address they connect with on the Recipient page.
              Ask them to copy it from &ldquo;Share with sender&rdquo; there. It is converted to a pool field internally; do not paste a pool field ID here.
            </p>
            <FieldLabel label="Recipient receiving key" hint="encrypts the note, get it from the recipient">
              <input type="text" value={receivingKey}
                onChange={(e) => setReceivingKey(e.target.value)}
                placeholder="Paste the recipient's receiving key (base64) to seal the note"
                className="field num text-xs" />
            </FieldLabel>
            <div className="flex flex-wrap items-end gap-3">
              <FieldLabel label="Amount to send" hint={assetCode}>
                <input type="text" value={sendAmount}
                  onChange={(e) => setSendAmount(e.target.value)}
                  placeholder={activeNote?.value ?? "Amount"}
                  className="field max-w-40" />
              </FieldLabel>
              <Button onClick={handleSendPrivate}
                disabled={!connected || activeStep < 3 || !activeNote}
                icon={<SendIcon size={16} />}>
                Send privately
              </Button>
            </div>
            {activeNote && (
              <p className="text-xs text-fg-faint">
                From your shielded note: <span className="num font-medium text-accent">{activeNote.value} {assetCode}</span>
                {sendAmount !== activeNote.value && sendAmount && (
                  <span>, sending {sendAmount} {assetCode}</span>
                )}
              </p>
            )}
          </div>
          {statusType === "loading" && activeStep === 3 && (
            <StepSpinner color="accent" label="Sending privately…" detail={status} />
          )}

          {noteReceipt && (
            <div className={`mt-5 rounded-xl border p-4 ${noteSealed ? "border-shield/30 bg-shield/[0.06]" : "border-warn/40 bg-warn/[0.06]"}`}>
              <div className="mb-2 flex items-center justify-between">
                <p className="kicker" style={{ color: noteSealed ? "#46d6a6" : "#f0b429" }}>
                  <ShieldIcon size={13} />
                  {noteSealed ? "Sealed note, only the recipient can open it" : "⚠ Plaintext receipt, anyone can spend it"}
                </p>
                <button onClick={copyReceipt} className="btn btn-ghost px-2.5 py-1.5 text-xs">
                  {copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>

              <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
                <div className="min-w-0 flex-1">
                  <textarea readOnly value={noteReceipt} rows={4}
                    className="field num w-full resize-none text-xs"
                    onClick={(e) => (e.target as HTMLTextAreaElement).select()} />
                  {noteDeepLink && (
                    <a href={noteDeepLink} target="_blank" rel="noreferrer"
                      className="num mt-2 inline-flex items-center gap-1.5 text-xs text-fg-muted transition-colors hover:text-shield">
                      Open claim link
                      <ArrowUpRightIcon size={13} />
                    </a>
                  )}
                </div>
                {noteQr && (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img src={noteQr} alt="Scan to claim note"
                    width={128} height={128}
                    className="h-32 w-32 shrink-0 self-center rounded-lg border border-surface-border bg-white p-1.5" />
                )}
              </div>

              <p className="mt-3 text-xs text-fg-faint">
                {noteSealed
                  ? "The note is encrypted to the recipient's receiving key (X25519 + XSalsa20-Poly1305). Even if intercepted, only the recipient can decrypt and spend it."
                  : "No receiving key was provided, so this receipt is unencrypted, treat it like cash. Paste the recipient's receiving key above before sending to encrypt it."}
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

function StepSpinner({ color, label, detail }: { color: "accent" | "shield"; label: string; detail?: string }) {
  const ring = color === "shield" ? "text-shield border-shield/20 bg-shield/[0.06]" : "text-accent border-accent/20 bg-accent/[0.06]";
  return (
    <div className={`mt-4 flex items-center gap-3 rounded-xl border px-4 py-3 ${ring}`}>
      <svg className="h-5 w-5 shrink-0 animate-spin" viewBox="0 0 24 24" fill="none">
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
        <path className="opacity-80" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
      </svg>
      <div className="min-w-0">
        <p className="text-sm font-medium">{label}</p>
        {detail && <p className="truncate text-xs text-fg-faint">{detail}</p>}
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
