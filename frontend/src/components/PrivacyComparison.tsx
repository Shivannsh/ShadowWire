export function PrivacyComparison() {
  return (
    <div className="grid gap-6 md:grid-cols-2">
      <div className="rounded-xl border border-red-500/30 bg-red-950/20 p-6">
        <div className="mb-4 flex items-center gap-2">
          <span className="rounded bg-red-500/20 px-2 py-0.5 text-xs font-medium text-red-300">
            Transparent
          </span>
          <span className="text-sm text-slate-400">Classic Stellar payment</span>
        </div>
        <div className="space-y-3 font-mono text-sm">
          <Row label="From" value="GCKF…ALICE" exposed />
          <Row label="To" value="GCKF…BOB" exposed />
          <Row label="Amount" value="250.00 SRT" exposed highlight />
          <Row label="Memo" value="rent june" exposed />
        </div>
        <p className="mt-4 text-xs text-slate-500">
          Visible to anyone with a block explorer — competitors, indexers, observers.
        </p>
      </div>

      <div className="rounded-xl border border-shield/40 bg-shield/5 p-6 shadow-shield">
        <div className="mb-4 flex items-center gap-2">
          <span className="rounded bg-shield/20 px-2 py-0.5 text-xs font-medium text-shield">
            Shielded
          </span>
          <span className="text-sm text-slate-400">ShadowWire corridor</span>
        </div>
        <div className="space-y-3 font-mono text-sm">
          <Row label="From" value="—" hidden />
          <Row label="To" value="—" hidden />
          <Row label="Amount" value="████████" hidden highlight />
          <Row label="Nullifier" value="0x7f3a…9c2e" shielded />
          <Row label="New commitment" value="0xb41d…e801" shielded />
        </div>
        <p className="mt-4 text-xs text-slate-500">
          Amount and parties hidden on-chain. Anchors see only their own fiat leg.
        </p>
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  exposed,
  hidden,
  shielded,
  highlight,
}: {
  label: string;
  value: string;
  exposed?: boolean;
  hidden?: boolean;
  shielded?: boolean;
  highlight?: boolean;
}) {
  let valueClass = "text-slate-300";
  if (exposed) valueClass = "text-red-300";
  if (hidden) valueClass = "text-slate-600 blur-[2px] select-none";
  if (shielded) valueClass = "text-shield";
  if (highlight) valueClass += " font-semibold";

  return (
    <div className="flex items-center justify-between gap-4 border-b border-surface-border/40 pb-2">
      <span className="text-slate-500">{label}</span>
      <span className={valueClass}>{value}</span>
    </div>
  );
}
