# ShadowWire

**Private cross-border remittance corridor on Stellar** — fiat on-ramp → shielded transfer → fiat off-ramp, with transfer amounts kept off the public ledger inside the shielded pool (revealed only at the regulated fiat edges, by AML design) and compliance proofs at every edge.

Built for [Stellar Hacks: Real-World ZK](https://dorahacks.io/hackathon/stellar-hacks-zk) (DoraHacks).

## One-liner (hackathon language)

ShadowWire uses Stellar's real payment rails at the edges (SEP-24 testnet anchors) and a ZK shielded pool in the middle so remittance amounts and parties are hidden from public ledger observers — **real-world payment rails, made confidential.**

## Architecture

```
SEP-24 deposit (Alice) → visible balance → compliance ZK proof → ShieldedPool.deposit()
    → ShieldedPool.transfer() [amount hidden on-chain via Groth16]
    → ShieldedPool.withdraw() → visible balance → SEP-24 withdrawal (Bob)
```

### Components

| Layer | Technology |
|-------|------------|
| Edge compliance | `circuits/compliance` — Noir → Groth16 (BN254) |
| Corridor privacy | `circuits/shielded_transfer` — note commitments + nullifiers |
| On-chain verify | `compliance_verifier`, `shielded_transfer_verifier` — Soroban BN254 `pairing_check` |
| On-chain KYC | **AttestProtocol** — delegated (BLS12-381) attestations verified cross-contract by the pool |
| Pool | `shielded_pool` — SAC custody, nullifier set, commitment tree root, KYC gate |
| Registry | `compliance_registry` — attribute Merkle root |
| Fiat edges | SEP-24 via `testanchor.stellar.org` (SRT) |
| Demo UI | Next.js + Freighter (`frontend/`) |

### Compliance: three layers (honest)

ShadowWire enforces compliance with three independent, on-chain-verifiable layers — no hardcoded KYC flags:

1. **On-chain KYC attestation (AttestProtocol, Tier C).** The mock-issuer acts as a real KYC *authority*: it issues **delegated** attestations (signed off-chain with a BLS12-381 key registered on-chain) about a wallet under a registered KYC schema. On `deposit()` and `withdraw()` the `shielded_pool` performs a **cross-contract `get_attestation()` call into AttestProtocol** and enforces every binding: the attestation exists, its `attester` is the trusted authority, its `schema_uid` matches, its `subject` is the authenticated caller, it is not revoked, and it has not expired. A user cannot present someone else's attestation (subject is bound to the caller), and a self-issued one is rejected (attester is pinned).
2. **Edge compliance ZK proof (Groth16/BN254).** A Noir circuit proves KYC-tree membership + corridor/amount limits without revealing the underlying attributes; the proof is verified on-chain via `pairing_check`. Its `amount` signal is bound to the actual deposit/withdraw amount.
3. **Operator-signed Merkle roots (ed25519).** Every new commitment-tree root must be signed by the registered operator key, closing the prover-supplied-root vulnerability (the contract cannot recompute a Poseidon tree on-chain today).

The pool that wires all three together is **v10** (`scripts/deploy-pool-v10.mjs`). v9 (operator-signed roots, no on-chain KYC) remains deployable as a rollback.

### Proof pipeline

```
Noir (.nr) → nargo compile → noir-cli (R1CS) → snarkjs groth16 → encode_bn254_for_soroban.mjs → Soroban verify()
```

## Privacy model (honest)

- **Hidden from public Stellar ledger / chain indexers:** transfer amount, sender identity, recipient identity during the shielded corridor phase.
- **Known to on-ramp anchor:** Alice deposited some amount (unavoidable with real banking/AML).
- **Known to off-ramp anchor:** Bob withdrew some amount.
- **Not linkable on-chain:** Alice's deposit to Bob's withdrawal as a pair; corridor amount in transit.
- **KYC attestation tradeoff:** the AttestProtocol attestation (Tier C) is a *public* on-chain record that a wallet is KYC-verified by the authority. It links a wallet to its KYC status (by design — that is what makes it verifiable on-chain), but it does **not** reveal the corridor amount or link a deposit to a withdrawal. The ZK compliance proof remains the privacy-preserving layer for attributes; AttestProtocol is the public, revocable credential layer.

## Testnet deployment

See [`testnet-addresses.json`](testnet-addresses.json) for live contract IDs and transaction hashes.

| Contract | Testnet ID |
|----------|------------|
| ComplianceRegistry | `CCILBECK36TSTIL5JWODSFJJLTBWXPPRWN6IW5C56NFSOLESEEAVIR7Z` |
| ComplianceVerifier | `CAZZEALQBXYDW7RPHDHWJ6OYZS7TP2AH256RKZO6X6CQRFDY2LCHD4HL` |
| ShieldedTransferVerifier | `CDUKVBXXZZQM4XP6FK73NWCVWUIDP3RXBWLJWDDWCTANQ54NL7NGEGHS` |
| AttestProtocol (KYC) | `CA4NFQKEJGSCLZ5KTIGAAK3KCUH3QHMHSQJNJ73MCDVB44ZRM7IQLSGP` |
| ShieldedPool (v10) | `CASPUQV5TZFUKR6YYXAQXEO43CGRUNLFZUUCQHHIQV6RDTZJEEY5QVZW` |

**Evidence txs:**
- Pipeline Groth16 on-chain verify: `4d4551751ac6ffa3d072cd2926e27893ae32dee1edc5323756d2a75519603a58`
- Compliance proof verify: `59f013d64676fab0fc1bd52dd56f9fec9bc1e351922dc0694d709b921eb7e4f7`
- Shielded transfer (amount hidden): `a32e0bf05aa2f51c7eb4a55e57d819d40b57f5c8ddc88e0aeb486c6751b66a66`
- AttestProtocol deploy: `5fb387d64bc26eea42aa96d55e6c36b5d3b001af6536eb7a19b4f3cb4fba1ada`
- KYC schema register: `5a282b1ac83b34ec5ecae82e75f1f08fb871c3261d02686067c2f8f4fdcc58ee`
- KYC authority BLS key register: `bd97f3d6dba74e9ee4b1d5c7c6036afa3c315d81c4493b76c202f6933535accf`
- Pool v10 deploy (KYC-gated): `85add528df0461db1f4e20ca5ea337a786df59f6d452611b3095b4ff27f09117`
- Delegated KYC attestation — Alice (`send`, US/840): `1994434caf03d3d909a05dc07ea1f8092ccd95f2642e74b02f2336da7e41f8a6`
  (UID `e2f2a887130f330d7c8f6c123f97fe988588761f9ea0acd3ffbbf2a065c369b6`)
- Delegated KYC attestation — Bob (`receive`, NG/566): `58f29fb13a11a02af579f1489d334ebd0b654c768fba57e8449744e809227459`
  (UID `89edbd6ddff434709a8fbeaf2d088517c635564a04be3dfa84c39f2a41af9467`)

**On-chain KYC verification status (honest):** the pool's cross-contract `get_attestation`
gate is verified working on testnet — a `deposit()` against pool v10 successfully
reads Alice's attestation from AttestProtocol, accepts it, and proceeds through the
compliance Groth16 `verify` (returns `true`). The CLI corridor self-test then stops at
the SRT SAC transfer because the (reset) testnet account holds no `SRT` trustline/balance;
SRT is obtained through the SEP-24 testanchor browser flow (the frontend adds the trustline
and deposits automatically). Re-run `RUN_SELFTEST=1 node scripts/deploy-pool-v10.mjs` after
funding `alice`/`bob` with SRT to capture a fully-green deposit/transfer/withdraw.

### Protocol 25/26 host functions used

- `env.crypto().bn254().pairing_check` — Groth16 verification (CAP-0074 BN254)
- `env.crypto().bn254().g1_mul`, `g1_add` — verification key accumulation
- `std::hash::poseidon2_permutation` in Noir circuits (CAP-0075 Poseidon family)

## Quick start

### 1. Install tools

```bash
bash scripts/install-tools.sh
export PATH="$PWD/.tools:$PATH"
```

Requires: Rust, Node 20+, Stellar CLI, nargo 1.0.0-beta.19 (bundled in `.tools/`).

### 2. Fund testnet accounts

```bash
bash scripts/fund-accounts.sh
```

### 3. Deploy contracts (or use existing addresses in testnet-addresses.json)

```bash
bash scripts/deploy.sh
```

### 4. Run mock KYC issuer

```bash
cd mock-issuer && npm install && npm start
```

The issuer also exposes the AttestProtocol KYC authority endpoints:

```
GET  /api/kyc/config            # protocol id, authority, schema, BLS pubkey
GET  /api/kyc/status?address=G… # { verified, attestationUid, … }
POST /api/kyc/enroll { address, side }   # issues a delegated KYC attestation
```

### 4b. Deploy AttestProtocol + KYC-gated pool (v10)

```bash
# 1) Deploy + initialize AttestProtocol and register the KYC schema (once)
node scripts/deploy-attest-protocol.mjs
# 2) Register the issuer's BLS key for the KYC authority (deployer signs, once)
node scripts/register-kyc-bls.mjs
# 3) Deploy pool v10 (on-chain KYC gate) and run the full corridor self-test
RUN_SELFTEST=1 node scripts/deploy-pool-v10.mjs
```

Then set `NEXT_PUBLIC_POOL_KYC_ATTEST=true` in the frontend env so the UI enrolls
wallets and threads the attestation UID into deposit/withdraw.

### 5. Run frontend

```bash
cd frontend && npm install && cp .env.example .env && npm run dev
```

Open http://localhost:3000 — Alice/Bob flows with Freighter on testnet.

### 6. Run on-chain corridor demo (CLI)

```bash
bash scripts/corridor-e2e.sh   # deposit + shielded transfer on testnet
bash scripts/run-demo.sh       # verify both circuits on-chain
```

```bash
bash scripts/run-circuit.sh circuits/pipeline_test   # de-risk
bash scripts/run-circuit.sh circuits/compliance
PTAU_POWER=15 bash scripts/run-circuit.sh circuits/shielded_transfer
```

## Demo script (video)

1. Show normal Stellar payment in explorer (amount visible).
2. Alice: SEP-24 deposit popup → shield funds (compliance proof tx) → private transfer (no amount in tx args).
3. Bob: claim note → withdraw → SEP-24 withdrawal popup.
4. Return to ShadowWire comparison view.

## Human steps required

See **[HUMAN_ACTION_REQUIRED.md](HUMAN_ACTION_REQUIRED.md)** for the full checklist (Freighter, SEP-24 popups, demo video, DoraHacks submit).

## Project structure

```
circuits/          # Noir ZK circuits
contracts/         # Soroban (Rust)
frontend/          # Next.js demo
mock-issuer/       # KYC attestation API
scripts/           # Pipeline, deploy, fund
testnet-addresses.json
```

## References

- [Noir-Groth16 backend](https://github.com/jamesbachini/Noir-Groth16) (pipeline reference)
- [SDF Groth16 verifier example](https://github.com/stellar/soroban-examples/tree/main/groth16_verifier)
- [SEP-24 demo wallet](https://github.com/stellar/stellar-demo-wallet)
- [testanchor.stellar.org](https://testanchor.stellar.org)

## License

MIT
