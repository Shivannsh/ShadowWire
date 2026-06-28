# External contracts (vendored)

## `attest_protocol.wasm`

The **real, unmodified** AttestProtocol Soroban "protocol" contract — Stellar's
EAS-equivalent on-chain attestation service.

| | |
|---|---|
| Source repo | https://github.com/daccred/attest.so |
| Path | `contracts/stellar/protocol` |
| Commit | `b242b5b630d1ff41610d6b60e511792fef59d3d4` |
| Build | `cd contracts/stellar && stellar contract build` (soroban-sdk 22.0.x, target `wasm32v1-none`) |
| Size | 34,448 bytes |

### Why we vendor + self-deploy it

AttestProtocol's **public testnet** deployments (documented IDs `CBFE5…`,
`CDDRYX…`, authority `CCSLTCC…`) were deployed in **May 2025** and have since
been wiped by a Stellar testnet reset — `stellar contract fetch` returns
"Contract not found" for all of them. Only the **mainnet** deployment is live,
which we don't use for a hackathon demo.

So we deploy the **same audited contract code** ourselves on testnet
(`scripts/deploy-attest-protocol.mjs`) and have the ShieldedPool verify KYC
attestations against it via a cross-contract `get_attestation` call. This is the
real service, not a mock — we just host the testnet instance.

### How it's used

1. `scripts/deploy-attest-protocol.mjs` deploys + initializes this wasm and
   registers our KYC schema. Addresses land in `testnet-addresses.json`.
2. `contracts/shielded_pool` imports this wasm with `contractimport!` to get a
   typed client and calls `get_attestation(uid)` inside `deposit` / `withdraw`.
3. `mock-issuer` uses `@attestprotocol/stellar-sdk` to issue **delegated**
   KYC attestations (issuer = BLS authority, subject = the user's wallet).
