"use client";

import { useCallback, useEffect, useState } from "react";
import {
  POOL_KYC_ATTEST,
  getKycConfig,
  getKycStatus,
  enrollKyc,
  type KycConfig,
  type KycStatus,
  type KycSide,
} from "@/lib/kyc";
import { ShieldIcon, CheckIcon, ArrowUpRightIcon } from "@/components/ui/icons";

/**
 * On-chain KYC attestation badge (AttestProtocol, Tier C).
 *
 * Shows whether the connected wallet holds a valid, verifiable attestation that
 * the ShieldedPool checks on-chain during deposit/withdraw. Lets the user issue
 * one (delegated attestation by the KYC authority) and links to the live
 * attestation record on stellar.expert.
 */
export function KycBadge({
  address,
  side,
  onStatus,
}: {
  address: string;
  side: KycSide;
  onStatus?: (msg: string) => void;
}) {
  const [config, setConfig] = useState<KycConfig | null>(null);
  const [status, setStatus] = useState<KycStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [cfg, st] = await Promise.all([getKycConfig(), getKycStatus(address)]);
      setConfig(cfg);
      setStatus(st);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not reach KYC issuer");
    }
  }, [address]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const enroll = async () => {
    setBusy(true);
    setError(null);
    try {
      onStatus?.("Issuing on-chain KYC attestation (AttestProtocol)…");
      const r = await enrollKyc(address, side);
      onStatus?.(`KYC attested on-chain: ${r.attestationUid.slice(0, 16)}…`);
      await refresh();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "KYC enrollment failed";
      setError(msg);
      onStatus?.(msg);
    } finally {
      setBusy(false);
    }
  };

  // If the active pool doesn't enforce on-chain KYC and the issuer isn't
  // configured, don't clutter the UI.
  if (!POOL_KYC_ATTEST && !config?.configured) return null;

  const verified = !!status?.verified;
  const protocol = config?.protocol;
  const uid = status?.attestationUid;

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
          </span>
        ) : (
          <span className="flex items-center gap-2 text-sm text-fg-muted">
            {config?.configured
              ? "No attestation yet — the pool will reject deposit/withdraw"
              : "KYC issuer not configured"}
          </span>
        )}

        <div className="ml-auto flex items-center gap-3">
          {!verified && config?.configured && (
            <button
              onClick={enroll}
              disabled={busy}
              className="btn btn-ghost px-3 py-1.5 text-xs disabled:opacity-50"
            >
              <ShieldIcon size={14} />
              {busy ? "Attesting…" : "Get KYC attestation"}
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

      {uid && (
        <p className="num mt-2 text-xs text-fg-faint break-all">
          UID: {uid}
        </p>
      )}
      {error && <p className="mt-2 text-xs text-warn">{error}</p>}
    </div>
  );
}
