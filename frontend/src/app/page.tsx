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
  LockIcon,
  ZapIcon,
} from "@/components/ui/icons";

const stats = [
  { v: "AttestProtocol", l: "On-chain KYC gate" },
  { v: "Groth16", l: "Zero-knowledge proofs" },
  { v: "SEP-24", l: "Real bank anchors" },
  { v: "Shielded", l: "In-transit privacy" },
];

const pillars = [
  {
    icon: <GlobeIcon size={20} />,
    title: "Real banking rails at the edges",
    body: "Fiat enters and exits through live SEP-24 anchors, the same regulated on/off-ramps Stellar anchors use in production. No mocked deposit screens. Your bank talks to their bank; ShadowWire handles the middle.",
  },
  {
    icon: <LockIcon size={20} />,
    title: "Zero-knowledge shielded pool",
    body: "Between the anchors, funds live in a Soroban shielded pool. Groth16 proofs (Noir → BN254) verify every move on-chain. Transfer amounts, senders, and recipients never hit the public ledger, only nullifiers and note commitments do.",
  },
  {
    icon: <FingerprintIcon size={20} />,
    title: "KYC on every transaction",
    body: "Secured by the trust of AttestProtocol, no deposit or withdrawal clears without a live, revocable on-chain KYC attestation bound to the caller. ZK compliance proofs enforce corridor limits and tier without exposing identity history.",
  },
];

const complianceLayers = [
  {
    n: "01",
    title: "AttestProtocol KYC attestation",
    body: "Every wallet must hold a delegated BLS12-381 attestation on-chain before touching the pool. The contract verifies attester, schema, subject, expiry, revocation, and the exact KYC claim (tier, country). No attestation, no transaction. Period.",
  },
  {
    n: "02",
    title: "Edge compliance ZK proof",
    body: "A Noir circuit proves KYC-tree membership, corridor policy, and amount limits via Groth16, verified on Soroban with BN254 pairing. The proof is cryptographically bound to the attestation UID, so credentials and proofs can't be mixed and matched.",
  },
  {
    n: "03",
    title: "Shielded transfer proof",
    body: "In-pool moves use a separate ZK circuit: note commitments, nullifiers, and Merkle paths. The transfer amount is hidden from block explorers, indexers, and competitors. Only cryptographic hashes appear on-chain.",
  },
  {
    n: "04",
    title: "Operator-signed roots",
    body: "Every new commitment-tree root is signed by the registered operator key, closing the loop so provers can't smuggle invalid state. Four independent layers, all verified on-chain.",
  },
];

const corridor = [
  {
    k: "01",
    t: "Bank on-ramp",
    tags: ["SEP-24", "Anchor KYC", "Fiat → SRT"],
    d: "The sender deposits fiat with a regulated Stellar anchor, real bank rails, real AML screening. The anchor converts to SRT stablecoin and credits the sender's wallet. This is the sending country's regulated edge: the anchor sees the deposit, the public ledger sees a visible balance.",
  },
  {
    k: "02",
    t: "KYC gate + shield",
    tags: ["AttestProtocol", "Groth16", "Note commitment"],
    d: "Before entering the pool, the sender must hold a valid AttestProtocol KYC attestation for the sending corridor edge. A zero-knowledge compliance proof binds to that attestation and the exact deposit amount. Fresh note randomness creates a shielded commitment, funds leave the public ledger.",
  },
  {
    k: "03",
    t: "Private transfer",
    tags: ["ZK transfer proof", "Nullifier", "Hidden amount"],
    d: "Funds move privately to the recipient inside the shielded pool. A Groth16 shielded-transfer proof verifies on Soroban; the chain records only a spent nullifier and a new commitment. No amount, no sender, no recipient, unlinkable from the on-ramp deposit.",
  },
  {
    k: "04",
    t: "Claim + KYC gate",
    tags: ["AttestProtocol", "Spend proof", "Visible balance"],
    d: "The recipient claims the note with a spend proof and passes the receiving-edge AttestProtocol KYC gate, a separate attestation for their jurisdiction. Another ZK compliance proof binds withdrawal limits to their credential. Funds reappear as a visible SRT balance, ready for off-ramp.",
  },
  {
    k: "05",
    t: "Bank off-ramp",
    tags: ["SEP-24", "Anchor KYC", "SRT → Fiat"],
    d: "The recipient withdraws to fiat through the destination anchor's SEP-24 flow, bank account, mobile money, or local payout rail. The receiving country's regulated edge sees the withdrawal amount. The in-transit corridor amount stays hidden forever.",
  },
];

