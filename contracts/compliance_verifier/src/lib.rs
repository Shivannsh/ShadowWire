#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl,
    crypto::bn254::{
        Bn254G1Affine, Bn254G2Affine, Fr, BN254_G1_SERIALIZED_SIZE, BN254_G2_SERIALIZED_SIZE,
    },
    symbol_short, vec, Bytes, Env, Symbol, Vec, U256,
};

const VK_KEY: Symbol = symbol_short!("VK");

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum VerifierError {
    MalformedVerifyingKey = 1,
    VerificationKeyNotSet = 2,
    MalformedProof = 3,
    MalformedPublicSignals = 4,
}

#[derive(Clone)]
struct VerificationKey {
    alpha: Bn254G1Affine,
    beta: Bn254G2Affine,
    gamma: Bn254G2Affine,
    delta: Bn254G2Affine,
    ic: Vec<Bn254G1Affine>,
}

#[derive(Clone)]
struct Proof {
    a: Bn254G1Affine,
    b: Bn254G2Affine,
    c: Bn254G1Affine,
}

fn take<const N: usize>(
    bytes: &Bytes,
    pos: &mut u32,
    err: VerifierError,
) -> Result<[u8; N], VerifierError> {
    let end = pos.checked_add(N as u32).ok_or(err)?;
    if end > bytes.len() {
        return Err(err);
    }
    let mut arr = [0u8; N];
    bytes.slice(*pos..end).copy_into_slice(&mut arr);
    *pos = end;
    Ok(arr)
}

impl VerificationKey {
    fn from_bytes(env: &Env, bytes: &Bytes) -> Result<Self, VerifierError> {
        let mut pos = 0u32;
        let alpha = Bn254G1Affine::from_array(
            env,
            &take::<BN254_G1_SERIALIZED_SIZE>(bytes, &mut pos, VerifierError::MalformedVerifyingKey)?,
        );
        let beta = Bn254G2Affine::from_array(
            env,
            &take::<BN254_G2_SERIALIZED_SIZE>(bytes, &mut pos, VerifierError::MalformedVerifyingKey)?,
        );
        let gamma = Bn254G2Affine::from_array(
            env,
            &take::<BN254_G2_SERIALIZED_SIZE>(bytes, &mut pos, VerifierError::MalformedVerifyingKey)?,
        );
        let delta = Bn254G2Affine::from_array(
            env,
            &take::<BN254_G2_SERIALIZED_SIZE>(bytes, &mut pos, VerifierError::MalformedVerifyingKey)?,
        );
        let ic_len_bytes = take::<4>(bytes, &mut pos, VerifierError::MalformedVerifyingKey)?;
        let ic_len = u32::from_be_bytes(ic_len_bytes);
        let mut ic = Vec::new(env);
        for _ in 0..ic_len {
            let g1 = Bn254G1Affine::from_array(
                env,
                &take::<BN254_G1_SERIALIZED_SIZE>(bytes, &mut pos, VerifierError::MalformedVerifyingKey)?,
            );
            ic.push_back(g1);
        }
        if pos != bytes.len() || ic_len == 0 {
            return Err(VerifierError::MalformedVerifyingKey);
        }
        Ok(Self { alpha, beta, gamma, delta, ic })
    }
}

impl Proof {
    fn from_bytes(env: &Env, bytes: &Bytes) -> Result<Self, VerifierError> {
        let mut pos = 0u32;
        let a = Bn254G1Affine::from_array(
            env,
            &take::<BN254_G1_SERIALIZED_SIZE>(bytes, &mut pos, VerifierError::MalformedProof)?,
        );
        let b = Bn254G2Affine::from_array(
            env,
            &take::<BN254_G2_SERIALIZED_SIZE>(bytes, &mut pos, VerifierError::MalformedProof)?,
        );
        let c = Bn254G1Affine::from_array(
            env,
            &take::<BN254_G1_SERIALIZED_SIZE>(bytes, &mut pos, VerifierError::MalformedProof)?,
        );
        if pos != bytes.len() {
            return Err(VerifierError::MalformedProof);
        }
        Ok(Self { a, b, c })
    }
}

fn decode_public_signals(env: &Env, bytes: &Bytes) -> Result<Vec<Fr>, VerifierError> {
    let mut pos = 0u32;
    let len_bytes = take::<4>(bytes, &mut pos, VerifierError::MalformedPublicSignals)?;
    let len = u32::from_be_bytes(len_bytes);
    let mut pub_signals = Vec::new(env);
    for _ in 0..len {
        let arr = take::<32>(bytes, &mut pos, VerifierError::MalformedPublicSignals)?;
        let u256 = U256::from_be_bytes(env, &Bytes::from_array(env, &arr));
        pub_signals.push_back(Fr::from_u256(u256));
    }
    if pos != bytes.len() {
        return Err(VerifierError::MalformedPublicSignals);
    }
    Ok(pub_signals)
}

fn verify_groth16(
    env: &Env,
    vk: VerificationKey,
    proof: Proof,
    pub_signals: Vec<Fr>,
) -> Result<bool, VerifierError> {
    if pub_signals.len() + 1 != vk.ic.len() {
        return Err(VerifierError::MalformedVerifyingKey);
    }
    let bn = env.crypto().bn254();
    let mut vk_x = vk.ic.get(0).unwrap();
    for (s, v) in pub_signals.iter().zip(vk.ic.iter().skip(1)) {
        let prod = bn.g1_mul(&v, &s);
        vk_x = bn.g1_add(&vk_x, &prod);
    }
    let neg_a = -proof.a;
    let vp1 = vec![env, neg_a, vk.alpha, vk_x, proof.c];
    let vp2 = vec![env, proof.b, vk.beta, vk.gamma, vk.delta];
    Ok(bn.pairing_check(vp1, vp2))
}

#[contract]
pub struct ComplianceVerifier;

#[contractimpl]
impl ComplianceVerifier {
    pub fn set_vk(env: Env, vk_bytes: Bytes) -> Result<(), VerifierError> {
        let _vk = VerificationKey::from_bytes(&env, &vk_bytes)?;
        env.storage().instance().set(&VK_KEY, &vk_bytes);
        Ok(())
    }

    pub fn verify(env: Env, proof_bytes: Bytes, pub_signals_bytes: Bytes) -> Result<bool, VerifierError> {
        let vk_bytes: Bytes = env
            .storage()
            .instance()
            .get(&VK_KEY)
            .ok_or(VerifierError::VerificationKeyNotSet)?;
        let vk = VerificationKey::from_bytes(&env, &vk_bytes)?;
        let proof = Proof::from_bytes(&env, &proof_bytes)?;
        let pub_signals = decode_public_signals(&env, &pub_signals_bytes)?;
        verify_groth16(&env, vk, proof, pub_signals)
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::Env;

    #[test]
    fn test_not_initialized() {
        let env = Env::default();
        let contract_id = env.register(ComplianceVerifier, ());
        let client = ComplianceVerifierClient::new(&env, &contract_id);
        let proof = Bytes::from_array(&env, &[0u8; 32]);
        let pub_signals = Bytes::from_array(&env, &[0u8; 4]);
        assert_eq!(
            client.try_verify(&proof, &pub_signals),
            Err(Ok(VerifierError::VerificationKeyNotSet))
        );
    }
}
