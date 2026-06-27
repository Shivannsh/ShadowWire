# Graph Report - .  (2026-06-27)

## Corpus Check
- 66 files · ~50,721 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 611 nodes · 1140 edges · 41 communities (33 shown, 8 thin omitted)
- Extraction: 97% EXTRACTED · 3% INFERRED · 0% AMBIGUOUS · INFERRED: 29 edges (avg confidence: 0.83)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Soroban Contracts Core|Soroban Contracts Core]]
- [[_COMMUNITY_Corridor E2E Pipeline|Corridor E2E Pipeline]]
- [[_COMMUNITY_Frontend UI Components|Frontend UI Components]]
- [[_COMMUNITY_Mock Issuer Proving Server|Mock Issuer Proving Server]]
- [[_COMMUNITY_Next.js Dependencies|Next.js Dependencies]]
- [[_COMMUNITY_Testnet Address Config|Testnet Address Config]]
- [[_COMMUNITY_Freighter Wallet Context|Freighter Wallet Context]]
- [[_COMMUNITY_Build Toolchain Scripts|Build Toolchain Scripts]]
- [[_COMMUNITY_Alice Bob Demo Pages|Alice Bob Demo Pages]]
- [[_COMMUNITY_BN254 Soroban Encoding|BN254 Soroban Encoding]]
- [[_COMMUNITY_ZK Verifier Contracts|ZK Verifier Contracts]]
- [[_COMMUNITY_TypeScript Config|TypeScript Config]]
- [[_COMMUNITY_Proof Client Library|Proof Client Library]]
- [[_COMMUNITY_Pool Transaction Builder|Pool Transaction Builder]]
- [[_COMMUNITY_Mock Issuer Dependencies|Mock Issuer Dependencies]]
- [[_COMMUNITY_Note Wallet Storage|Note Wallet Storage]]
- [[_COMMUNITY_Monorepo Package Meta|Monorepo Package Meta]]
- [[_COMMUNITY_Pool v8 Deploy Script|Pool v8 Deploy Script]]
- [[_COMMUNITY_Stellar Ecosystem Skills|Stellar Ecosystem Skills]]
- [[_COMMUNITY_Noir Groth16 Pipeline|Noir Groth16 Pipeline]]
- [[_COMMUNITY_Corridor E2E Helpers|Corridor E2E Helpers]]
- [[_COMMUNITY_Snarkjs Toolchain|Snarkjs Toolchain]]
- [[_COMMUNITY_Product Demo Narrative|Product Demo Narrative]]
- [[_COMMUNITY_App Layout Providers|App Layout Providers]]
- [[_COMMUNITY_Compliance Merkle Tree|Compliance Merkle Tree]]
- [[_COMMUNITY_Contract Build Deploy|Contract Build Deploy]]
- [[_COMMUNITY_Privacy UX Theme|Privacy UX Theme]]
- [[_COMMUNITY_Landing Page Marketing|Landing Page Marketing]]
- [[_COMMUNITY_Anchor API Proxy|Anchor API Proxy]]
- [[_COMMUNITY_Corridor Shell Script|Corridor Shell Script]]
- [[_COMMUNITY_Run Demo Script|Run Demo Script]]
- [[_COMMUNITY_Testnet Addresses Hook|Testnet Addresses Hook]]
- [[_COMMUNITY_Wallet Submit Layer|Wallet Submit Layer]]
- [[_COMMUNITY_ESLint Config|ESLint Config]]
- [[_COMMUNITY_Next Config|Next Config]]
- [[_COMMUNITY_Tailwind Config|Tailwind Config]]
- [[_COMMUNITY_ShadowWire Branding|ShadowWire Branding]]
- [[_COMMUNITY_Mock Issuer Package|Mock Issuer Package]]
- [[_COMMUNITY_Friendbot Funding|Friendbot Funding]]

## God Nodes (most connected - your core abstractions)
1. `ShieldedPool` - 21 edges
2. `ShadowWire / ClearPass` - 17 edges
3. `compilerOptions` - 16 edges
4. `ClearPass PRD v2` - 16 edges
5. `ShieldedPool Contract` - 13 edges
6. `main()` - 12 edges
7. `fail()` - 11 edges
8. `PoolError` - 10 edges
9. `Human Action Checklist` - 10 edges
10. `verify_groth16()` - 9 edges