const corridors = [
  { from: "United States", to: "Nigeria", code: "US → NG", status: "Live on testnet", id: 1 },
  { from: "European Union", to: "Kenya", code: "EU → KE", status: "Coming soon", id: null },
  { from: "United Kingdom", to: "India", code: "UK → IN", status: "Coming soon", id: null },
  { from: "Canada", to: "Philippines", code: "CA → PH", status: "Coming soon", id: null },
];

export default function HomePage() {
  return (
    <div className="mx-auto max-w-5xl px-5">
      {/* ---------------- Hero ---------------- */}
      <section className="relative flex min-h-[92vh] flex-col items-center justify-center pb-20 pt-28 text-center">
        <div
          className="pointer-events-none absolute left-1/2 top-24 -z-10 h-[520px] w-[900px] -translate-x-1/2 rounded-full opacity-70 blur-[120px]"
          style={{
            background:
              "radial-gradient(circle, rgba(91,200,236,0.2), rgba(70,214,166,0.08) 45%, transparent 70%)",
          }}
        />
        <Reveal>
          <Kicker icon={<ShieldIcon size={14} className="text-accent" />}>
            Private cross-border remittance on Stellar
          </Kicker>
        </Reveal>

        <Reveal delay={80}>
          <h1 className="display mx-auto mt-6 max-w-4xl text-display-xl text-balance">
            Real banks in.{" "}
            <span className="serif-accent text-gradient">Real banks out.</span>
            <br className="hidden sm:block" />
            {" "}Zero visibility in between.
          </h1>
        </Reveal>

        <Reveal delay={160}>
          <p className="mx-auto mt-7 max-w-2xl text-lg leading-relaxed text-fg-soft text-pretty">
            <strong className="font-semibold text-fg">ShadowWire</strong> is a
            shielded remittance corridor, fiat on-ramp through regulated bank
            anchors, a zero-knowledge pool in the middle, fiat off-ramp at the
            destination. Secured by the trust of{" "}
            <strong className="font-semibold text-shield">AttestProtocol</strong>:
            every transaction is KYC-gated, revocable, and bound to corridor
            policy. Private by design. Compliant by construction.
          </p>
        </Reveal>

        <Reveal delay={240}>
          <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
            <Link href="/sender" className="btn btn-primary px-6 py-3.5 text-[15px]">
              Start sending
              <ArrowRightIcon size={18} />
            </Link>
            <Link href="/recipient" className="btn btn-ghost px-6 py-3.5 text-[15px]">
              Start receiving
            </Link>
          </div>
        </Reveal>

        <Reveal delay={320}>
          <dl className="mt-16 grid w-full max-w-3xl grid-cols-2 gap-px overflow-hidden rounded-2xl border border-surface-border bg-surface-border sm:grid-cols-4">
            {stats.map((s) => (
              <div key={s.l} className="bg-ink-900/80 px-4 py-5">
                <dt className="display text-lg sm:text-xl text-fg">{s.v}</dt>
                <dd className="mt-1 text-xs text-fg-muted">{s.l}</dd>
              </div>
            ))}
          </dl>
        </Reveal>
      </section>

      {/* ---------------- What is ShadowWire ---------------- */}
      <section className="py-20">
        <Reveal>
          <div className="mb-10 max-w-2xl">
            <Kicker>What is ShadowWire?</Kicker>
            <h2 className="display mt-4 text-display-md text-balance">
              The world&apos;s first{" "}
              <span className="serif-accent text-fg-soft">
                ZK-shielded remittance corridor.
              </span>
            </h2>
            <p className="mt-4 text-base leading-relaxed text-fg-muted">
              Cross-border payments today leak everything, sender, recipient,
              amount, memo, to anyone with a block explorer. ShadowWire fixes
              the middle: regulated fiat edges you already trust, plus a
              cryptographic blind spot where transfer amounts and parties vanish
              from the public ledger.
            </p>
          </div>
        </Reveal>

        {/* Architecture flow */}
        <Reveal delay={80}>
          <div className="panel overflow-hidden p-6 sm:p-8">
            <p className="kicker mb-6">End-to-end architecture</p>
            <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-center sm:gap-2">
              {[
                { label: "Sender bank", sub: "Fiat deposit", highlight: false },
                { label: "SEP-24 anchor", sub: "On-ramp KYC", highlight: false },
                { label: "AttestProtocol", sub: "KYC gate", highlight: false },
                { label: "ZK shield", sub: "Groth16 proof", highlight: false },
                { label: "Shielded pool", sub: "Hidden transfer", highlight: true },
                { label: "ZK claim", sub: "Spend proof", highlight: false },
                { label: "AttestProtocol", sub: "KYC gate", highlight: false },
                { label: "SEP-24 anchor", sub: "Off-ramp KYC", highlight: false },
                { label: "Recipient bank", sub: "Fiat payout", highlight: false },
              ].map((node, i, arr) => (
                <span key={node.label + i} className="flex items-center gap-2">
                  <span
                    className={`rounded-xl border px-3 py-2 text-center ${
                      node.highlight
                        ? "border-shield/40 bg-shield/10"
                        : "border-surface-border bg-ink-850/60"
                    }`}
                  >
                    <span className="block text-xs font-semibold text-fg">{node.label}</span>
                    <span className="block text-[10px] text-fg-faint">{node.sub}</span>
                  </span>
                  {i < arr.length - 1 && (
                    <ArrowRightIcon size={14} className="hidden shrink-0 text-fg-faint sm:block" />
                  )}
                </span>
              ))}
            </div>
            <p className="mt-6 text-center text-sm leading-relaxed text-fg-muted">
              Anchors see their own leg. The chain sees nullifiers and commitments.
              <span className="text-fg-soft"> Nobody sees the corridor amount in transit.</span>
            </p>
          </div>
        </Reveal>
      </section>

      {/* ---------------- Three pillars ---------------- */}
      <section className="py-20">
        <Reveal>
          <div className="mb-10 max-w-2xl">
            <Kicker>Three pillars</Kicker>
            <h2 className="display mt-4 text-display-md text-balance">
              Real rails.{" "}
              <span className="serif-accent text-fg-soft">Real privacy.</span>{" "}
              Real compliance.
            </h2>
          </div>
        </Reveal>
        <div className="grid gap-5 md:grid-cols-3">
          {pillars.map((f, i) => (
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

      {/* ---------------- Privacy comparison ---------------- */}
      <section className="py-20">
        <Reveal>
          <div className="mb-10 max-w-2xl">
            <Kicker>The problem we solve</Kicker>
            <h2 className="display mt-4 text-display-md text-balance">
              Today&apos;s remittance is{" "}
              <span className="serif-accent text-fg-soft">naked on-chain.</span>
            </h2>
            <p className="mt-4 text-base leading-relaxed text-fg-muted">
              A standard Stellar payment exposes sender, recipient, amount, and
              memo to the world. ShadowWire replaces the transparent middle with
              a shielded corridor, same bank edges, radically different footprint.
            </p>
          </div>
        </Reveal>
        <Reveal delay={100}>
          <PrivacyComparison />
        </Reveal>
      </section>

      {/* ---------------- Compliance fortress ---------------- */}
      <section className="py-20">
        <Reveal>
          <div className="mb-10 max-w-2xl">
            <Kicker>Compliance fortress</Kicker>
            <h2 className="display mt-4 text-display-md text-balance">
              Four independent layers.{" "}
              <span className="serif-accent text-fg-soft">
                Zero anonymous transactions.
              </span>
            </h2>
            <p className="mt-4 text-base leading-relaxed text-fg-muted">
              Privacy without compliance is a liability. ShadowWire enforces four
              on-chain-verifiable layers, secured by AttestProtocol so no
              transaction clears without KYC, and no proof can be replayed across
              wallets or corridors.
            </p>
          </div>
        </Reveal>
        <div className="grid gap-px overflow-hidden rounded-2xl border border-surface-border bg-surface-border md:grid-cols-2">
          {complianceLayers.map((layer, i) => (
            <Reveal key={layer.n} delay={i * 70}>
              <article className="h-full bg-ink-900/80 p-6">
                <span className="num text-sm font-bold text-accent">{layer.n}</span>
                <h3 className="mt-2 text-base font-semibold text-fg">{layer.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-fg-muted">{layer.body}</p>
              </article>
            </Reveal>
          ))}
        </div>
      </section>

      {/* ---------------- Global corridors ---------------- */}
      <section className="py-20">
        <Reveal>
          <div className="mb-10 max-w-2xl">
            <Kicker>Global corridors</Kicker>
            <h2 className="display mt-4 text-display-md text-balance">
              One protocol.{" "}
              <span className="serif-accent text-fg-soft">
                Many country pairs.
              </span>
            </h2>
            <p className="mt-4 text-base leading-relaxed text-fg-muted">
              Each corridor cryptographically binds a sending jurisdiction to a
              receiving jurisdiction, with its own KYC tier requirements, amount
              limits, and AttestProtocol credentials per edge. Proofs minted for
              one corridor cannot be replayed in another.
            </p>
          </div>
        </Reveal>
        <div className="grid gap-4 sm:grid-cols-2">
          {corridors.map((c, i) => (
            <Reveal key={c.code} delay={i * 60}>
              <div
                className={`panel flex items-center justify-between gap-4 p-5 ${
                  c.id ? "border-shield/20" : "opacity-70"
                }`}
              >
                <div className="flex items-center gap-3">
                  <GlobeIcon size={18} className={c.id ? "text-shield" : "text-fg-faint"} />
                  <div>
                    <p className="text-sm font-semibold text-fg">
                      {c.from}{" "}
                      <span className="text-fg-faint">→</span>{" "}
                      {c.to}
                    </p>
                    <p className="num text-xs text-fg-faint">{c.code}</p>
                  </div>
                </div>
                <span
                  className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold ${
                    c.id
                      ? "bg-shield/15 text-shield"
                      : "bg-surface-raised text-fg-faint"
                  }`}
                >
                  {c.status}
                </span>
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      {/* ---------------- Corridor flow ---------------- */}
      <section className="pb-20 pt-10">
        <Reveal>
          <div className="mb-12 max-w-2xl">
            <div className="mb-3 flex items-center gap-3">
              <RouteIcon size={20} className="text-shield" />
              <Kicker>How it works</Kicker>
            </div>
            <h2 className="display text-display-md text-balance">
              The five-step corridor
            </h2>
            <p className="mt-4 text-base leading-relaxed text-fg-muted">
              From bank deposit to bank payout, every step is either a regulated
              fiat edge or a zero-knowledge proof verified on Soroban. Walk it
              live on Stellar testnet.
            </p>
          </div>
        </Reveal>
        <ol className="grid gap-px overflow-hidden rounded-2xl border border-surface-border bg-surface-border">
          {corridor.map((step, i) => (
            <Reveal as="li" key={step.k} delay={i * 60}>
              <div className="group flex flex-col gap-4 bg-ink-900/80 px-6 py-7 transition-colors hover:bg-ink-850">
                <div className="flex flex-col gap-4 sm:grid sm:grid-cols-[72px_200px_1fr] sm:items-start sm:gap-6">
                  <span className="num text-sm font-bold text-accent">{step.k}</span>
                  <h3 className="text-lg font-semibold tracking-tight text-fg">
                    {step.t}
                  </h3>
                  <p className="text-sm leading-relaxed text-fg-muted">{step.d}</p>
                </div>
                <div className="flex flex-wrap gap-2 sm:pl-[calc(72px+1.5rem)]">
                  {step.tags.map((tag) => (
                    <span
                      key={tag}
                      className="rounded-md border border-surface-border bg-surface-raised px-2 py-0.5 text-[11px] font-medium text-fg-soft"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              </div>
            </Reveal>
          ))}
        </ol>
      </section>

      {/* ---------------- Built on ---------------- */}
      <section className="py-20">
        <Reveal>
          <div className="mb-10 max-w-2xl">
            <Kicker>Built on</Kicker>
            <h2 className="display mt-4 text-display-md text-balance">
              Production-grade{" "}
              <span className="serif-accent text-fg-soft">ZK infrastructure.</span>
            </h2>
          </div>
        </Reveal>
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {[
            {
              icon: <LayersIcon size={20} />,
              title: "Noir → Groth16 on Soroban",
              body: "Compliance and shielded-transfer circuits compiled to Groth16, verified on-chain via BN254 pairing_check, Protocol 25/26 host functions.",
            },
            {
              icon: <ZapIcon size={20} />,
              title: "Live SEP-24 anchors",
              body: "Interactive fiat on/off-ramp against the Stellar testnet anchor with SRT, real KYC flows, not a mocked screen.",
            },
            {
              icon: <ShieldIcon size={20} />,
              title: "AttestProtocol credentials",
              body: "Delegated BLS12-381 attestations with on-chain revocation. The pool cross-contract-verifies every credential before moving a single token.",
            },
          ].map((f, i) => (
            <Reveal key={f.title} delay={i * 90}>
              <article className="panel panel-hover h-full p-6">
                <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-shield/25 bg-shield/10 text-shield">
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

      {/* ---------------- CTA ---------------- */}
      <section className="pb-32">
        <Reveal delay={120}>
          <div className="relative overflow-hidden rounded-2xl border border-surface-border bg-gradient-to-br from-accent/[0.09] via-ink-900/80 to-shield/[0.06] px-7 py-10 sm:px-10">
            <div
              className="pointer-events-none absolute -right-20 -top-20 h-56 w-56 rounded-full opacity-40 blur-3xl"
              style={{ background: "radial-gradient(circle,rgba(70,214,166,0.3),transparent 70%)" }}
            />
            <div className="relative flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
              <div className="max-w-lg">
                <h3 className="display text-2xl text-fg">
                  Try the corridor.{" "}
                  <span className="serif-accent text-fg-soft">Right now.</span>
                </h3>
                <p className="mt-3 text-sm leading-relaxed text-fg-muted">
                  Connect Freighter, get your AttestProtocol KYC attestation, and
                  walk the full US → Nigeria remittance flow on Stellar testnet,
                  bank on-ramp, ZK shield, private transfer, bank off-ramp.
                </p>
              </div>
              <div className="flex shrink-0 flex-col gap-3 sm:items-end">
                <Link href="/sender" className="btn btn-primary px-6 py-3.5">
                  Start sending
                  <ArrowRightIcon size={18} />
                </Link>
                <Link href="/recipient" className="btn btn-ghost px-5 py-3">
                  Start receiving
                </Link>
              </div>
            </div>
          </div>
        </Reveal>

        <Reveal delay={180}>
          <footer className="mt-16 flex flex-col items-center gap-3 border-t border-surface-border pt-10 text-center">
            <p className="display text-lg text-fg-soft">ShadowWire</p>
            <p className="max-w-md text-xs leading-relaxed text-fg-faint">
              Private cross-border settlement on Stellar · Built for Stellar Hacks:
              Real-World ZK · AttestProtocol · Groth16 · SEP-24
            </p>
          </footer>
        </Reveal>
      </section>
    </div>
  );
}
