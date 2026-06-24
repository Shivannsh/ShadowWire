import Link from "next/link";
import { PrivacyComparison } from "@/components/PrivacyComparison";

export default function HomePage() {
  return (
    <div className="mx-auto max-w-6xl px-6 py-16">
      <section className="mb-20 text-center">
        <p className="mb-4 text-sm font-medium uppercase tracking-widest text-accent">
          ClearPass / ShadowWire
        </p>
        <h1 className="mx-auto max-w-3xl text-4xl font-bold tracking-tight text-slate-50 md:text-5xl">
          Private cross-border remittance on{" "}
          <span className="text-gradient">Stellar</span>
        </h1>
        <p className="mx-auto mt-6 max-w-2xl text-lg text-slate-400">
          Fiat on-ramp via SEP-24 → shielded pool corridor → fiat off-ramp.
          Amounts stay hidden on the public ledger while compliance proofs gate
          each edge.
        </p>
        <div className="mt-10 flex flex-wrap items-center justify-center gap-4">
          <Link
            href="/alice"
            className="rounded-lg bg-accent px-6 py-3 font-medium text-surface shadow-glow transition hover:bg-accent-glow"
          >
            Start as Alice (sender)
          </Link>
          <Link
            href="/bob"
            className="rounded-lg border border-surface-border bg-surface-raised px-6 py-3 font-medium text-slate-200 transition hover:border-accent/50"
          >
            Start as Bob (recipient)
          </Link>
        </div>
      </section>

      <section className="mb-20">
        <h2 className="mb-2 text-center text-2xl font-semibold text-slate-100">
          Why shielded beats transparent
        </h2>
        <p className="mb-8 text-center text-slate-400">
          Same corridor — radically different on-chain footprint
        </p>
        <PrivacyComparison />
      </section>

      <section className="grid gap-6 md:grid-cols-3">
        <FeatureCard
          title="SEP-24 edges"
          body="Real testnet anchor flow at testanchor.stellar.org with SRT — interactive KYC popup, not mocked UI."
        />
        <FeatureCard
          title="Shielded pool"
          body="Note commitments + nullifiers verified on Soroban with Groth16 proofs. Transfer amount never hits the ledger."
        />
        <FeatureCard
          title="Compliance at edges"
          body="ZK compliance proofs at deposit and withdraw — KYC tier, sanctions, and limits without exposing history."
        />
      </section>

      <section className="mt-16 rounded-xl border border-surface-border bg-surface-raised/40 p-8">
        <h3 className="text-lg font-medium text-slate-100">Corridor flow</h3>
        <ol className="mt-4 space-y-3 text-sm text-slate-400">
          <li>
            <strong className="text-accent">1.</strong> Alice deposits fiat →
            receives SRT via SEP-24
          </li>
          <li>
            <strong className="text-accent">2.</strong> Alice shields SRT into
            the pool (compliance proof + note commitment)
          </li>
          <li>
            <strong className="text-accent">3.</strong> Alice sends privately to
            Bob (nullifier + new commitment only on-chain)
          </li>
          <li>
            <strong className="text-accent">4.</strong> Bob claims note and
            withdraws to visible balance
          </li>
          <li>
            <strong className="text-accent">5.</strong> Bob cashes out via
            SEP-24 withdrawal
          </li>
        </ol>
      </section>
    </div>
  );
}

function FeatureCard({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-xl border border-surface-border bg-surface-raised/30 p-6">
      <h3 className="font-medium text-slate-100">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-slate-400">{body}</p>
    </div>
  );
}
