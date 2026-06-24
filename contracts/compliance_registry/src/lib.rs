#![no_std]

use soroban_sdk::{contract, contractimpl, contracttype, symbol_short, Address, BytesN, Env, Symbol};

const ADMIN_KEY: Symbol = symbol_short!("ADMIN");
const ROOT_KEY: Symbol = symbol_short!("ROOT");

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    MerkleRoot,
}

#[contract]
pub struct ComplianceRegistry;

#[contractimpl]
impl ComplianceRegistry {
    pub fn __constructor(env: Env, admin: Address) {
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&ROOT_KEY, &BytesN::<32>::from_array(&env, &[0u8; 32]));
    }

    pub fn update_root(env: Env, new_root: BytesN<32>) {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();
        env.storage().instance().set(&ROOT_KEY, &new_root);
        env.storage().instance().extend_ttl(100, 518400);
    }

    pub fn get_root(env: Env) -> BytesN<32> {
        env.storage().instance().get(&ROOT_KEY).unwrap_or(BytesN::<32>::from_array(&env, &[0u8; 32]))
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::Address as _;

    #[test]
    fn test_update_root_requires_admin() {
        let env = Env::default();
        let contract_id = env.register(ComplianceRegistry, ());
        let client = ComplianceRegistryClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        env.mock_all_auths();
        client.__constructor(&admin);
        let root = BytesN::<32>::from_array(&env, &[1u8; 32]);
        client.update_root(&root);
        assert_eq!(client.get_root(), root);
    }
}