## Surprising Connections (you probably didn't know these)
- `Soroban Skill` --semantically_similar_to--> `ShieldedPool Contract`  [INFERRED] [semantically similar]
  .agents/skills/soroban/SKILL.md → scripts/deploy.sh
- `ZK Proofs Skill` --semantically_similar_to--> `ComplianceVerifier Contract`  [INFERRED] [semantically similar]
  .agents/skills/zk-proofs/SKILL.md → scripts/deploy.sh
- `ShadowWire / ClearPass` --conceptually_related_to--> `ShieldedPool Contract`  [EXTRACTED]
  README.md → scripts/deploy.sh
- `ShadowWire / ClearPass` --references--> `testanchor.stellar.org`  [EXTRACTED]
  README.md → testnet-addresses.json
- `ClearPass PRD v2` --references--> `Compliance Circuit`  [EXTRACTED]
  PRD.md → scripts/deploy.sh

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Shielded Deposit Compliance Gate** — lib_deposit, lib_complianceverifier, lib_complianceregistry, lib_compliance_nullifier_replay, lib_amount_mismatch_protection, inputs_compliance_public_signals [EXTRACTED 1.00]
- **Off-Ramp Dual Groth16 Proof Gate** — lib_withdraw, lib_shieldedtransferverifier, lib_complianceverifier, lib_spend_nullifier_replay, lib_compliance_nullifier_replay, lib_withdraw_amount_mismatch [EXTRACTED 1.00]
- **Alice-to-Bob Private Corridor Demo** — page_sep24_on_ramp, page_shield_deposit_ui, page_private_transfer_ui, page_note_receipt, page_dual_proof_withdraw_ui, page_sep24_off_ramp [EXTRACTED 1.00]
- **ShadowWire Private Remittance Corridor** — sep24_runsep24deposit, pool_builddeposittx, pool_buildtransfertx, notewallet_notereceipt, pool_buildwithdrawtx, sep24_runsep24withdraw [INFERRED 0.90]
- **Groth16 Proof Generation Pipeline** — index_computenotevalues, poolstate_computemerklepath, index_computecompliancenullifier, index_generateproof, proofs_mock_issuer_client [EXTRACTED 1.00]
- **Freighter Wallet Signing Layer** — freightercontext_freighterprovider, freightercontext_usefreighter, transactions_submittransaction, sep24_sep10auth [INFERRED 0.85]
- **ShadowWire Testnet Deployment Pipeline** — install_tools, fund_accounts, deploy_sh, run_circuit, encode_bn254, compliance_registry, compliance_verifier, shielded_transfer_verifier, shielded_pool, testnet_addresses [EXTRACTED 1.00]
- **Noir to Groth16 to Soroban Verification Flow** — nargo, noir_cli, snarkjs, groth16, encode_bn254, bn254, compliance_verifier, shielded_transfer_verifier [EXTRACTED 1.00]
- **Stellar Dev Skills Bundle** — skills_lock, skill_agentic_payments, skill_assets, skill_dapp, skill_data, skill_soroban, skill_standards, skill_zk_proofs [EXTRACTED 1.00]

## Communities (41 total, 8 thin omitted)

### Community 0 - "Soroban Contracts Core"
Cohesion: 0.10
Nodes (34): Address, Bn254G1Affine, Bn254G2Affine, Bytes, BytesN, DataKey, decode_public_signals(), Proof (+26 more)

### Community 1 - "Corridor E2E Pipeline"
Cohesion: 0.06
Nodes (42): Shielded Pool Contract ID Resolver, Compliance Circuit inputs.json Generator, Compliance Groth16 Circuit, corridor-e2e.mjs Full Corridor CLI, corridor-e2e.sh Legacy CLI, Pool v7 Merkle Root Inconsistency Bug, deploy-pool-v8 Pool Root Fix Deploy, useFreighter Hook (+34 more)

### Community 2 - "Frontend UI Components"
Cohesion: 0.07
Nodes (41): Freighter Connect Button, Corridor Flow Step Wizard, Alice/Bob Navigation Header, Compliance KYC Private Inputs, Compliance Nullifier, Compliance Circuit Public Signals, Pipeline Test Fixture Inputs, Shielded Note Private Inputs (+33 more)

