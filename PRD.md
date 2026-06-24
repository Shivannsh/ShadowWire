# ClearPass — PRD v2
### Private Cross-Border Remittance Corridor on Stellar
**Fiat on-ramp → shielded transfer → fiat off-ramp, amounts private throughout, compliance proofs at the edges**

**Hackathon:** Stellar Hacks: Real-World ZK (DoraHacks) — Submission deadline **June 29, 2026, 19:00**
**Status:** Draft v2 — supersedes v1 (compliance-gating-only scope). This is now a shielded-pool corridor, not just a compliance gate.

---

## 0. What Changed From v1 — Read This First

v1 was "prove compliance, then allow a transparent payment." That's a compliance gate bolted onto a normal payment — useful, but it doesn't make amounts private, only eligibility.

**v2 is structurally different.** The amount itself is now hidden inside the corridor, the whole way through. That means:

- You need a **shielded pool** (note commitments + nullifiers), not just a Merkle-membership compliance check.
- You need **two separate circuit families**: (a) compliance proofs at the on/off-ramp edges (reuses v1's circuit almost directly), and (b) a shielded-transfer circuit for the corridor itself (new — balance/nullifier logic, not just attribute checks).
- The fiat edges are now **real SEP-24 testnet anchor interactions**, not a mock mint/burn — bigger integration surface, but far more "real-world" credibility with judges.
- This is the **wild end** of the hackathon's own mild→wild spectrum. Scope discipline matters more than ever — see §9 for what to cut first if you're behind schedule.

**Recommendation locked in for this version:** UTXO-style shielded pool (note commitments + nullifiers — the same pattern as Zcash/Tornado-style pools and SDF's own reference prototype), not account-based encrypted balances. Reasoning: SDF's own published reference is already this pattern — a pool contract, a Groth16 Circom verifier, and membership Merkle trees to govern who can send and receive funds — so you can study and adapt real code instead of inventing new cryptography under deadline pressure, and abundant reference circuits exist for this exact shape. Account-based encrypted balances require a fresh homomorphic-update proof on every transfer with far less available tooling — wrong tradeoff for 8 days.

---

## 1. Problem Statement

A private cross-border remittance corridor: a sender deposits fiat with a real-world anchor, the value moves across the Stellar network as a **shielded** asset (amount and parties hidden from public ledger observers), and the recipient withdraws fiat on the other side via a (possibly different) anchor — all while compliance checks happen at both edges without ever exposing the user's identity or transaction history on-chain.

Today, every hop in a real remittance corridor (sending anchor, Stellar ledger, receiving anchor) exposes the amount and parties in the clear. Stellar's ledger is public by default — every payment, balance, and transfer is visible to anyone. For real institutional and remittance use, that's a non-starter: competitors can see flow volumes, governments can profile individuals, and senders/receivers have no transactional privacy even though they're fully compliant.

SDF has explicitly named this as a target outcome of its new protocol work — institutions and developers want configurable privacy without sacrificing compliance, transparency, or efficiency, validating complex conditions on-chain while keeping sensitive data private — and has already signaled use cases including confidential payroll, private remittances, and compliance-friendly privacy pools for financial institutions.

**ClearPass builds this corridor end-to-end**, using Stellar's actual payment rails (SEP-24 anchors) at the edges and a ZK shielded pool for the corridor itself.

---

## 2. Why This Wins (judging fit)

| Judging angle | How ClearPass scores |
|---|---|
| ZK doing real, load-bearing work | Amounts are cryptographically hidden via note commitments/nullifiers and a Groth16 spend proof verified on-chain — not "ZK namechecked in the README." This squarely satisfies the hackathon's own bar: ZK proving the proof should power a core mechanic, not just appear in a demo slide (their words, from the sister ZK Gaming hackathon brief, but the same judging instinct applies here) and the main brief's own framing — a clever ZK demo, a niche privacy tool, or an experiment is equally valid as long as ZK is doing real work in it (not just namechecked in the README). |
| Hits the named "natural fit" use case exactly | The brief explicitly calls out: Stellar is best known for moving real money in the real world — stablecoins, cross-border payments, tokenized real-world assets, and institutional settlement. So projects that bring ZK to those kinds of real-world use cases are a natural fit and especially welcome. This project IS that sentence. |
| Real Stellar rails, not a toy | Using actual SEP-24 testnet anchor infrastructure (a live public reference anchor + demo wallet already exist on testnet) is a strong "we understand the ecosystem" signal vs. mocking everything. |
| Uses the new host functions for real | On-chain Groth16 verification via Protocol 25 ("X-Ray") and Protocol 26 ("Yardstick") native BN254 + Poseidon host functions — Protocol 25 introduced native host functions for BN254 elliptic-curve operations and Poseidon/Poseidon2 hashing, and Protocol 26 added nine more BN254 host functions (MSM, scalar-field arithmetic, curve-membership checks). |
| Ambitious but groundable | "Wild end" of their own mild→wild spectrum, but built on a proven shielded-pool pattern SDF has already prototyped — not inventing new cryptography. |
| Reuses your existing strength | Your EAS identity/KYC work ports into the edge compliance circuits directly; the core shielded-pool logic is new work but follows a well-known template. |

---

## 3. Existing Stellar ZK & Anchor Landscape (what NOT to rebuild)

**ZK / shielded pool references:**
- **SDF's own private-payments prototype**: an open-source prototype using Groth16 proofs to hide deposit, transfer, and withdrawal details while keeping balances valid, combining a pool contract, a Groth16 Circom verifier, and membership Merkle trees. **Study this closely — it is the closest existing reference to the corridor core you're building.** Don't blindly fork it (you want your own judged originality), but its pool/nullifier/Merkle-tree pattern is your architectural template.
- **Groth16 verifier reference (Circom path):** `https://github.com/stellar/soroban-examples/tree/main/groth16_verifier`
- **Noir → Groth16 → Soroban pipeline (recommended for your circuits):** `https://jamesbachini.com/noir-groth16/`, tutorial companion `https://jamesbachini.com/noir-on-stellar/`. Generates Groth16 artifacts from Noir circuits via snarkjs, with a `verify_stellar.sh` script handling local re-verification, contract deployment, and byte encoding via `encode_bn254_for_soroban.mjs`. **This encoding step is the single most common integration failure point** — budget real debugging time, and prove the pipeline end-to-end with a trivial circuit before building your real circuits (see §8 Day 2).
- **Curve/proof system:** stick to **BN254 + Groth16**, not UltraHonk — Noir's UltraHonk proofs are larger and more expensive to verify on-chain, and community UltraHonk-on-Soroban efforts are still proof-of-concept / contract-size-limited. Protocol 25/26's native BN254 host functions make Groth16 the well-supported, lower-risk path.

**SEP-24 / anchor references:**
- **Live public reference anchor on testnet:** `testanchor.stellar.org` — a real, running SEP-24 anchor you can integrate against without standing up your own banking backend.
- **Reference demo wallet:** `https://demo-wallet.stellar.org/` (source: `https://github.com/stellar/stellar-demo-wallet`) — shows the full client-side SEP-24 deposit/withdraw flow, including the popup-based KYC collection step, against the test asset "SRT" (Stellar Reference Token).
- **If you want to run your own anchor backend instead of only consuming the public one:** `django-polaris` is SDF's reference anchor server implementation; a minimal Polaris anchor can issue a test asset, run the interactive SEP-24 webview, and use testnet "mocked KYC" pages, since at the testing phase you don't need to store collected KYC information permanently, but you still need to provide the interface to collect it.
- **Why this matters for your pitch:** SEP-24 already assumes mocked banking rails on testnet by design — both wallets and anchors should implement a sandbox mode using the Stellar testnet and fake banking rails so counterparties can run through the flow without a need to collaborate. You are not "cheating" by mocking the bank side; that's literally how SEP-24 testnet integration is supposed to work. This means you can legitimately claim "real anchor protocol, real testnet flow" without needing an actual banking partner.

---

## 4. Product Scope

### 4.1 Core corridor flow (must work end-to-end — this is the whole point of the project)

> Alice in Country A wants to send money to Bob in Country B.
>
> 1. **On-ramp (fiat → shielded note):** Alice deposits fiat with Anchor A via a real SEP-24 interactive deposit flow on testnet. Anchor A issues her a Stellar test asset. Alice converts that balance into a **shielded note** in the ClearPass pool by depositing into the pool contract and receiving a private note commitment (this step is itself gated by a compliance proof — sanctions/KYC-tier check, from the v1 circuit family).
> 2. **Shielded transfer (corridor):** Alice constructs a ZK spend proof that: she owns an unspent note in the pool (proven via Merkle membership + nullifier non-reuse), the note's value covers the transfer, and a new note is created for Bob — all without revealing the amount or either party's identity on-chain. She submits this proof to the Soroban pool contract, which verifies it on-chain and updates the pool's note-commitment tree and nullifier set.
> 3. **Off-ramp (shielded note → fiat):** Bob proves ownership of his new note (another ZK spend proof), withdraws from the pool into a visible Stellar test-asset balance, and initiates a SEP-24 interactive withdrawal with Anchor B to cash out to fiat — gated by his own compliance proof (KYC tier sufficient for the receiving jurisdiction, not sanctioned, amount within limits — amount can be revealed at this specific edge if the anchor's compliance flow requires it, since real-world AML almost always requires the off-ramp amount to be known to the cashing-out anchor; the privacy property you're proving is that **the corridor and the chain never saw it**, not that no human-facing edge ever does).

This is the critical design point to articulate clearly in your README: **privacy holds across the public ledger and the corridor itself; the anchors at each edge necessarily know what they handle, exactly as a real bank does today** — but no anchor, observer, or chain indexer can link Alice's deposit to Bob's withdrawal, or see the amount in transit.

### 4.2 Stretch goals (priority order — attempt only once 4.1 works end-to-end on testnet)
1. **Auditor viewing key** — a regulator/auditor role can decrypt one flagged note's value/owner without breaking privacy for everyone else (selective disclosure).
2. **Multiple corridors with different compliance thresholds** (e.g., US↔Nigeria vs EU↔Philippines), each with its own KYC-tier/limit rules.
3. **Relayer / gas abstraction** so the recipient doesn't need testnet XLM to submit their withdrawal proof (a real UX problem in shielded pools — solving it, even partially, is a strong technical signal).
4. **Note splitting/merging** (multiple input/output notes per transaction) — adds realism but meaningfully more circuit complexity; only attempt with days to spare.

### 4.3 Explicitly out of scope (do not attempt)
- Real banking integration — use the public testnet anchor / Polaris in sandbox mode, exactly as SEP-24 intends.
- UltraHonk proof system — use Groth16 (see §3).
- Arbitrary multi-asset support — pick **one** test asset for the corridor; do not generalize.
- Production key management/HSMs.
- Mobile app — web demo only.
- A fully generalized "anyone can plug into this pool" SDK — get your own corridor working first; generalized interfaces are a stretch, not core.

---

## 5. System Architecture

```
                       FIAT SIDE (real SEP-24 testnet)                         FIAT SIDE
        ┌─────────────────────────────────┐                    ┌─────────────────────────────────┐
        │   Anchor A (testanchor.stellar  │                    │   Anchor B (testanchor.stellar  │
        │   .org or your own Polaris       │                    │   .org or your own Polaris       │
        │   instance) — SEP-24 deposit     │                    │   instance) — SEP-24 withdraw    │
        └───────────────┬─────────────────┘                    └───────────────▲─────────────────┘
                         │ issues test asset                                    │ pays out test asset
                         ▼                                                      │
        ┌─────────────────────────────────┐                    ┌─────────────────────────────────┐
        │  Alice's Stellar account         │                    │  Bob's Stellar account           │
        │  (visible test-asset balance)    │                    │  (visible test-asset balance)    │
        └───────────────┬─────────────────┘                    └───────────────▲─────────────────┘
                         │ 1. deposit + compliance proof                        │ 4. withdraw proof +
                         │    (Noir compliance circuit, v1 pattern)             │    compliance proof
                         ▼                                                      │
        ┌──────────────────────────────────────────────────────────────────────┴──────┐
        │                     SHIELDED POOL (Soroban contract)                         │
        │   - Note commitment tree (Poseidon-hashed, on-chain root)                    │
        │   - Nullifier set (prevents double-spend, on-chain)                          │
        │   - Groth16 verifier (Protocol 25/26 native BN254 host functions)            │
        │                                                                               │
        │   2. Alice submits SHIELDED TRANSFER PROOF:                                  │
        │      "I own an unspent note worth V, here is a new nullifier,                │
        │       and here is a new note commitment for Bob worth V (minus fee)"         │
        │      — verified on-chain, amount V never appears in plaintext.               │
        │                                                                               │
        │   3. Bob later submits SPEND PROOF to withdraw his note                      │
        │      back into a visible balance on his own account.                         │
        └────────────────────────────────────────────────────────────────────────────────┘
```

**Curve/proof system:** BN254, Groth16.
**Hash for commitments/nullifiers/Merkle tree:** Poseidon (native Soroban host function).
**Circuit language:** Noir, compiled to Groth16.
**Two circuit families:**
1. **Compliance circuit** (edges) — reused/adapted from v1: KYC tier, sanctions check, amount-within-limit, proven via Merkle membership against an issuer-published attribute tree.
2. **Shielded-transfer circuit** (corridor core, new) — note ownership + nullifier + new-note-creation logic, the actual "amount stays private" mechanism.

---

## 6. Detailed Component Specs

### 6.1 Issuer / Compliance Attestation Service (off-chain, simulated) — *unchanged from v1, still needed*
Same role as v1: a mock KYC/compliance attestor issuing Poseidon-committed attribute leaves (`kyc_tier`, `sanctioned_flag`, `country_code`) into an on-chain Merkle registry. This is what your EAS project's attestation logic ports into directly. Used at both the deposit-into-pool step and the withdraw-from-pool step.

### 6.2 Circuit Family A — `compliance.nr` (edge proofs) — *same design as v1 §6.2*
Public inputs: `merkle_root`, `corridor_id`, `min_kyc_tier`, `max_amount`, `amount`.
Private witness: `secret_salt`, `country_code`, `kyc_tier`, `sanctioned_flag`, `merkle_path`.
Logic: Merkle-membership check + tier/sanctions/limit assertions (see v1 PRD §6.2 for full pseudocode — carry it over unchanged).

**Used twice in this version:** once when Alice deposits into the shielded pool (proving she's allowed to bring funds in), once when Bob withdraws (proving he's allowed to cash out in his jurisdiction).

### 6.3 Circuit Family B — `shielded_transfer.nr` (corridor core, NEW — this is the heart of the project)

**Note structure:**
```
note = { owner_pubkey, value, asset_id, blinding_factor }
commitment = Poseidon(owner_pubkey, value, asset_id, blinding_factor)
nullifier   = Poseidon(note_secret_key, commitment)   // unique per spend, prevents double-spend
```

**Public inputs (visible on-chain — none reveal the amount):**
- `merkle_root` (current note-commitment tree root)
- `nullifier_hash` (proves this exact note hasn't been spent before — checked against an on-chain nullifier set)
- `new_commitment_1`, `new_commitment_2` (output notes — e.g., one for the recipient, one "change" note back to sender, if you support splitting; for MVP, a single output note is enough)
- `fee` (if you charge one, can be public)

**Private witness:**
- Input note's `owner_pubkey`, `value`, `asset_id`, `blinding_factor`, `note_secret_key`
- `merkle_path` proving the input note's commitment is in the tree
- Output note(s)' full plaintext fields (value, owner, blinding factor) — used to compute `new_commitment`, never revealed

**Circuit logic (pseudocode):**
```
input_commitment = poseidon(owner_pubkey, value, asset_id, blinding_factor)
assert merkle_verify(input_commitment, merkle_path) == merkle_root
assert poseidon(note_secret_key, input_commitment) == nullifier_hash
assert value == output_value_1 + output_value_2 + fee   // value conservation, no amount disclosed publicly
new_commitment_1 = poseidon(recipient_pubkey, output_value_1, asset_id, blinding_factor_1)
new_commitment_2 = poseidon(sender_pubkey, output_value_2, asset_id, blinding_factor_2)  // "change" note
assert new_commitment_1 == public_new_commitment_1
assert new_commitment_2 == public_new_commitment_2
```

**This is the part of your build with the most genuine engineering risk** — value-conservation logic, nullifier correctness, and avoiding double-spend or note-forgery bugs need careful test-vector coverage. Plan for this to take longer than the compliance circuit. **Do not attempt note splitting/merging (4.2 stretch #4) until single-input/single-output works perfectly end-to-end on testnet.**

### 6.4 Soroban Contract — `ComplianceRegistry` — *same as v1 `MerkleRegistry`*
Stores the compliance attribute Merkle root; `update_root()` issuer-gated; `get_root()` public.

### 6.5 Soroban Contract — `ShieldedPool` (NEW — corridor core contract)
- Stores: note-commitment Merkle tree root, nullifier set (mapping/set of spent nullifiers).
- `deposit(compliance_proof, commitment)` — verifies the compliance proof (calls `ComplianceVerifier`), then inserts `commitment` into the tree, updates root. Funds move from the depositor's visible test-asset balance into pool custody.
- `transfer(transfer_proof, nullifier_hash, new_commitments[])` — verifies the shielded-transfer proof (calls `ShieldedTransferVerifier`), checks `nullifier_hash` not already spent, inserts it into the nullifier set, inserts new commitments into the tree, updates root. **No amount appears in this call's plaintext arguments.**
- `withdraw(spend_proof, nullifier_hash, recipient, amount)` — verifies a spend proof proving ownership of a note worth exactly `amount`, checks/marks the nullifier spent, and releases `amount` of the test asset to `recipient`'s visible balance. (Amount is revealed here by design — see §4.1 step 3 framing — this is the real-world edge where an anchor needs to know what it's paying out.)

### 6.6 Soroban Contracts — `ComplianceVerifier` and `ShieldedTransferVerifier`
Two separate Groth16 verifier contracts (different circuits, different verification keys), both adapted from `stellar/soroban-examples/groth16_verifier`, both using Protocol 25/26 native BN254 `pairing_check` + Poseidon host functions. **Capture a real testnet transaction hash for each** — this is your single strongest piece of evidence for judges that the ZK is load-bearing and on-chain, not simulated.

### 6.7 Anchor Integration Layer
- **Recommended for time budget:** integrate against the **public reference anchor** `testanchor.stellar.org` using the **reference demo wallet flow** (`stellar-demo-wallet` source) as your client-side template, rather than standing up your own Polaris instance from scratch. This gets you a real SEP-24 deposit/withdraw flow with minimal backend work.
- **If you have a spare day and want a more controlled demo:** stand up a minimal Polaris anchor instance for one side of the corridor (e.g., Anchor A), following the official Polaris tutorial, so you control its mocked-KYC page content and can tailor the demo narrative — but only attempt this after the core pool/circuits are working; it's infrastructure polish, not core ZK risk.
- Either way: the on-ramp/off-ramp UI must visibly go through the actual interactive popup flow (this is normal for SEP-24 demos — the official demo wallet does the same, including the pop-up KYC step) — this is what makes your "real Stellar rails" claim credible to judges, not just asserted in a README.

### 6.8 Frontend (demo-focused, two simple personas: Alice / Bob)
- **Alice's flow:** SEP-24 deposit (real popup flow) → "Shield funds" (compliance proof + pool deposit) → "Send privately" (shielded-transfer proof, enter Bob's pool pubkey + amount) → show pool tree root changing on-chain, **no amount visible anywhere in the corridor step's transaction**.
- **Bob's flow:** "Claim note" (spend proof) → "Withdraw to fiat" (compliance proof + SEP-24 withdrawal popup) → show fiat balance.
- **Critical demo visual:** show a block/transaction explorer view of the corridor transfer step side-by-side with a normal transparent Stellar payment, so judges can *see* that the amount field is absent/opaque in yours and present in a normal one. This single visual probably does more for your scoring than anything else in the demo.

---

## 7. What "Private Throughout" Actually Means — Be Precise About This in Your README

Be explicit and honest about your privacy model; judges will respect precision over over-claiming:

- **Hidden from the public Stellar ledger and from any chain observer:** the transfer amount, sender identity, and recipient identity during the corridor (pool) phase.
- **Known to Anchor A:** that Alice deposited some amount (this is unavoidable — she's handing them fiat).
- **Known to Anchor B:** that Bob withdrew some amount (same reason).
- **NOT linkable by anyone (including the anchors, if they don't collude and compare notes manually) to:** the matching deposit/withdrawal pair, or the fact that Alice's deposit and Bob's withdrawal are related.
- This is the same privacy model real shielded pools (Zcash, Tornado-style mixers) provide, applied to a remittance corridor — and it's an honest, defensible claim, unlike pretending the on/off-ramp edges themselves are private (they can't be, in any system that interfaces with real banking rails and AML obligations).

---

## 8. 8-Day Build Plan (team of 2–3)

**Deadline: June 29, 19:00. This is a bigger scope than v1 — protect Day 2's pipeline proof-of-concept ruthlessly, and read §9 (cut list) by Day 4 if you're behind.**

| Day | Circuits person (you) | Soroban/contracts person | Frontend/anchor-integration person |
|---|---|---|---|
| 1 (Jun 24) | Set up Noir + snarkjs/Barretenberg; design note/commitment/nullifier schema | Clone `groth16_verifier` example, deploy stock circuit to testnet as-is; set up Soroban CLI/test harness | Get `testanchor.stellar.org` SEP-24 deposit/withdraw working against a plain Stellar test account (no pool yet) — prove the anchor flow works in isolation first |
| 2 (Jun 25) | Write `compliance.nr` (reuse v1 design); **get ONE trivial circuit through the full Noir→Groth16→Soroban pipeline end-to-end on testnet today** — this is the de-risking step, don't skip it | Build `ComplianceRegistry` contract; help unblock the pipeline proof-of-concept | Build minimal frontend shell with Alice/Bob personas; wire up the anchor flow into the shell |
| 3 (Jun 26) | Write `shielded_transfer.nr` — note structure, nullifier logic, value conservation; local test vectors only (no chain yet) | Build `ShieldedPool` contract (deposit/transfer/withdraw skeleton) + second verifier contract; deploy compliance verifier + registry to testnet | Continue frontend; mock pool interactions with fake data while contracts aren't ready |
| 4 (Jun 27) | Finish + debug `shielded_transfer.nr` correctness; integrate BN254 encoding for the new circuit | **Highest-risk integration day:** wire `ShieldedPool.transfer()` to call the real `ShieldedTransferVerifier`; get one real on-chain shielded transfer working | Replace mocked pool calls with real contract calls as they come online |
| 5 (Jun 28, AM) | Support integration; fix circuit bugs found during wiring | Full end-to-end test: deposit → shield → transfer → withdraw, on testnet, capturing every tx hash | Polish the "private vs transparent" explorer comparison visual (§6.8) — this is a high-leverage demo asset |
| 5 (Jun 28, PM) | **Freeze all code by end of day.** Everyone: bug bash, write tests, write README — see §9 for what to cut if not all working | | |
| 6 (Jun 29, AM) | Record demo video (2–3 min, matches hackathon's stated format: a 2–3 minute video walkthrough... clearly show what you built and explain the work you did) | Finalize README: architecture diagram, all tx hashes, setup instructions, explicit privacy-model statement (§7) | Final repo cleanup, license, README pass |
| 6 (Jun 29, by 19:00) | **Submit:** open-source repo + README + video, per eligibility rules — an open-source repo (public GitHub/GitLab/Bitbucket, full source, clear README) and a video demo (2–3 minute walkthrough) and Stellar testnet/mainnet interaction (your project must submit, consume, or otherwise integrate real Stellar testnet or mainnet transactions) | | |

---

## 9. Scope Cut List — If You're Behind by Day 4, Cut in This Order

Cutting from the bottom up preserves "ZK is load-bearing and the corridor story is real," which matters more than completeness:

1. **Cut first:** Note splitting/merging, multiple corridors, relayer/gas abstraction (all stretch goals already, §4.2) — never start these unless 4.1 is fully done with days to spare.
2. **Cut second:** Your own Polaris anchor instance — fall back to the public `testanchor.stellar.org` only, on both sides if needed (it's a single shared reference anchor, you can use it for both legs of the demo corridor).
3. **Cut third:** The auditor-viewing-key stretch goal.
4. **Cut fourth (only if truly desperate):** Real SEP-24 integration on *both* edges — keep it real on at least one edge (e.g., the deposit/on-ramp), and simulate the other edge's anchor interaction with a clearly-labeled mock in the README ("off-ramp anchor interaction simulated due to time; on-ramp is real SEP-24 testnet flow"). **Never cut the shielded-transfer circuit or its on-chain verification — that's the entire point of the project and the thing judges are checking for.**

---

## 10. README Checklist

- [ ] One-paragraph summary in the hackathon's own language (real-world payment rails, made confidential — echo their phrasing).
- [ ] Architecture diagram (reuse §5).
- [ ] Explicit, honest privacy-model statement (§7) — precision reads better than over-claiming.
- [ ] Real testnet contract addresses + at least one tx hash per circuit/verifier (compliance verify, shielded-transfer verify, deposit, withdraw).
- [ ] Explicit list of which Protocol 25/26 host functions are used and where.
- [ ] The "private vs transparent" explorer comparison screenshot/clip.
- [ ] Honest scope notes: what's MVP vs. stretch vs. simulated (e.g., if you had to cut a real anchor leg per §9).
- [ ] Setup/run instructions that actually work if a judge tries them.
- [ ] Credit to reference tooling used (SDF's private-payments prototype as architectural reference, Circom/Noir verifier examples, Polaris/demo-wallet if used).

---

## 11. Key Reference Links

- Hackathon detail/ideas: https://dorahacks.io/hackathon/stellar-hacks-zk/ideas
- Groth16 Verifier Contract (Circom path): https://github.com/stellar/soroban-examples/tree/main/groth16_verifier
- Noir → Groth16 → Soroban pipeline: https://jamesbachini.com/noir-groth16/
- Noir on Stellar tutorial: https://jamesbachini.com/noir-on-stellar/
- Noir docs: https://noir-lang.org/docs/
- Public reference SEP-24 testnet anchor: testanchor.stellar.org
- Reference demo wallet (client-side SEP-24 flow): https://github.com/stellar/stellar-demo-wallet / https://demo-wallet.stellar.org/
- Polaris (reference anchor server, if you build your own): https://django-polaris.readthedocs.io/
- SEP-24 spec: https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0024.md
- Anchor Platform (alternative to Polaris): https://developers.stellar.org/docs/platforms/anchor-platform