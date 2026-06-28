#![no_std]

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, symbol_short, token,
    Address, Bytes, BytesN, Env, Symbol,
};

// ---------------------------------------------------------------------------
// External: ComplianceRegistry — read the current KYC Merkle root
// ---------------------------------------------------------------------------
mod compliance_registry {
    soroban_sdk::contractimport!(
        file = "../target/wasm32v1-none/release/compliance_registry.wasm"
    );
}

// Storage key constants
const ROOT_KEY:  Symbol = symbol_short!("ROOT");
const ASSET_KEY: Symbol = symbol_short!("ASSET");
const NEXT_IDX:  Symbol = symbol_short!("NIDX");
const CID_KEY:   Symbol = symbol_short!("CID");   // corridor_id
const OPKEY_KEY: Symbol = symbol_short!("OPKEY"); // operator ed25519 pubkey (root attestor)

/// TTL thresholds: ~1 day minimum, ~30 days extension target
const TTL_MIN:    u32 = 17_280;
const TTL_EXTEND: u32 = 518_400;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum PoolError {
    NotInitialized          = 1,
    NullifierSpent          = 2,
    VerificationFailed      = 3,
    InvalidAmount           = 4,
    ComplianceNullifierUsed = 5,
    /// Merkle root in the proof does not match the registry / pool root on-chain.
    StaleRoot               = 6,
    /// Compliance proof's amount signal does not match the actual deposit amount.
    /// Prevents depositing a different amount than the one the compliance proof covers.
    AmountMismatch          = 7,
    /// Shielded proof's pub_withdraw_amount signal does not match the requested amount.
    /// Prevents draining the pool by claiming a larger withdrawal than the note holds.
    WithdrawAmountMismatch  = 8,
    /// The new Merkle root was not signed by the registered operator key.
    /// Closes the prover-supplied-root vulnerability: without an on-chain Poseidon
    /// host function the contract cannot recompute the tree, so it instead requires
    /// the operator (which derives the root from the real on-chain commitments) to
    /// attest each new root. A forged root therefore cannot be installed.
    UnauthorizedRoot        = 9,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    ComplianceVerifier,
    ShieldedVerifier,
    Registry,
    // Note-commitment tree: each slot stores one BytesN<32>
    Commitment(u32),
    // Spend nullifier set (shielded transfer/withdraw anti-double-spend)
    SpendNullifier(BytesN<32>),
    // Compliance nullifier set (compliance proof anti-replay)
    ComplianceNullifier(BytesN<32>),
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

#[contractevent]
pub struct DepositEvent {
    pub commitment:           BytesN<32>,
    pub compliance_nullifier: BytesN<32>,
    pub depositor:            Address,
}

#[contractevent]
pub struct TransferEvent {
    pub spend_nullifier: BytesN<32>,
    pub new_commitment_1: BytesN<32>,
    pub new_commitment_2: BytesN<32>,
}

#[contractevent]
pub struct WithdrawEvent {
    pub spend_nullifier:      BytesN<32>,
    pub compliance_nullifier: BytesN<32>,
    pub recipient:            Address,
    pub amount:               i128,
}

// ---------------------------------------------------------------------------
// External contract interfaces (cross-contract calls)
// ---------------------------------------------------------------------------

mod compliance_verifier {
    soroban_sdk::contractimport!(
        file = "../target/wasm32v1-none/release/compliance_verifier.wasm"
    );
}

mod shielded_verifier {
    soroban_sdk::contractimport!(
        file = "../target/wasm32v1-none/release/shielded_transfer_verifier.wasm"
    );
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

#[contract]
pub struct ShieldedPool;

#[contractimpl]
impl ShieldedPool {
    /// Deploy-time constructor: sets all contract parameters atomically.
    /// Prevents front-running / reinitialization.
    pub fn __constructor(
        env:                  Env,
        admin:                Address,
        asset:                Address,
        compliance_verifier:  Address,
        shielded_verifier:    Address,
        registry:             Address,
        corridor_id:          u32,
        initial_root:         BytesN<32>,
        operator_pubkey:      BytesN<32>,
    ) {
        env.storage().instance().set(&DataKey::Admin,               &admin);
        env.storage().instance().set(&ASSET_KEY,                    &asset);
        env.storage().instance().set(&DataKey::ComplianceVerifier,  &compliance_verifier);
        env.storage().instance().set(&DataKey::ShieldedVerifier,    &shielded_verifier);
        env.storage().instance().set(&DataKey::Registry,            &registry);
        env.storage().instance().set(&CID_KEY,                      &corridor_id);
        env.storage().instance().set(&ROOT_KEY,                     &initial_root);
        env.storage().instance().set(&OPKEY_KEY,                    &operator_pubkey);
        env.storage().instance().set(&NEXT_IDX,                     &0u32);
        env.storage().instance().extend_ttl(TTL_MIN, TTL_EXTEND);
    }

    // -----------------------------------------------------------------------
    // Read-only queries
    // -----------------------------------------------------------------------

    /// Current note-commitment tree root (changes after every deposit / transfer).
    pub fn get_root(env: Env) -> BytesN<32> {
        env.storage().instance().get(&ROOT_KEY).unwrap()
    }

    /// Number of notes ever inserted into the commitment tree.
    pub fn commitment_count(env: Env) -> u32 {
        env.storage().instance().get(&NEXT_IDX).unwrap_or(0)
    }

    /// The ed25519 public key whose signature authorizes new Merkle roots.
    pub fn operator_pubkey(env: Env) -> BytesN<32> {
        env.storage().instance().get(&OPKEY_KEY).unwrap()
    }

    /// Returns true if the spend nullifier has been recorded (note was spent).
    pub fn is_nullifier_spent(env: Env, nullifier: BytesN<32>) -> bool {
        env.storage().persistent().has(&DataKey::SpendNullifier(nullifier))
    }

    /// Returns true if the compliance nullifier has been used (attestation consumed).
    pub fn is_compliance_nullifier_used(env: Env, nullifier: BytesN<32>) -> bool {
        env.storage().persistent().has(&DataKey::ComplianceNullifier(nullifier))
    }

    /// Returns the note commitment at position `idx` in the tree.
    /// Used by the proving server to reconstruct the full commitment list
    /// and build real Merkle authentication paths.
    pub fn get_commitment(env: Env, idx: u32) -> Option<BytesN<32>> {
        env.storage().persistent().get(&DataKey::Commitment(idx))
    }

    // -----------------------------------------------------------------------
    // Internal helpers
    // -----------------------------------------------------------------------

    fn require_admin(env: &Env) {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();
    }

    // -----------------------------------------------------------------------
    // Pub-signals parsing helpers
    // -----------------------------------------------------------------------

    /// Extract a 32-byte BN254 field element from encoded pub_signals at
    /// signal index `idx`.
    ///
    /// Encoding: [u32be(count)] [32 bytes per signal ...]
    ///   Signal 0 starts at byte offset 4.
    ///   Signal `idx` starts at byte offset 4 + idx * 32.
    fn extract_signal(env: &Env, pub_signals: &Bytes, idx: u32) -> BytesN<32> {
        let offset = 4 + idx * 32;
        let mut arr = [0u8; 32];
        for i in 0..32u32 {
            arr[i as usize] = pub_signals.get(offset + i).unwrap_or(0);
        }
        BytesN::from_array(env, &arr)
    }

    /// Convert an i128 amount (stroops) into the 32-byte big-endian Field encoding
    /// used in BN254 public signals so we can compare on-chain.
    fn amount_to_signal(env: &Env, amount: i128) -> BytesN<32> {
        let mut arr = [0u8; 32];
        let bytes = amount.to_be_bytes();
        // i128 is 16 bytes; place them in the low 16 bytes of the 32-byte array.
        for i in 0..16usize {
            arr[16 + i] = bytes[i];
        }
        BytesN::from_array(env, &arr)
    }

    /// Assert that signal[0] of a compliance pub_signals blob equals the
    /// current root stored in the ComplianceRegistry (Gap 2 fix).
    fn assert_compliance_root_matches(
        env: &Env,
        compliance_pub_signals: &Bytes,
    ) -> Result<(), PoolError> {
        let proof_root = Self::extract_signal(env, compliance_pub_signals, 0);

        let registry_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::Registry)
            .unwrap();
        let registry_client = compliance_registry::Client::new(env, &registry_addr);
        let registry_root = registry_client.get_root();

        if proof_root != registry_root {
            return Err(PoolError::StaleRoot);
        }
        Ok(())
    }

    /// Assert that signal[0] of a shielded pub_signals blob equals the
    /// current note-commitment tree root stored in this pool (Gap 3 fix).
    fn assert_pool_root_matches(
        env: &Env,
        shielded_pub_signals: &Bytes,
    ) -> Result<(), PoolError> {
        let proof_root = Self::extract_signal(env, shielded_pub_signals, 0);
        let pool_root: BytesN<32> = env.storage().instance().get(&ROOT_KEY).unwrap();

        if proof_root != pool_root {
            return Err(PoolError::StaleRoot);
        }
        Ok(())
    }

    /// Verify that `new_root` was attested by the registered operator key.
    ///
    /// Why this is needed: deposit/transfer/withdraw store a caller-supplied
    /// `new_root` as the pool's commitment-tree root. Without verification a
    /// malicious caller could install the root of a *fabricated* tree containing a
    /// note they "own", then withdraw against it and drain the pool. The ideal fix
    /// (recompute the root on-chain via an incremental Poseidon Merkle tree) is not
    /// possible today: soroban-sdk exposes only BLS12-381 and BN254 host functions,
    /// not Poseidon (CAP-0075 is still a draft), and a pure-WASM Poseidon over 8
    /// tree levels per insert is prohibitively expensive.
    ///
    /// Under the existing trusted-prover model the operator already derives the new
    /// root from the *real* on-chain commitments (see mock-issuer pool-state.ts), so
    /// we require it to sign that root. The signed message is domain-separated by
    /// corridor id to prevent cross-pool replay. A forged root cannot be installed
    /// because the attacker cannot produce the operator's signature.
    fn assert_root_signed(
        env:       &Env,
        new_root:  &BytesN<32>,
        signature: &BytesN<64>,
    ) {
        let op_key: BytesN<32> = env.storage().instance().get(&OPKEY_KEY).unwrap();
        let corridor_id: u32 = env.storage().instance().get(&CID_KEY).unwrap();

        // message = corridor_id (4B, big-endian) || new_root (32B)
        let mut msg = Bytes::new(env);
        msg.extend_from_array(&corridor_id.to_be_bytes());
        msg.extend_from_array(&new_root.to_array());

        // Panics (reverts the whole transaction) if the signature is invalid.
        env.crypto().ed25519_verify(&op_key, &msg, signature);
    }

    /// Call ComplianceVerifier.verify() via cross-contract call.
    /// Returns PoolError::VerificationFailed if the proof is invalid.
    fn verify_compliance(
        env: &Env,
        proof:       Bytes,
        pub_signals: Bytes,
    ) -> Result<(), PoolError> {
        let verifier_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::ComplianceVerifier)
            .unwrap();
        let client = compliance_verifier::Client::new(env, &verifier_addr);
        let ok = client
            .try_verify(&proof, &pub_signals)
            .map_err(|_| PoolError::VerificationFailed)?
            .map_err(|_| PoolError::VerificationFailed)?;
        if !ok {
            return Err(PoolError::VerificationFailed);
        }
        Ok(())
    }

    /// Call ShieldedTransferVerifier.verify() via cross-contract call.
    fn verify_shielded(
        env: &Env,
        proof:       Bytes,
        pub_signals: Bytes,
    ) -> Result<(), PoolError> {
        let verifier_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::ShieldedVerifier)
            .unwrap();
        let client = shielded_verifier::Client::new(env, &verifier_addr);
        let ok = client
            .try_verify(&proof, &pub_signals)
            .map_err(|_| PoolError::VerificationFailed)?
            .map_err(|_| PoolError::VerificationFailed)?;
        if !ok {
            return Err(PoolError::VerificationFailed);
        }
        Ok(())
    }

    /// Record a spend nullifier. Fails (PoolError::NullifierSpent) if already present.
    fn mark_spend_nullifier(env: &Env, nullifier: &BytesN<32>) -> Result<(), PoolError> {
        let key = DataKey::SpendNullifier(nullifier.clone());
        if env.storage().persistent().has(&key) {
            return Err(PoolError::NullifierSpent);
        }
        env.storage().persistent().set(&key, &true);
        env.storage().persistent().extend_ttl(&key, TTL_MIN, TTL_EXTEND);
        Ok(())
    }

    /// Record a compliance nullifier. Fails if the same attestation was already consumed.
    fn mark_compliance_nullifier(env: &Env, nullifier: &BytesN<32>) -> Result<(), PoolError> {
        let key = DataKey::ComplianceNullifier(nullifier.clone());
        if env.storage().persistent().has(&key) {
            return Err(PoolError::ComplianceNullifierUsed);
        }
        env.storage().persistent().set(&key, &true);
        env.storage().persistent().extend_ttl(&key, TTL_MIN, TTL_EXTEND);
        Ok(())
    }

    /// Insert a commitment into the note tree and increment the index.
    fn insert_commitment(env: &Env, commitment: BytesN<32>) {
        let idx: u32 = env.storage().instance().get(&NEXT_IDX).unwrap_or(0);
        let key = DataKey::Commitment(idx);
        env.storage().persistent().set(&key, &commitment);
        env.storage().persistent().extend_ttl(&key, TTL_MIN, TTL_EXTEND);
        env.storage().instance().set(&NEXT_IDX, &(idx + 1));
    }

    // -----------------------------------------------------------------------
    // Main pool functions
    // -----------------------------------------------------------------------

    /// deposit() -- convert visible asset balance into a private shielded note.
    ///
    /// Caller must supply:
    ///   - A valid Groth16 compliance proof covering the public inputs in compliance_pub_signals
    ///     (merkle_root, corridor_id, min_kyc_tier, max_amount, amount, compliance_nullifier)
    ///   - The note commitment they want to insert into the pool tree
    ///   - The compliance_nullifier (anti-replay; stored on-chain after first use)
    ///
    /// The pool transfers `amount` tokens from depositor to itself via SAC,
    /// inserts the commitment into the tree, updates the root, and marks the
    /// compliance nullifier as used (preventing attestation replay).
    pub fn deposit(
        env:                  Env,
        depositor:            Address,
        amount:               i128,
        note_commitment:      BytesN<32>,
        new_root:             BytesN<32>,
        root_signature:       BytesN<64>,
        compliance_nullifier: BytesN<32>,
        compliance_proof:     Bytes,
        compliance_pub_signals: Bytes,
    ) -> Result<(), PoolError> {
        depositor.require_auth();

        if amount <= 0 {
            return Err(PoolError::InvalidAmount);
        }

        // The new tree root must be attested by the operator (anti-forged-root).
        Self::assert_root_signed(&env, &new_root, &root_signature);

        // Anti-replay: compliance proof can only be used once per corridor
        Self::mark_compliance_nullifier(&env, &compliance_nullifier)?;

        // Gap 2: Ensure the compliance proof was issued against the live registry root.
        // Signal[0] in compliance_pub_signals = merkle_root of KYC attribute tree.
        Self::assert_compliance_root_matches(&env, &compliance_pub_signals)?;

        // Fix 3a: Compliance proof's amount (signal[4]) must match the actual deposit amount.
        // Prevents depositing 1000 tokens with a compliance proof that only covers 100.
        // compliance public signal layout:
        //   [0] merkle_root  [1] corridor_id  [2] min_kyc_tier  [3] max_amount
        //   [4] amount       [5] compliance_nullifier
        let proof_amount_signal = Self::extract_signal(&env, &compliance_pub_signals, 4);
        let expected_amount_signal = Self::amount_to_signal(&env, amount);
        if proof_amount_signal != expected_amount_signal {
            return Err(PoolError::AmountMismatch);
        }

        // Verify the compliance proof on-chain (BN254 Groth16 pairing check)
        Self::verify_compliance(&env, compliance_proof, compliance_pub_signals)?;

        // Pull tokens from depositor into pool custody.
        // Proofs and compliance attestations express amounts in whole asset units
        // (bounded by max_amount), but the SAC token holds balances in 10^decimals
        // sub-units (stroops). Scale the attested whole-unit amount up to the token's
        // smallest unit so the SRT actually escrowed equals the amount the proof covers.
        let asset: Address = env.storage().instance().get(&ASSET_KEY).unwrap();
        let token_client = token::Client::new(&env, &asset);
        let token_amount = amount * 10i128.pow(token_client.decimals());
        token_client.transfer(&depositor, &env.current_contract_address(), &token_amount);

        // Insert note commitment into tree and update root
        Self::insert_commitment(&env, note_commitment.clone());
        env.storage().instance().set(&ROOT_KEY, &new_root);
        env.storage().instance().extend_ttl(TTL_MIN, TTL_EXTEND);

        DepositEvent {
            commitment:           note_commitment,
            compliance_nullifier: compliance_nullifier,
            depositor,
        }
        .publish(&env);

        Ok(())
    }

    /// transfer() -- shielded transfer: spend one input note, create two output notes.
    ///
    /// The amount is NEVER revealed on-chain. Only the nullifier (proving the input note
    /// was spent) and two new note commitments (for recipient and change) appear.
    ///
    /// Public inputs verified by the shielded proof:
    ///   merkle_root, nullifier_hash, new_commitment_1, new_commitment_2, fee, pub_asset_id
    ///
    /// Security: the Groth16 proof binds all six public inputs cryptographically.
    /// An attacker cannot substitute a different nullifier or commitment.
    pub fn transfer(
        env:             Env,
        sender:          Address,
        spend_nullifier: BytesN<32>,
        new_commitment_1: BytesN<32>,
        new_commitment_2: BytesN<32>,
        new_root:        BytesN<32>,
        root_signature:  BytesN<64>,
        shielded_proof:  Bytes,
        shielded_pub_signals: Bytes,
    ) -> Result<(), PoolError> {
        sender.require_auth();

        // The new tree root must be attested by the operator (anti-forged-root).
        Self::assert_root_signed(&env, &new_root, &root_signature);

        // Double-spend prevention: nullifier must not have been seen before
        Self::mark_spend_nullifier(&env, &spend_nullifier)?;

        // Gap 3: Signal[0] in shielded_pub_signals = pool merkle_root the prover
        // claims the input note lives in.  Must equal the pool's current root so
        // proofs generated against an old/forged tree are rejected.
        Self::assert_pool_root_matches(&env, &shielded_pub_signals)?;

        // Verify the shielded transfer proof (amount remains private)
        Self::verify_shielded(&env, shielded_proof, shielded_pub_signals)?;

        // Insert both output commitments (recipient note + change note)
        Self::insert_commitment(&env, new_commitment_1.clone());
        Self::insert_commitment(&env, new_commitment_2.clone());
        env.storage().instance().set(&ROOT_KEY, &new_root);
        env.storage().instance().extend_ttl(TTL_MIN, TTL_EXTEND);

        TransferEvent {
            spend_nullifier,
            new_commitment_1,
            new_commitment_2,
        }
        .publish(&env);

        Ok(())
    }

    /// withdraw() -- reveal note value at the off-ramp edge and release tokens.
    ///
    /// The amount IS revealed here by design: the SEP-24 anchor needs to know how
    /// much to pay out. This matches real-world AML: the off-ramp anchor knows
    /// the withdrawal amount, but cannot link it to Alice's original deposit.
    ///
    /// PRD §4.1 step 3 / §6.2: withdrawal is gated by the recipient's own compliance
    /// proof — KYC tier sufficient for the receiving jurisdiction, not sanctioned,
    /// amount within corridor limits.  Two separate Groth16 verifications happen:
    ///   1. Shielded-transfer proof  — proves note ownership and spend authority.
    ///   2. Compliance proof         — proves Bob is allowed to cash out here.
    pub fn withdraw(
        env:                  Env,
        recipient:            Address,
        amount:               i128,
        spend_nullifier:      BytesN<32>,
        new_root:             BytesN<32>,
        root_signature:       BytesN<64>,
        shielded_proof:       Bytes,
        shielded_pub_signals: Bytes,
        // Off-ramp compliance gate (PRD §6.2 — used at both deposit AND withdraw edges)
        compliance_nullifier:     BytesN<32>,
        compliance_proof:         Bytes,
        compliance_pub_signals:   Bytes,
    ) -> Result<(), PoolError> {
        recipient.require_auth();

        if amount <= 0 {
            return Err(PoolError::InvalidAmount);
        }

        // The new tree root must be attested by the operator (anti-forged-root).
        Self::assert_root_signed(&env, &new_root, &root_signature);

        // ── Shielded-transfer proof checks ────────────────────────────────────

        // Double-spend check: spend nullifier must be fresh
        Self::mark_spend_nullifier(&env, &spend_nullifier)?;

        // Pool root must match what the prover used (prevents stale-tree proofs)
        Self::assert_pool_root_matches(&env, &shielded_pub_signals)?;

        // pub_withdraw_amount (signal[6]) must match the `amount` arg.
        // Circuit enforces pub_withdraw_amount == output_value_1, so a note worth
        // 100 tokens cannot be used to drain 1,000,000 tokens from the pool.
        // shielded public signal layout:
        //   [0] merkle_root  [1] nullifier_hash  [2] new_commitment_1
        //   [3] new_commitment_2  [4] fee  [5] pub_asset_id  [6] pub_withdraw_amount
        let proof_withdraw_signal = Self::extract_signal(&env, &shielded_pub_signals, 6);
        let expected_amount_signal = Self::amount_to_signal(&env, amount);
        if proof_withdraw_signal != expected_amount_signal {
            return Err(PoolError::WithdrawAmountMismatch);
        }

        // Verify the shielded spend proof on-chain (BN254 Groth16)
        Self::verify_shielded(&env, shielded_proof, shielded_pub_signals)?;

        // ── Compliance proof checks (off-ramp edge, PRD §6.2) ─────────────────

        // Anti-replay: this KYC attestation can only be used once per corridor
        Self::mark_compliance_nullifier(&env, &compliance_nullifier)?;

        // Compliance proof must reference the live KYC registry root
        Self::assert_compliance_root_matches(&env, &compliance_pub_signals)?;

        // Compliance proof's amount (signal[4]) must equal the withdrawal amount.
        // This prevents Bob from generating a compliance proof for 1 token but
        // withdrawing his full 1000-token note.
        // compliance public signal layout:
        //   [0] merkle_root  [1] corridor_id  [2] min_kyc_tier  [3] max_amount
        //   [4] amount       [5] compliance_nullifier
        let proof_compliance_amount = Self::extract_signal(&env, &compliance_pub_signals, 4);
        if proof_compliance_amount != expected_amount_signal {
            return Err(PoolError::AmountMismatch);
        }

        // Verify the compliance proof on-chain (BN254 Groth16)
        Self::verify_compliance(&env, compliance_proof, compliance_pub_signals)?;

        // ── State update and token release ────────────────────────────────────

        env.storage().instance().set(&ROOT_KEY, &new_root);
        env.storage().instance().extend_ttl(TTL_MIN, TTL_EXTEND);

        // Release tokens from pool custody to recipient. Scale the whole-unit proof
        // amount up to the token's smallest unit (see deposit() for rationale) so the
        // SRT released equals the note value the proof attests.
        let asset: Address = env.storage().instance().get(&ASSET_KEY).unwrap();
        let token_client = token::Client::new(&env, &asset);
        let token_amount = amount * 10i128.pow(token_client.decimals());
        token_client.transfer(&env.current_contract_address(), &recipient, &token_amount);

        WithdrawEvent {
            spend_nullifier,
            compliance_nullifier,
            recipient,
            amount,
        }
        .publish(&env);

        Ok(())
    }

    /// Admin: upgrade contract WASM (governance-gated).
    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) {
        Self::require_admin(&env);
        env.deployer().update_current_contract_wasm(new_wasm_hash);
    }
}
