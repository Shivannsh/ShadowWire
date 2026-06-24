#![no_std]

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, symbol_short, token, Address,
    Bytes, BytesN, Env, Symbol,
};

const ROOT_KEY: Symbol = symbol_short!("ROOT");
const ASSET_KEY: Symbol = symbol_short!("ASSET");
const COMP_VK: Symbol = symbol_short!("CVK");
const SHIELD_VK: Symbol = symbol_short!("SVK");
const NEXT_IDX: Symbol = symbol_short!("NIDX");

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum PoolError {
    NotInitialized = 1,
    NullifierSpent = 2,
    VerificationFailed = 3,
    InvalidAmount = 4,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    ComplianceVerifier,
    ShieldedVerifier,
    Registry,
    Nullifier(BytesN<32>),
    Commitment(u32),
}

#[contractevent]
pub struct DepositEvent {
    pub commitment: BytesN<32>,
    pub depositor: Address,
}

#[contractevent]
pub struct TransferEvent {
    pub nullifier: BytesN<32>,
    pub new_commitment: BytesN<32>,
}

#[contractevent]
pub struct WithdrawEvent {
    pub nullifier: BytesN<32>,
    pub recipient: Address,
    pub amount: i128,
}

mod compliance_verifier {
    soroban_sdk::contractimport!(file = "../target/wasm32v1-none/release/compliance_verifier.wasm");
}

mod shielded_verifier {
    soroban_sdk::contractimport!(file = "../target/wasm32v1-none/release/shielded_transfer_verifier.wasm");
}

#[contract]
pub struct ShieldedPool;

#[contractimpl]
impl ShieldedPool {
    pub fn __constructor(
        env: Env,
        admin: Address,
        asset: Address,
        compliance_verifier: Address,
        shielded_verifier: Address,
        registry: Address,
        initial_root: BytesN<32>,
    ) {
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&ASSET_KEY, &asset);
        env.storage().instance().set(&DataKey::ComplianceVerifier, &compliance_verifier);
        env.storage().instance().set(&DataKey::ShieldedVerifier, &shielded_verifier);
        env.storage().instance().set(&DataKey::Registry, &registry);
        env.storage().instance().set(&ROOT_KEY, &initial_root);
        env.storage().instance().set(&NEXT_IDX, &0u32);
    }

    pub fn get_root(env: Env) -> BytesN<32> {
        env.storage().instance().get(&ROOT_KEY).unwrap()
    }

    pub fn is_nullifier_spent(env: Env, nullifier: BytesN<32>) -> bool {
        env.storage().persistent().has(&DataKey::Nullifier(nullifier))
    }

    fn verify_compliance(env: &Env, proof: Bytes, pub_signals: Bytes) -> Result<(), PoolError> {
        let verifier: Address = env.storage().instance().get(&DataKey::ComplianceVerifier).unwrap();
        let client = compliance_verifier::Client::new(env, &verifier);
        let ok = client
            .try_verify(&proof, &pub_signals)
            .map_err(|_| PoolError::VerificationFailed)?
            .map_err(|_| PoolError::VerificationFailed)?;
        if !ok {
            return Err(PoolError::VerificationFailed);
        }
        Ok(())
    }

    fn verify_shielded(env: &Env, proof: Bytes, pub_signals: Bytes) -> Result<(), PoolError> {
        let verifier: Address = env.storage().instance().get(&DataKey::ShieldedVerifier).unwrap();
        let client = shielded_verifier::Client::new(env, &verifier);
        let ok = client
            .try_verify(&proof, &pub_signals)
            .map_err(|_| PoolError::VerificationFailed)?
            .map_err(|_| PoolError::VerificationFailed)?;
        if !ok {
            return Err(PoolError::VerificationFailed);
        }
        Ok(())
    }

    fn mark_nullifier(env: &Env, nullifier: &BytesN<32>) -> Result<(), PoolError> {
        if env.storage().persistent().has(&DataKey::Nullifier(nullifier.clone())) {
            return Err(PoolError::NullifierSpent);
        }
        env.storage().persistent().set(&DataKey::Nullifier(nullifier.clone()), &true);
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::Nullifier(nullifier.clone()), 100, 518400);
        Ok(())
    }

    fn insert_commitment(env: &Env, commitment: BytesN<32>) {
        let idx: u32 = env.storage().instance().get(&NEXT_IDX).unwrap_or(0);
        env.storage().persistent().set(&DataKey::Commitment(idx), &commitment);
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::Commitment(idx), 100, 518400);
        env.storage().instance().set(&NEXT_IDX, &(idx + 1));
    }

    /// Deposit visible asset into pool after compliance proof verification.
    pub fn deposit(
        env: Env,
        depositor: Address,
        amount: i128,
        commitment: BytesN<32>,
        new_root: BytesN<32>,
        compliance_proof: Bytes,
        compliance_pub_signals: Bytes,
    ) -> Result<(), PoolError> {
        depositor.require_auth();
        if amount <= 0 {
            return Err(PoolError::InvalidAmount);
        }

        Self::verify_compliance(&env, compliance_proof, compliance_pub_signals)?;

        let asset: Address = env.storage().instance().get(&ASSET_KEY).unwrap();
        let token_client = token::Client::new(&env, &asset);
        token_client.transfer(&depositor, &env.current_contract_address(), &amount);

        Self::insert_commitment(&env, commitment.clone());
        env.storage().instance().set(&ROOT_KEY, &new_root);
        env.storage().instance().extend_ttl(100, 518400);

        DepositEvent {
            commitment,
            depositor,
        }
        .publish(&env);
        Ok(())
    }

    /// Shielded transfer — amount hidden; only nullifier + new commitment appear on-chain.
    pub fn transfer(
        env: Env,
        sender: Address,
        nullifier: BytesN<32>,
        new_commitment: BytesN<32>,
        new_root: BytesN<32>,
        shielded_proof: Bytes,
        shielded_pub_signals: Bytes,
    ) -> Result<(), PoolError> {
        sender.require_auth();
        Self::mark_nullifier(&env, &nullifier)?;
        Self::verify_shielded(&env, shielded_proof, shielded_pub_signals)?;
        Self::insert_commitment(&env, new_commitment.clone());
        env.storage().instance().set(&ROOT_KEY, &new_root);
        env.storage().instance().extend_ttl(100, 518400);

        TransferEvent {
            nullifier,
            new_commitment,
        }
        .publish(&env);
        Ok(())
    }

    /// Withdraw to visible balance — amount revealed at off-ramp edge by design.
    pub fn withdraw(
        env: Env,
        recipient: Address,
        amount: i128,
        nullifier: BytesN<32>,
        new_root: BytesN<32>,
        shielded_proof: Bytes,
        shielded_pub_signals: Bytes,
    ) -> Result<(), PoolError> {
        recipient.require_auth();
        if amount <= 0 {
            return Err(PoolError::InvalidAmount);
        }

        Self::mark_nullifier(&env, &nullifier)?;
        Self::verify_shielded(&env, shielded_proof, shielded_pub_signals)?;
        env.storage().instance().set(&ROOT_KEY, &new_root);
        env.storage().instance().extend_ttl(100, 518400);

        let asset: Address = env.storage().instance().get(&ASSET_KEY).unwrap();
        let token_client = token::Client::new(&env, &asset);
        token_client.transfer(&env.current_contract_address(), &recipient, &amount);

        WithdrawEvent {
            nullifier,
            recipient,
            amount,
        }
        .publish(&env);
        Ok(())
    }
}