### Community 3 - "Mock Issuer Proving Server"
Cohesion: 0.08
Nodes (30): app, CIRCUITS, computeNoteCommitment(), computeNoteValues(), DEMO_KYC_BASE, __dirname, ensureArtifacts(), generateProof() (+22 more)

### Community 4 - "Next.js Dependencies"
Cohesion: 0.07
Nodes (26): dependencies, next, react, react-dom, @stellar/freighter-api, @stellar/stellar-sdk, devDependencies, autoprefixer (+18 more)

### Community 5 - "Testnet Address Config"
Cohesion: 0.19
Nodes (19): getPoolAssetContractId(), getShieldedPoolContractId(), loadTestnetAddresses(), resolveContractAddress(), TestnetAddresses, AnchorConfig, authHeaders(), fetchToml() (+11 more)

### Community 6 - "Freighter Wallet Context"
Cohesion: 0.12
Nodes (15): FreighterContext, FreighterContextValue, buildAddTrustlineTx(), buildConfig(), config, fundTestnetAccount(), hasTrustline(), horizon (+7 more)

### Community 7 - "Build Toolchain Scripts"
Cohesion: 0.17
Nodes (13): ng16_auto_install_enabled(), ng16_ensure_rust_target(), ng16_ensure_snarkjs(), ng16_ensure_stellar(), ng16_error(), ng16_install_snarkjs_local(), ng16_require_cmd(), ng16_require_file() (+5 more)

### Community 8 - "Alice Bob Demo Pages"
Cohesion: 0.18
Nodes (15): AlicePage(), Step, BobPage(), ConnectButton(), FlowStep(), StatusBadge(), statusStyles, StepStatus (+7 more)

### Community 9 - "BN254 Soroban Encoding"
Cohesion: 0.26
Nodes (20): encodeProof, encodePublic, encodeVk, assertNodeVersion(), encodeFp2(), encodeG1(), encodeG2(), encodeProof() (+12 more)

### Community 10 - "ZK Verifier Contracts"
Cohesion: 0.15
Nodes (17): BN254 Elliptic Curve, Pipeline Test Circuit, ComplianceRegistry Contract, ComplianceVerifier Contract, Groth16 ZK Proofs, PATH, CARGO_TARGET_DIR, PATH (+9 more)

### Community 11 - "TypeScript Config"
Cohesion: 0.10
Nodes (19): compilerOptions, allowJs, esModuleInterop, incremental, isolatedModules, jsx, lib, module (+11 more)

### Community 12 - "Proof Client Library"
Cohesion: 0.15
Nodes (16): bytesFromArray(), ComplianceProveResponse, DepositNoteInput, DepositNoteResponse, DepositProofInput, encodeNoteReceipt(), fieldToBytes32(), generateComplianceProof() (+8 more)

### Community 13 - "Pool Transaction Builder"
Cohesion: 0.26
Nodes (18): addressScVal(), buildDepositTx(), buildTransferTx(), buildWithdrawTx(), bytesN32ScVal(), bytesScVal(), DepositParams, getPoolRoot() (+10 more)

### Community 14 - "Mock Issuer Dependencies"
Cohesion: 0.11
Nodes (17): dependencies, @aztec/bb.js, circomlibjs, cors, express, @stellar/stellar-sdk, devDependencies, tsx (+9 more)

### Community 15 - "Note Wallet Storage"
Cohesion: 0.20
Nodes (14): addressToField(), BN254_ORDER, createNote(), encodeNoteReceipt(), generateNoteRandomness(), generateRandomField(), getNoteByCommitment(), getSpendableNotes() (+6 more)

### Community 16 - "Monorepo Package Meta"
Cohesion: 0.12
Nodes (16): author, description, keywords, license, main, name, scripts, corridor (+8 more)

### Community 17 - "Pool v8 Deploy Script"
Cohesion: 0.22
Nodes (16): ADDRS_FILE, api(), bytesToHex(), __dirname, extractContractId(), extractTx(), fieldToHex(), INITIAL_ROOT (+8 more)

### Community 18 - "Stellar Ecosystem Skills"
Cohesion: 0.21
Nodes (14): CAP-0074 BN254 Host Functions, CAP-0075 Poseidon Host Functions, Machine Payments Protocol, Poseidon Hash, ShadowWire README, Agentic Payments Skill, Stellar Assets Skill, Stellar dApp Skill (+6 more)

