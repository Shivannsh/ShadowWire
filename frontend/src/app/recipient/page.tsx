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
  DownloadIcon,
  ShieldIcon,
  GlobeIcon,
  CopyIcon,
  CheckIcon,
  SendIcon,
} from "@/components/ui/icons";
import { getReceivingPublicKey } from "@/lib/noteCrypto";
import { toQrDataUrl } from "@/lib/qr";
import { buildWithdrawTx, getPoolRoot, getPoolCommitmentCount, formatPoolRoot, rootToHex } from "@/lib/pool";
import { submitTransaction } from "@/lib/transactions";
import { generateWithdrawProof, decodeNoteReceipt } from "@/lib/proofs";
import type { NoteReceipt, WithdrawProofBundle } from "@/lib/proofs";
import {
  addressToField,
  saveNote,
  getSpendableNotes,
  markNoteSpent,
} from "@/lib/noteWallet";
import type { ShieldedNote } from "@/lib/noteWallet";
import {
  buildAddTrustlineTx,
  getClassicAssetBalance,
  hasTrustline,
} from "@/lib/stellar";
import { runSep24Withdraw, reserveSep24Popup } from "@/lib/sep24";
import { KycBadge } from "@/components/KycBadge";
import { ensureKycAttestation, uidBytesToHex, loadKycProfile } from "@/lib/kyc";

