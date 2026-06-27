import { EyeOffIcon, ShieldIcon } from "./ui/icons";

export function PrivacyComparison() {
  return (
    <div className="grid gap-5 md:grid-cols-2">
      {/* Transparent — exposed */}
      <div className="panel relative overflow-hidden p-6">
        <div
          className="pointer-events-none absolute inset-x-0 top-0 h-px"
          style={{ background: "linear-gradient(90deg,transparent,rgba(255,111,99,0.5),transparent)" }}
        />
        <div className="mb-5 flex items-center justify-between">
          <span className="pill" style={{ ["--pill" as string]: "#ff6f63" }}>
            <span className="dot" style={{ background: "#ff6f63" }} />
            Transparent
          </span>
          <span className="text-xs text-fg-muted">Classic Stellar payment</span>
        </div>
        <div className="space-y-px">
          <Row label="From" value="GCKF…BUYER" tone="exposed" />
          <Row label="To" value="GCKF…SELLER" tone="exposed" />
          <Row label="Amount" value="250.00 SRT" tone="exposed" highlight />
          <Row label="Memo" value="invoice #4471" tone="exposed" last />
        </div>
        <p className="mt-5 flex items-start gap-2 text-xs leading-relaxed text-fg-faint">
          <span className="mt-0.5 text-danger">
            <EyeOffIcon size={14} />
          </span>
          Readable by anyone with a block explorer — competitors, indexers, and
          counterparties alike.
        </p>
      </div>

      {/* Shielded — calm */}
      <div className="panel relative overflow-hidden p-6">
        <div
          className="pointer-events-none absolute inset-x-0 top-0 h-px"
          style={{ background: "linear-gradient(90deg,transparent,rgba(70,214,166,0.55),transparent)" }}
        />
        <div
          className="pointer-events-none absolute -right-16 -top-16 h-40 w-40 rounded-full opacity-50 blur-3xl"
          style={{ background: "radial-gradient(circle,rgba(70,214,166,0.25),transparent 70%)" }}
        />
        <div className="mb-5 flex items-center justify-between">
          <span className="pill" style={{ ["--pill" as string]: "#46d6a6" }}>
            <span className="dot" style={{ background: "#46d6a6" }} />
            Shielded
          </span>
          <span className="text-xs text-fg-muted">ShadowWire corridor</span>
        </div>
        <div className="space-y-px">
          <Row label="From" value="—" tone="hidden" />
          <Row label="To" value="—" tone="hidden" />
          <Row label="Amount" value="████████" tone="hidden" highlight />
          <Row label="Nullifier" value="0x7f3a…9c2e" tone="shielded" />
          <Row label="Commitment" value="0xb41d…e801" tone="shielded" last />
        </div>
        <p className="mt-5 flex items-start gap-2 text-xs leading-relaxed text-fg-faint">
          <span className="mt-0.5 text-shield">
            <ShieldIcon size={14} />
          </span>
          Amounts and parties never touch the ledger. Anchors see only their own
          fiat leg.
        </p>
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  tone,
  highlight,
  last,
}: {
  label: string;
  value: string;
  tone: "exposed" | "hidden" | "shielded";
  highlight?: boolean;
  last?: boolean;
}) {
  let valueClass = "text-fg-soft";
  if (tone === "exposed") valueClass = "text-danger/90";
  if (tone === "hidden") valueClass = "select-none text-fg-faint blur-[3px]";
  if (tone === "shielded") valueClass = "text-shield";
  if (highlight) valueClass += " font-semibold";

  return (
    <div
      className={`flex items-center justify-between gap-4 py-2.5 ${
        last ? "" : "border-b border-surface-border"
      }`}
    >
      <span className="font-mono text-[11px] uppercase tracking-wider text-fg-faint">
        {label}
      </span>
      <span className={`num text-sm ${valueClass}`}>{value}</span>
    </div>
  );
}
