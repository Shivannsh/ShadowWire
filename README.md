# ShadowWire

**Private cross-border remittance corridor on Stellar** — fiat on-ramp → shielded transfer → fiat off-ramp, with amounts private throughout the corridor and compliance proofs at the edges.

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
| Pool | `shielded_pool` — SAC custody, nullifier set, commitment tree root |
| Registry | `compliance_registry` — attribute Merkle root |
| Fiat edges | SEP-24 via `testanchor.stellar.org` (SRT) |
| Demo UI | Next.js + Freighter (`frontend/`) |

### Proof pipeline

```
Noir (.nr) → nargo compile → noir-cli (R1CS) → snarkjs groth16 → encode_bn254_for_soroban.mjs → Soroban verify()
```

## Privacy model (honest)

- **Hidden from public Stellar ledger / chain indexers:** transfer amount, sender identity, recipient identity during the shielded corridor phase.
- **Known to on-ramp anchor:** Alice deposited some amount (unavoidable with real banking/AML).
- **Known to off-ramp anchor:** Bob withdrew some amount.
- **Not linkable on-chain:** Alice's deposit to Bob's withdrawal as a pair; corridor amount in transit.

## Testnet deployment

See [`testnet-addresses.json`](testnet-addresses.json) for live contract IDs and transaction hashes.

| Contract | Testnet ID |
|----------|------------|
| ComplianceRegistry | `CCILBECK36TSTIL5JWODSFJJLTBWXPPRWN6IW5C56NFSOLESEEAVIR7Z` |
| ComplianceVerifier | `CAZZEALQBXYDW7RPHDHWJ6OYZS7TP2AH256RKZO6X6CQRFDY2LCHD4HL` |
| ShieldedTransferVerifier | `CDUKVBXXZZQM4XP6FK73NWCVWUIDP3RXBWLJWDDWCTANQ54NL7NGEGHS` |
| ShieldedPool | `CCCBEASG54TPJP2B6SJTX5PSG3BMGGXZTY5EXA32FJ7HKVJSF4N6HOWN` |

**Evidence txs:**
- Pipeline Groth16 on-chain verify: `4d4551751ac6ffa3d072cd2926e27893ae32dee1edc5323756d2a75519603a58`
- Compliance proof verify: `59f013d64676fab0fc1bd52dd56f9fec9bc1e351922dc0694d709b921eb7e4f7`
- Pool deploy: `8448489dbb1d91900182a29859f8c68ef112ed2b6584620345834b797ae29afe`
- Pool deposit (compliance + SAC transfer): `52808dfa238ec5ec3de7fb051475a6b5f578573fda40302e8ad42597838d64dc`
- Shielded transfer (amount hidden): `a32e0bf05aa2f51c7eb4a55e57d819d40b57f5c8ddc88e0aeb486c6751b66a66`

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
