"use client";

import { useCallback, useEffect, useState } from "react";
import {
  POOL_KYC_ATTEST,
  getKycConfig,
  getKycStatus,
  enrollKyc,
  revokeKyc,
  clearKycProfile,
  loadKycProfile,
  type KycConfig,
  type KycProfile,
  type KycStatus,
  type KycSide,
} from "@/lib/kyc";
import { ShieldIcon, CheckIcon, ArrowUpRightIcon } from "@/components/ui/icons";
import { FieldLabel } from "@/components/ui/primitives";

/**
 * On-chain KYC attestation badge (AttestProtocol, Tier C).
 *
 * Collects identity details off-chain, then issues a delegated attestation
 * whose on-chain claim is tier + country (not PII). Saved profile pre-fills
 * the SEP-24 anchor deposit/withdraw popup.
 */
export function KycBadge({
  address,
  side,
  onStatus,
  onVerifiedChange,
}: {
  address: string;
  side: KycSide;
  onStatus?: (msg: string) => void;
  onVerifiedChange?: (verified: boolean) => void;
}) {
  const [config, setConfig] = useState<KycConfig | null>(null);
  const [status, setStatus] = useState<KycStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [profile, setProfile] = useState<KycProfile>({
    firstName: "",
    lastName: "",
    email: "",
  });

  const refresh = useCallback(async () => {
    try {
      const [cfg, st] = await Promise.all([getKycConfig(), getKycStatus(address)]);
      setConfig(cfg);
      setStatus(st);
      setError(null);
      onVerifiedChange?.(!!st.verified && !st.revoked);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not reach KYC issuer");
    }
  }, [address, onVerifiedChange]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    const saved = loadKycProfile(address);
    if (saved) setProfile(saved);
  }, [address]);

  const enroll = async () => {
    const trimmed: KycProfile = {
      firstName: profile.firstName.trim(),
      lastName: profile.lastName.trim(),
      email: profile.email.trim(),
    };
    if (!trimmed.firstName || !trimmed.lastName || !trimmed.email) {
      setError("First name, last name, and email are required.");
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed.email)) {
      setError("Enter a valid email address.");
      return;
    }

    setBusy(true);
    setError(null);
    try {
      onStatus?.("Verifying identity and issuing AttestProtocol attestation…");
      const r = await enrollKyc(address, side, trimmed);
      onStatus?.(`KYC attested on-chain: ${r.attestationUid.slice(0, 16)}…`);
      setShowForm(false);
      await refresh();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "KYC enrollment failed";
      setError(msg);
      onStatus?.(msg);
    } finally {
      setBusy(false);
    }
  };

  const revoke = async () => {
    if (!window.confirm("Revoke this wallet's on-chain KYC attestation? You'll need to verify again.")) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      onStatus?.("Revoking AttestProtocol attestation…");
      const r = await revokeKyc(address);
      clearKycProfile(address);
      setProfile({ firstName: "", lastName: "", email: "" });
      onStatus?.(`KYC revoked: ${r.attestationUid.slice(0, 16)}…`);
      await refresh();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "KYC revocation failed";
      setError(msg);
      onStatus?.(msg);
    } finally {
      setBusy(false);
    }
  };

  if (!POOL_KYC_ATTEST && !config?.configured) return null;

  const verified = !!status?.verified && !status?.revoked;
  const revoked = !!status?.revoked;
  const protocol = config?.protocol;
  const uid = status?.attestationUid;
  const savedProfile = loadKycProfile(address);

  const explorerContract = protocol
    ? `https://stellar.expert/explorer/testnet/contract/${protocol}`
    : null;

  return (
    <div
      className={`mb-6 rounded-2xl border px-4 py-3.5 ${
        verified
          ? "border-shield/30 bg-shield/[0.06]"
          : "border-surface-border bg-ink-850/50"
      }`}
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span
          className="kicker"
          style={{ color: verified ? "#46d6a6" : "#9aa4b2" }}
        >
          {verified ? <CheckIcon size={13} /> : <ShieldIcon size={13} />}
          On-chain KYC
        </span>

        {verified ? (
          <span className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-semibold text-shield">Attested</span>
            <span className="rounded-md bg-shield/15 px-1.5 py-0.5 text-[11px] font-medium text-shield">
              AttestProtocol
            </span>
            {typeof status?.tier === "number" && (
              <span className="num text-xs text-fg-faint">
                tier {status.tier}
                {typeof status?.country === "number" ? ` · country ${status.country}` : ""}
              </span>
            )}
            {savedProfile && (
              <span className="text-xs text-fg-faint">
                · {savedProfile.firstName} {savedProfile.lastName}
              </span>
            )}
          </span>
        ) : revoked ? (
          <span className="flex items-center gap-2 text-sm text-warn">
            Revoked, verify your identity again to get a fresh attestation
          </span>
        ) : (
          <span className="flex items-center gap-2 text-sm text-fg-muted">
            {config?.configured
              ? "Verify your identity to receive an on-chain attestation"
              : "KYC issuer not configured"}
          </span>
        )}

        <div className="ml-auto flex items-center gap-3">
          {verified && config?.configured && (
            <button
              onClick={revoke}
              disabled={busy}
              className="btn btn-danger-ghost px-3 py-1.5 text-xs disabled:opacity-50"
            >
              {busy ? "Revoking…" : "Revoke"}
            </button>
          )}
          {!verified && config?.configured && !showForm && (
            <button
              onClick={() => setShowForm(true)}
              className="btn btn-ghost px-3 py-1.5 text-xs"
            >
              <ShieldIcon size={14} />
              Verify identity
            </button>
          )}
          {explorerContract && (
            <a
              href={explorerContract}
              target="_blank"
              rel="noreferrer"
              className="num inline-flex items-center gap-1.5 text-xs text-fg-muted transition-colors hover:text-shield"
            >
              Protocol
              <ArrowUpRightIcon size={13} />
            </a>
          )}
        </div>
      </div>

      {!verified && showForm && config?.configured && (
        <div className="mt-4 border-t border-surface-border pt-4">
          <p className="mb-4 text-xs leading-relaxed text-fg-muted">
            Enter your details once. ShadowWire stores them locally and sends them
            to the KYC authority to issue your AttestProtocol credential (tier +
            country on-chain). The same details pre-fill the bank anchor deposit
            form, you won&apos;t type them twice.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <FieldLabel label="First name">
              <input
                type="text"
                value={profile.firstName}
                onChange={(e) => setProfile((p) => ({ ...p, firstName: e.target.value }))}
                className="field"
                autoComplete="given-name"
              />
            </FieldLabel>
            <FieldLabel label="Last name">
              <input
                type="text"
                value={profile.lastName}
                onChange={(e) => setProfile((p) => ({ ...p, lastName: e.target.value }))}
                className="field"
                autoComplete="family-name"
              />
            </FieldLabel>
            <FieldLabel label="Email" hint="also used for SEP-24 anchor">
              <input
                type="email"
                value={profile.email}
                onChange={(e) => setProfile((p) => ({ ...p, email: e.target.value }))}
                className="field sm:col-span-2"
                autoComplete="email"
              />
            </FieldLabel>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              onClick={enroll}
              disabled={busy}
              className="btn btn-primary px-4 py-2 text-xs disabled:opacity-50"
            >
              {busy ? "Issuing attestation…" : "Issue AttestProtocol credential"}
            </button>
            <button
              onClick={() => setShowForm(false)}
              disabled={busy}
              className="btn btn-ghost px-3 py-2 text-xs"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {uid && (
        <p className="num mt-2 text-xs text-fg-faint break-all">
          UID: {uid}
        </p>
      )}
      {error && <p className="mt-2 text-xs text-warn">{error}</p>}
    </div>
  );
}
