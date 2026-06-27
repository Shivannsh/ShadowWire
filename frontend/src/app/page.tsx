import Link from "next/link";
import { PrivacyComparison } from "@/components/PrivacyComparison";
import { Reveal } from "@/components/ui/Reveal";
import { Kicker } from "@/components/ui/primitives";
import {
  ArrowRightIcon,
  ShieldIcon,
  RouteIcon,
  LayersIcon,
  FingerprintIcon,
  GlobeIcon,
} from "@/components/ui/icons";

const features = [
  {
    icon: <GlobeIcon size={20} />,
    title: "Real anchor edges",
    body: "Live SEP-24 on/off-ramp against the Stellar testnet anchor with SRT — interactive KYC, not a mocked screen.",
  },
  {
    icon: <LayersIcon size={20} />,
    title: "Shielded pool",
    body: "Note commitments and nullifiers verified on Soroban with Groth16 proofs. The transfer amount never reaches the ledger.",
  },
  {
    icon: <FingerprintIcon size={20} />,
    title: "Compliance at the edges",
    body: "Zero-knowledge proofs gate deposit and withdrawal — KYC tier, sanctions, and limits, without exposing history.",
  },
];

const corridor = [
  { k: "01", t: "On-ramp", d: "Buyer deposits fiat and receives SRT through SEP-24." },
  { k: "02", t: "Shield", d: "Buyer shields SRT into the pool with a compliance proof and a fresh note commitment." },
  { k: "03", t: "Transfer", d: "Funds move privately to the Seller — only a nullifier and new commitment hit the chain." },
  { k: "04", t: "Claim", d: "Seller claims the note and withdraws to a visible balance with a spend proof." },
  { k: "05", t: "Off-ramp", d: "Seller cashes out to fiat through a SEP-24 withdrawal." },
];

export default function HomePage() {
  return (
    <div className="mx-auto max-w-5xl px-5">
      {/* ---------------- Hero ---------------- */}
      <section className="relative flex min-h-[88vh] flex-col items-center justify-center pb-16 pt-28 text-center">
        <div
          className="pointer-events-none absolute left-1/2 top-24 -z-10 h-[460px] w-[820px] -translate-x-1/2 rounded-full opacity-70 blur-[120px]"
          style={{
            background:
              "radial-gradient(circle, rgba(91,200,236,0.18), rgba(70,214,166,0.07) 45%, transparent 70%)",
          }}
        />
        <Reveal>
          <Kicker icon={<ShieldIcon size={14} className="text-accent" />}>
            Private settlement infrastructure
          </Kicker>
        </Reveal>

        <Reveal delay={80}>
          <h1 className="display mx-auto mt-6 max-w-3xl text-display-xl text-balance">
            Move money across borders,{" "}
            <span className="serif-accent text-gradient">in the shadows.</span>
          </h1>
        </Reveal>

        <Reveal delay={160}>
          <p className="mx-auto mt-7 max-w-xl text-lg leading-relaxed text-fg-soft text-pretty">
            A shielded corridor on Stellar. Fiat on-ramp, a private pool, and
            compliance proofs at every edge — so amounts stay hidden on the
            public ledger while every transfer remains provably legitimate.
          </p>
        </Reveal>

        <Reveal delay={240}>
          <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
            <Link href="/alice" className="btn btn-primary px-6 py-3.5 text-[15px]">
              Send as Buyer
              <ArrowRightIcon size={18} />
            </Link>
            <Link href="/bob" className="btn btn-ghost px-6 py-3.5 text-[15px]">
              Receive as Seller
            </Link>
          </div>
        </Reveal>

        <Reveal delay={320}>
          <dl className="mt-16 grid w-full max-w-2xl grid-cols-3 gap-px overflow-hidden rounded-2xl border border-surface-border bg-surface-border">
            {[
              { v: "Groth16", l: "On-chain proofs" },
              { v: "SEP-24", l: "Live anchor edges" },
              { v: "Zero", l: "Amounts on ledger" },
            ].map((s) => (
              <div key={s.l} className="bg-ink-900/80 px-4 py-5">
                <dt className="display text-2xl text-fg">{s.v}</dt>
                <dd className="mt-1 text-xs text-fg-muted">{s.l}</dd>
              </div>
            ))}
          </dl>
        </Reveal>
      </section>

      {/* ---------------- Privacy comparison ---------------- */}
      <section className="py-20">
        <Reveal>
          <div className="mb-10 max-w-2xl">
            <Kicker>The difference</Kicker>
            <h2 className="display mt-4 text-display-md text-balance">
              The same corridor.{" "}
              <span className="serif-accent text-fg-soft">
                A radically different footprint.
              </span>
            </h2>
          </div>
        </Reveal>
        <Reveal delay={100}>
          <PrivacyComparison />
        </Reveal>
      </section>

      {/* ---------------- Features ---------------- */}
      <section className="py-20">
        <Reveal>
          <div className="mb-10 max-w-2xl">
            <Kicker>How it holds up</Kicker>
            <h2 className="display mt-4 text-display-md text-balance">
              Built for privacy{" "}
              <span className="serif-accent text-fg-soft">and</span> compliance.
            </h2>
          </div>
        </Reveal>
        <div className="grid gap-5 md:grid-cols-3">
          {features.map((f, i) => (
            <Reveal key={f.title} delay={i * 90}>
              <article className="panel panel-hover h-full p-6">
                <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-accent/25 bg-accent/10 text-accent">
                  {f.icon}
                </div>
                <h3 className="mt-5 text-base font-semibold tracking-tight text-fg">
                  {f.title}
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-fg-muted">
                  {f.body}
                </p>
              </article>
            </Reveal>
          ))}
        </div>
      </section>

      {/* ---------------- Corridor flow ---------------- */}
      <section className="pb-28 pt-20">
        <Reveal>
          <div className="mb-12 flex items-center gap-3">
            <RouteIcon size={20} className="text-shield" />
            <h2 className="display text-display-md">The corridor</h2>
          </div>
        </Reveal>
        <ol className="grid gap-px overflow-hidden rounded-2xl border border-surface-border bg-surface-border">
          {corridor.map((step, i) => (
            <Reveal as="li" key={step.k} delay={i * 60}>
              <div className="group flex flex-col gap-3 bg-ink-900/80 px-6 py-7 transition-colors hover:bg-ink-850 sm:grid sm:grid-cols-[80px_180px_1fr] sm:items-center sm:gap-6">
                <span className="num text-sm font-bold text-accent">{step.k}</span>
                <h3 className="text-lg font-semibold tracking-tight text-fg">
                  {step.t}
                </h3>
                <p className="text-sm leading-relaxed text-fg-muted">{step.d}</p>
              </div>
            </Reveal>
          ))}
        </ol>

        <Reveal delay={120}>
          <div className="mt-10 flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-surface-border bg-gradient-to-br from-accent/[0.07] to-shield/[0.04] px-7 py-6">
            <div>
              <h3 className="text-lg font-semibold text-fg">Ready to try the corridor?</h3>
              <p className="mt-1 text-sm text-fg-muted">
                Walk the full flow end to end on Stellar testnet.
              </p>
            </div>
            <Link href="/alice" className="btn btn-primary px-5 py-3">
              Start as Buyer
              <ArrowRightIcon size={18} />
            </Link>
          </div>
        </Reveal>
      </section>
    </div>
  );
}