### Community 19 - "Noir Groth16 Pipeline"
Cohesion: 0.23
Nodes (11): Compliance Circuit, Shielded Transfer Circuit, setup_verifier, Nargo Noir Compiler, noir-cli (Noir-Groth16), Noir to Groth16 Pipeline, PATH, PATH (+3 more)

### Community 20 - "Corridor E2E Helpers"
Cohesion: 0.26
Nodes (12): addresses(), ADDRS_FILE, api(), bytesToHex(), checkIssuer(), __dirname, extractTx(), fieldToHex() (+4 more)

### Community 21 - "Snarkjs Toolchain"
Cohesion: 0.18
Nodes (10): scripts/lib/common.sh, dependencies, circomlibjs, snarkjs, PATH, PATH, snarkjs, Stellar CLI (+2 more)

### Community 22 - "Product Demo Narrative"
Cohesion: 0.25
Nodes (11): Alice Demo Persona, Bob Demo Persona, Stellar Hacks Real-World ZK, Freighter Wallet, Next.js Frontend Demo, Human Action Checklist, Mock KYC Issuer API, Note Commitments (+3 more)

### Community 23 - "App Layout Providers"
Cohesion: 0.22
Nodes (7): inter, jetbrains, metadata, Providers(), Header(), nav, FreighterProvider()

### Community 24 - "Compliance Merkle Tree"
Cohesion: 0.31
Nodes (9): __dirname, main(), root, ComplianceLeaf, DEMO_ALICE, DEMO_BOB, hashLeaf(), merkleRoot() (+1 more)

### Community 25 - "Contract Build Deploy"
Cohesion: 0.32
Nodes (6): stellar contract build, build(), CARGO_TARGET_DIR, PATH, setup_verifier(), deploy.sh script

### Community 26 - "Privacy UX Theme"
Cohesion: 0.29
Nodes (7): addressToField BN254 Mapping, Browser localStorage Note Wallet, ShieldedNote UTXO, PrivacyComparison UI, ShadowWire Shielded Corridor, Transparent Classic Stellar Payment, Shield Privacy Theme Colors

### Community 28 - "Anchor API Proxy"
Cohesion: 0.70
Nodes (4): buildAnchorUrl(), copyHeaders(), GET(), POST()

### Community 30 - "Run Demo Script"
Cohesion: 0.67
Nodes (3): PATH, verify_circuit(), run-demo.sh script

### Community 31 - "Testnet Addresses Hook"
Cohesion: 0.67
Nodes (3): loadTestnetAddresses, TestnetAddresses Config, useTestnetAddresses Hook

### Community 32 - "Wallet Submit Layer"
Cohesion: 0.67
Nodes (3): FreighterProvider, Stellar Network Config, submitTransaction

## Ambiguous Edges - Review These
- `Pipeline Test Fixture Inputs` → `Groth16 BN254 On-Chain Verifier`  [AMBIGUOUS]
  circuits/pipeline_test/inputs.json · relation: conceptually_related_to

## Knowledge Gaps
- **193 isolated node(s):** `DataKey`, `DataKey`, `extends`, `nextConfig`, `name` (+188 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **8 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **What is the exact relationship between `Pipeline Test Fixture Inputs` and `Groth16 BN254 On-Chain Verifier`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **Why does `ComplianceProofBundle` connect `Pool Transaction Builder` to `Corridor E2E Pipeline`, `Proof Client Library`?**
  _High betweenness centrality (0.019) - this node is a cross-community bridge._
- **Why does `Raw Integer Amount Unit (Not Stroops)` connect `Corridor E2E Pipeline` to `Pool Transaction Builder`?**
  _High betweenness centrality (0.012) - this node is a cross-community bridge._
- **Why does `snarkjs` connect `Snarkjs Toolchain` to `Noir Groth16 Pipeline`?**
  _High betweenness centrality (0.011) - this node is a cross-community bridge._
- **What connects `DataKey`, `DataKey`, `extends` to the rest of the system?**
  _193 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Soroban Contracts Core` be split into smaller, more focused modules?**
  _Cohesion score 0.09899396378269618 - nodes in this community are weakly interconnected._
- **Should `Corridor E2E Pipeline` be split into smaller, more focused modules?**
  _Cohesion score 0.05807200929152149 - nodes in this community are weakly interconnected._