export default function RecipientPage() {
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
  const [poolNotes, setPoolNotes]     = useState<number | null>(null);
  const [kycVerified, setKycVerified] = useState(false);
  const [txHash, setTxHash]           = useState<string | null>(null);
  const [withdrawAddr, setWithdrawAddr] = useState("");
  const [receivingPubKey, setReceivingPubKey] = useState("");
  const [receivingQr, setReceivingQr] = useState<string | null>(null);
  const [keyCopied, setKeyCopied]     = useState(false);
  const [addrCopied, setAddrCopied]   = useState(false);
  const [senderLinkCopied, setSenderLinkCopied] = useState(false);

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

  useEffect(() => { if (address) setWithdrawAddr(address); }, [address]);

  // The Seller's receiving key: shared with the Buyer so the note can be sealed
  // (encrypted) to it. Generated/persisted locally; the public half is safe to share.
  useEffect(() => {
    const pub = getReceivingPublicKey();
    setReceivingPubKey(pub);
    toQrDataUrl(pub).then(setReceivingQr).catch(() => setReceivingQr(null));
  }, []);

  // Support claim deep links: /recipient?note=SWNOTE1.… prefills the sealed package.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const note = new URLSearchParams(window.location.search).get("note");
    if (note) setNoteInput(note);
  }, []);

  const copyReceivingKey = () => {
    if (!receivingPubKey) return;
    navigator.clipboard?.writeText(receivingPubKey).then(() => {
      setKeyCopied(true);
      setTimeout(() => setKeyCopied(false), 1600);
    });
  };

  const copyStellarAddress = () => {
    if (!address) return;
    navigator.clipboard?.writeText(address).then(() => {
      setAddrCopied(true);
      setTimeout(() => setAddrCopied(false), 1600);
    });
  };

  const copySenderLink = () => {
    if (!address || typeof window === "undefined") return;
    const link = `${window.location.origin}/sender?recipient=${encodeURIComponent(address)}`;
    navigator.clipboard?.writeText(link).then(() => {
      setSenderLinkCopied(true);
      setTimeout(() => setSenderLinkCopied(false), 1600);
    });
  };

  useEffect(() => {
    if (connected && address) {
      setStatus((prev) =>
        prev === "Connect Freighter to begin"
          ? `Wallet connected, paste the sender's note receipt to claim`
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

  /** The Seller must trust SRT to receive pool payouts and send SEP-24 withdraw payments. */
  const ensureSrtTrustline = async () => {
    if (!address || !assetIssuer) return;
    const already = await hasTrustline(address, assetCode, assetIssuer);
    if (already) return;
    setStatus(`Adding ${assetCode} trustline (required to hold/send SRT)…`);
    const xdr = await buildAddTrustlineTx(address, assetCode, assetIssuer);
    setStatus("Sign trustline in Freighter…");
    const signed = await sign(xdr);
    await submitTransaction(signed);
    await refreshBalance();
    setStatus(`${assetCode} trustline added`);
  };

  // Step 1: Decode the note receipt the Buyer sent
  const handleClaimNote = () =>
    run(async () => {
      if (!noteInput.trim()) throw new Error("Paste the note receipt from the sender");

      const receipt: NoteReceipt = decodeNoteReceipt(noteInput.trim());

      // The note's owner field MUST stay exactly as the Buyer computed it: the
      // on-chain commitment is note_commitment(owner, value, asset, blinding),
      // so overriding owner with the Seller's own address field would make the
      // stored note inconsistent - the spend proof could never reproduce the
      // on-chain leaf and the Merkle root would never match. Spend authority
      // comes from note_secret_key (in the receipt), not from owner_pubkey, so
      // the Seller can spend a note owned by any field as long as they hold its
      // secrets.
      const note: ShieldedNote = {
        owner:      receipt.owner,
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

  // Step 2: Withdraw (shielded spend proof + off-ramp compliance proof)
  const handlePoolWithdraw = () =>
    run(async () => {
      if (!address) throw new Error("Connect wallet");
      if (!activeNote) throw new Error("Claim your note first");

      await ensureSrtTrustline();

      // ownerField reconstructs the INPUT-note commitment, so it must be the exact
      // field baked into the on-chain commitment (carried on the note), NOT a value
      // re-derived from the Seller's connected address. The Stellar payout recipient
      // is a separate parameter passed to buildWithdrawTx below.
      const ourField = await addressToField(address);

      // Tier C: ensure an on-chain AttestProtocol KYC attestation exists for the
      // recipient at the off-ramp edge (enrolling via the issuer if needed). Needed
      // BEFORE proving so the off-ramp compliance proof is bound to its UID.
      const kycAttestationUid = await ensureKycAttestation(address, "receive", setStatus);

      setStatus("Loading pool tree + building real Merkle path (tree_builder)...");
      setStatus(
        "Generating shielded spend proof + off-ramp compliance proof (two Groth16 proofs)..."
      );
      const withdrawProof: WithdrawProofBundle = await generateWithdrawProof({
        ownerField:  activeNote.owner,
        value:       activeNote.value,
        assetId:     activeNote.assetId,
        blinding:    activeNote.blinding,
        secretKey:   activeNote.secretKey,
        recipient:   ourField,
        commitment:  activeNote.commitment,
        attestationUid: uidBytesToHex(kycAttestationUid),
      });

      setStatus("Building withdraw transaction (shielded + compliance proofs on-chain)...");
      const xdr = await buildWithdrawTx({
        recipient:     address,
        amount:        activeNote.value,
        nullifier:     withdrawProof.spendNullifier,
        newRoot:       withdrawProof.newRoot,
        rootSignature: withdrawProof.rootSignature,
        shieldedProof: withdrawProof,
        withdrawProof,
        kycAttestationUid,
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

      setStatus(`Withdraw confirmed, both proofs verified on-chain: ${result.hash.slice(0, 12)}...`);
      setActiveStep(3);
    });

  // Step 3: SEP-24 off-ramp
  const handleSep24Withdraw = () => {
    if (!address) { setStatus("Connect wallet"); setStatusType("error"); return; }
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
    // Reserve the popup slot synchronously (during the user-gesture) so the
    // browser won't block it. It stays 1×1 off-screen until Freighter signs.
    const reservedPopup = reserveSep24Popup();
    run(async () => {
      await ensureSrtTrustline();
      await refreshBalance();
      const bal = await getClassicAssetBalance(address, assetCode, assetIssuer);
      if (parseFloat(bal) <= 0) {
        throw new Error(
          `No ${assetCode} in wallet (balance: ${bal}). Complete Step 2 "Withdraw privately" first, ` +
          `the pool must pay out SRT before SEP-24 off-ramp.`
        );
      }
      const result = await runSep24Withdraw({
        account: address,
        signXdr: sign,
        amount: activeNote?.value ?? bal,
        customer: {
          firstName: profile.firstName,
          lastName: profile.lastName,
          email: profile.email,
        },
        onStatus: setStatus,
        reservedPopup,
      });
      await refreshBalance();
      if (result.anchorPending) {
        setStatus(
          result.paymentHash
            ? `Off-ramp payment sent (${result.paymentHash.slice(0, 12)}…). Testnet anchor is still crediting fiat, no further wallet action needed.`
            : "Off-ramp payment sent. Testnet anchor is still crediting fiat, no further wallet action needed."
        );
      } else {
        setStatus("SEP-24 off-ramp withdrawal completed");
      }
    });
  };

  return (
    <div className="mx-auto max-w-3xl px-5 pb-28 pt-32">
      {/* Header */}
      <div className="mb-10">
        <Kicker icon={<DownloadIcon size={13} className="text-shield" />}>
          Recipient
        </Kicker>
        <h1 className="display mt-4 text-display-md text-balance">
          Claim and cash out,{" "}
          <span className="serif-accent text-fg-soft">through the bank.</span>
        </h1>
        <p className="mt-3 max-w-xl text-sm leading-relaxed text-fg-muted">
          Decrypt the sender&apos;s sealed note, pass the AttestProtocol KYC gate
          with a spend proof, withdraw from the shielded pool, then off-ramp to
          fiat via SEP-24, the receiving country&apos;s regulated edge.
        </p>
      </div>

      {!connected && (
        <div className="mb-8 flex flex-col items-center gap-4 rounded-2xl border border-shield/25 bg-shield/[0.06] p-8 text-center">
          <WalletIcon size={26} className="text-shield" />
          <p className="text-fg-soft">Connect Freighter to run the receiver flow.</p>
          <Button
            variant="shield"
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
          <Stat label={`${assetCode} balance`} value={srtBalance} tone="shield" />
          <Stat label="Pool root" value={formatPoolRoot(poolRoot, poolNotes)} tone="accent" small />
        </div>
      )}

      {/* Share with sender, Stellar address for the private transfer */}
      {connected && address && (
        <div className="mb-6 rounded-2xl border border-accent/25 bg-accent/[0.06] p-4">
          <div className="mb-2 flex items-center justify-between">
            <p className="kicker text-accent">
              <SendIcon size={13} />
              Share with sender
            </p>
            <div className="flex gap-2">
              <button onClick={copyStellarAddress} className="btn btn-ghost px-2.5 py-1.5 text-xs">
                {addrCopied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
                {addrCopied ? "Copied" : "Copy address"}
              </button>
              <button onClick={copySenderLink} className="btn btn-ghost px-2.5 py-1.5 text-xs">
                {senderLinkCopied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
                {senderLinkCopied ? "Copied" : "Copy sender link"}
              </button>
            </div>
          </div>
          <input readOnly value={address}
            onClick={(e) => (e.target as HTMLInputElement).select()}
            className="field num w-full text-xs" />
          <p className="mt-2 text-xs text-fg-faint">
            The sender pastes this Stellar public key in step 3 as &ldquo;Recipient&apos;s Stellar public key&rdquo;.
            Or send them the sender link, it pre-fills this address on the Sender page.
          </p>
        </div>
      )}

      {/* Receiving key, share with the sender so they can seal the note to you */}
      {connected && (
        <div className="mb-8 rounded-2xl border border-shield/25 bg-shield/[0.06] p-4">
          <div className="mb-2 flex items-center justify-between">
            <p className="kicker" style={{ color: "#46d6a6" }}>
              <ShieldIcon size={13} />
              Your receiving key, send to the sender
            </p>
            <button onClick={copyReceivingKey} className="btn btn-ghost px-2.5 py-1.5 text-xs">
              {keyCopied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
              {keyCopied ? "Copied" : "Copy"}
            </button>
          </div>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
            <input readOnly value={receivingPubKey}
              onClick={(e) => (e.target as HTMLInputElement).select()}
              className="field num min-w-0 flex-1 text-xs" />
            {receivingQr && (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img src={receivingQr} alt="Receiving key QR"
                width={96} height={96}
                className="h-24 w-24 shrink-0 self-center rounded-lg border border-surface-border bg-white p-1.5" />
            )}
          </div>
          <p className="mt-2 text-xs text-fg-faint">
            The sender encrypts your note to this key. Only this device can decrypt it,
            keep it if you clear browser storage.
          </p>
        </div>
      )}

      {/* Spendable notes */}
      {myNotes.length > 0 && (
        <div className="mb-8 rounded-2xl border border-surface-border bg-ink-850/50 p-4">
          <p className="kicker mb-3" style={{ color: "#46d6a6" }}>
            <ShieldIcon size={13} />
            Spendable notes
          </p>
          <div className="space-y-1.5">
            {myNotes.map((n, i) => {
              const active = activeNote?.commitment === n.commitment;
              return (
                <button
                  key={n.commitment}
                  onClick={() => { setActiveNote(n); setActiveStep(2); }}
                  className={`flex w-full items-center justify-between rounded-xl border px-3.5 py-2.5 text-left transition-colors ${
                    active
                      ? "border-shield/40 bg-shield/10"
                      : "border-transparent hover:border-surface-border hover:bg-surface-raised"
                  }`}
                >
                  <span className="flex items-center gap-3">
                    <span className="text-sm text-fg-soft">Note {i + 1}</span>
                    <span className="num text-sm font-semibold text-shield">{n.value} {assetCode}</span>
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
          side="receive"
          onStatus={setStatus}
          onVerifiedChange={setKycVerified}
        />
      )}

      {/* Flow */}
      <div>
        <FlowStep step={1} title="Claim sealed note"
          description="Paste the encrypted note receipt (SWNOTE1.…) from the sender, or open their claim link. Only your receiving key can decrypt it."
          status={activeStep === 1 ? "active" : activeStep > 1 ? "done" : "pending"}>
          <FieldLabel label="Note receipt" hint="sealed (SWNOTE1.…) or legacy base64">
            <textarea
              value={noteInput}
              onChange={(e) => setNoteInput(e.target.value)}
              placeholder="Paste the sealed note package from the sender…"
              rows={3}
              className="field num resize-none text-xs"
            />
          </FieldLabel>
          <div className="mt-4">
            <Button variant="shield" onClick={handleClaimNote} disabled={!connected || !noteInput} icon={<DownloadIcon size={16} />}>
              Claim note
            </Button>
          </div>
        </FlowStep>

        <FlowStep step={2} title="KYC gate + withdraw"
          description="AttestProtocol verifies your receiving-edge KYC attestation. ZK spend + compliance proofs unlock funds from the shielded pool to your visible balance."
          status={activeStep === 2 ? "active" : activeStep > 2 ? "done" : "pending"}>
          {activeNote && (
            <div className="mb-4 flex items-center gap-3 rounded-xl border border-shield/30 bg-shield/[0.06] px-3.5 py-2.5 text-sm">
              <span className="text-fg-muted">Note to spend</span>
              <span className="num font-semibold text-shield">{activeNote.value} {assetCode}</span>
              <span className="num ml-auto text-xs text-fg-faint">{activeNote.commitment.slice(0, 18)}…</span>
            </div>
          )}
          <div className="flex flex-wrap items-end gap-3">
            <FieldLabel label="Destination address" hint="Stellar G…">
              <input type="text" value={withdrawAddr}
                onChange={(e) => setWithdrawAddr(e.target.value)}
                placeholder="Destination Stellar address"
                className="field min-w-64" />
            </FieldLabel>
            <Button variant="shield" onClick={handlePoolWithdraw}
              disabled={!connected || activeStep < 2 || !activeNote}
              icon={<ShieldIcon size={16} />}>
              Withdraw privately
            </Button>
          </div>
        </FlowStep>

        <FlowStep step={3} title="Bank off-ramp (SEP-24)"
          description="The receiving bank's interface handles the final fiat payout. In production this is the recipient's bank app, the anchor independently verifies the off-ramp leg before releasing funds."
          status={activeStep === 3 ? "active" : "pending"}
          last>
          {activeStep === 3 && (
            <p className="mb-3 text-xs text-fg-faint">
              Your KYC details are forwarded automatically, no form to fill. The anchor processes the payout in the background.
            </p>
          )}
          <Button onClick={handleSep24Withdraw}
            disabled={!connected || activeStep < 3}
            icon={<GlobeIcon size={16} />}>
            Withdraw via bank anchor
          </Button>
        </FlowStep>
      </div>

      {/* Status footer */}
      <div className="mt-8 space-y-3">
        <StatusBadge status={statusType} message={status} />
        {txHash && (
          <a href={`https://stellar.expert/explorer/testnet/tx/${txHash}`}
            target="_blank" rel="noreferrer"
            className="num inline-flex items-center gap-1.5 text-xs text-fg-muted transition-colors hover:text-shield">
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
