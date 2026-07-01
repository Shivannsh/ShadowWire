"use client";

import { useEffect, useState } from "react";
import { loadCorridor, type CorridorInfo } from "@/lib/proofs";
import { GlobeIcon, ArrowRightIcon } from "@/components/ui/icons";

/**
 * Shows the active cross-border lane (sending -> receiving jurisdiction).
 *
 * When the issuer runs with per-user KYC (kycMode === "registry") the two sides
 * carry distinct, KYC-bound jurisdictions, so we show the real corridor. In demo
 * mode the proofs use a single shared jurisdiction, so we say so rather than
 * implying a cross-border binding that isn't cryptographically enforced.
 */
export function CorridorBanner() {
  const [corridor, setCorridor] = useState<CorridorInfo | null>(null);

  useEffect(() => {
    loadCorridor().then(setCorridor).catch(() => setCorridor(null));
  }, []);

  if (!corridor) return null;

  const isRegistry = corridor.kycMode === "registry";

  return (
    <div className="mb-6 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl border border-surface-border bg-ink-850/50 px-4 py-3">
      <span className="kicker" style={{ color: "#5bc8ec" }}>
        <GlobeIcon size={13} />
        Cross-border corridor
      </span>
      {isRegistry ? (
        <span className="flex items-center gap-2 text-sm">
          <span className="font-semibold text-fg">{corridor.sending.country}</span>
          <ArrowRightIcon size={14} className="text-fg-faint" />
          <span className="font-semibold text-fg">{corridor.receiving.country}</span>
          <span className="ml-1 rounded-md bg-shield/15 px-1.5 py-0.5 text-[11px] font-medium text-shield">
            AttestProtocol KYC per edge
          </span>
        </span>
      ) : (
        <span className="flex items-center gap-2 text-sm text-fg-muted">
          Demo KYC, single shared jurisdiction
          <span className="rounded-md bg-warn/15 px-1.5 py-0.5 text-[11px] font-medium text-warn">
            set KYC_MODE=registry for cross-border
          </span>
        </span>
      )}
      <span className="ml-auto num text-xs text-fg-faint">
        min tier {corridor.minKycTier} · max {corridor.maxAmount}
      </span>
    </div>
  );
}
