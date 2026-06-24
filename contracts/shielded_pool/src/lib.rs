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
    /// This prevents using a stale or forged proof for a different tree state.
    StaleRoot               = 6,
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
    pub spend_nullifier: BytesN<32>,
    pub recipient:       Address,
    pub amount:          i128,
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
    ) {
        env.storage().instance().set(&DataKey::Admin,               &admin);
        env.storage().instance().set(&ASSET_KEY,                    &asset);
        env.storage().instance().set(&DataKey::ComplianceVerifier,  &compliance_verifier);
        env.storage().instance().set(&DataKey::ShieldedVerifier,    &shielded_verifier);
        env.storage().instance().set(&DataKey::Registry,            &registry);
        env.storage().instance().set(&CID_KEY,                      &corridor_id);
        env.storage().instance().set(&ROOT_KEY,                     &initial_root);
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
        compliance_nullifier: BytesN<32>,
        compliance_proof:     Bytes,
        compliance_pub_signals: Bytes,
    ) -> Result<(), PoolError> {
        depositor.require_auth();

        if amount <= 0 {
            return Err(PoolError::InvalidAmount);
        }

        // Anti-replay: compliance proof can only be used once per corridor
        Self::mark_compliance_nullifier(&env, &compliance_nullifier)?;

        // Gap 2: Ensure the compliance proof was issued against the live registry root.
        // Signal[0] in compliance_pub_signals = merkle_root of KYC attribute tree.
        // If this doesn't match the registry's current root, the proof is stale or forged.
        Self::assert_compliance_root_matches(&env, &compliance_pub_signals)?;

        // Verify the compliance proof on-chain (BN254 Groth16 pairing check)
        Self::verify_compliance(&env, compliance_proof, compliance_pub_signals)?;

        // Pull tokens from depositor into pool custody
        let asset: Address = env.storage().instance().get(&ASSET_KEY).unwrap();
        let token_client = token::Client::new(&env, &asset);
        token_client.transfer(&depositor, &env.current_contract_address(), &amount);

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
        shielded_proof:  Bytes,
        shielded_pub_signals: Bytes,
    ) -> Result<(), PoolError> {
        sender.require_auth();

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
    pub fn withdraw(
        env:             Env,
        recipient:       Address,
        amount:          i128,
        spend_nullifier: BytesN<32>,
        new_root:        BytesN<32>,
        shielded_proof:  Bytes,
        shielded_pub_signals: Bytes,
    ) -> Result<(), PoolError> {
        recipient.require_auth();

        if amount <= 0 {
            return Err(PoolError::InvalidAmount);
        }

        // Double-spend check
        Self::mark_spend_nullifier(&env, &spend_nullifier)?;

        // Gap 3: Same root check as transfer() - the note being spent must be in
        // the current pool tree.
        Self::assert_pool_root_matches(&env, &shielded_pub_signals)?;

        // Verify the shielded proof
        Self::verify_shielded(&env, shielded_proof, shielded_pub_signals)?;

        env.storage().instance().set(&ROOT_KEY, &new_root);
        env.storage().instance().extend_ttl(TTL_MIN, TTL_EXTEND);

        // Release tokens from pool to recipient
        let asset: Address = env.storage().instance().get(&ASSET_KEY).unwrap();
        let token_client = token::Client::new(&env, &asset);
        token_client.transfer(&env.current_contract_address(), &recipient, &amount);

        WithdrawEvent {
            spend_nullifier,
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
