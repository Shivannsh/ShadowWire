// compliance_tree_util -- NOT a ZK proving circuit.
//
// A computation helper that builds the depth-10 Poseidon2 KYC attribute tree used
// by compliance.nr and extracts the authentication path for one leaf. It lets the
// mock-issuer register MULTIPLE per-user KYC attestations (each with its own
// country / tier / sanctioned flag) in a single ComplianceRegistry root, instead
// of the previous single hard-coded demo leaf.
//
// It uses the EXACT same primitives as compliance.nr:
//   leaf            = poseidon2(salt, tier, sanctioned, country)
//   merkle_node(l,r)= poseidon2(l, r, DOMAIN_MERKLE, 0)   (depth 10)
//
// Usage (nargo execute):
//   Prover.toml provides up to MAX_USERS attribute tuples + n_active + target_idx.
//   stdout: "Circuit output: (0x<root>, [0x<s0>, ..., 0x<s9>])"

global DEPTH: u32 = 10;
global MAX_USERS: u32 = 8;
global DOMAIN_MERKLE: Field = 0x4d65726b6c6548617368; // "MerkleHash" -- same as compliance.nr

fn poseidon2(a: Field, b: Field, c: Field, d: Field) -> Field {
    std::hash::poseidon2_permutation([a, b, c, d], 4)[0]
}

fn merkle_node(left: Field, right: Field) -> Field {
    poseidon2(left, right, DOMAIN_MERKLE, 0)
}

fn attribute_leaf(salt: Field, tier: Field, sanctioned: Field, country: Field) -> Field {
    poseidon2(salt, tier, sanctioned, country)
}

// Returns (root, siblings[10]) for leaves[target_idx] in a full depth-10 tree
// (1024 leaves, zero-padded). Sibling index trick: sibling of node i is i XOR 1.
fn build(leaves: [Field; 1024], target_idx: u32) -> (Field, [Field; 10]) {
    let mut siblings: [Field; 10] = [0; 10];
    let mut t = target_idx;

    // Level 0 -> 1 (1024 -> 512)
    siblings[0] = leaves[t ^ 1];
    t = t >> 1;
    let mut l1: [Field; 512] = [0; 512];
    for i in 0..512 { l1[i] = merkle_node(leaves[i * 2], leaves[i * 2 + 1]); }

    siblings[1] = l1[t ^ 1];
    t = t >> 1;
    let mut l2: [Field; 256] = [0; 256];
    for i in 0..256 { l2[i] = merkle_node(l1[i * 2], l1[i * 2 + 1]); }

    siblings[2] = l2[t ^ 1];
    t = t >> 1;
    let mut l3: [Field; 128] = [0; 128];
    for i in 0..128 { l3[i] = merkle_node(l2[i * 2], l2[i * 2 + 1]); }

    siblings[3] = l3[t ^ 1];
    t = t >> 1;
    let mut l4: [Field; 64] = [0; 64];
    for i in 0..64 { l4[i] = merkle_node(l3[i * 2], l3[i * 2 + 1]); }

    siblings[4] = l4[t ^ 1];
    t = t >> 1;
    let mut l5: [Field; 32] = [0; 32];
    for i in 0..32 { l5[i] = merkle_node(l4[i * 2], l4[i * 2 + 1]); }

    siblings[5] = l5[t ^ 1];
    t = t >> 1;
    let mut l6: [Field; 16] = [0; 16];
    for i in 0..16 { l6[i] = merkle_node(l5[i * 2], l5[i * 2 + 1]); }

    siblings[6] = l6[t ^ 1];
    t = t >> 1;
    let mut l7: [Field; 8] = [0; 8];
    for i in 0..8 { l7[i] = merkle_node(l6[i * 2], l6[i * 2 + 1]); }

    siblings[7] = l7[t ^ 1];
    t = t >> 1;
    let mut l8: [Field; 4] = [0; 4];
    for i in 0..4 { l8[i] = merkle_node(l7[i * 2], l7[i * 2 + 1]); }

    siblings[8] = l8[t ^ 1];
    t = t >> 1;
    let mut l9: [Field; 2] = [0; 2];
    for i in 0..2 { l9[i] = merkle_node(l8[i * 2], l8[i * 2 + 1]); }

    siblings[9] = l9[t ^ 1];
    let root = merkle_node(l9[0], l9[1]);

    (root, siblings)
}

fn main(
    salts:       [Field; 8],
    tiers:       [Field; 8],
    sanctioned:  [Field; 8],
    countries:   [Field; 8],
    n_active:    u32,
    target_idx:  u32,
) -> pub (Field, [Field; 10]) {
    let mut leaves: [Field; 1024] = [0; 1024];
    for i in 0..MAX_USERS {
        if i < n_active {
            leaves[i] = attribute_leaf(salts[i], tiers[i], sanctioned[i], countries[i]);
        }
    }
    build(leaves, target_idx)
}

// Reconstruct the root from (leaf, index, siblings) using the EXACT logic of
// compliance.nr::compute_merkle_root. If this matches build()'s root, then a
// proof fed these siblings will verify against this root in the proving circuit.
fn reconstruct(leaf: Field, index: u32, siblings: [Field; 10]) -> Field {
    let mut current = leaf;
    let mut idx = index;
    for i in 0..DEPTH {
        let sibling = siblings[i];
        let is_right = (idx & 1) == 1;
        current = if is_right { merkle_node(sibling, current) } else { merkle_node(current, sibling) };
        idx = idx >> 1;
    }
    current
}

// Two distinct users (e.g. US sender, NG receiver) -> distinct leaves; the path
// for each must reconstruct the same shared root.
#[test]
fn test_two_user_paths_reconstruct_root() {
    let salts:      [Field; 8] = [42, 99, 0, 0, 0, 0, 0, 0];
    let tiers:      [Field; 8] = [2, 2, 0, 0, 0, 0, 0, 0];
    let sanctioned: [Field; 8] = [0; 8];
    let countries:  [Field; 8] = [840, 566, 0, 0, 0, 0, 0, 0]; // US, NG

    let (root0, sib0) = main(salts, tiers, sanctioned, countries, 2, 0);
    let (root1, sib1) = main(salts, tiers, sanctioned, countries, 2, 1);
    assert(root0 == root1, "both leaves share one root");

    let leaf0 = attribute_leaf(42, 2, 0, 840);
    let leaf1 = attribute_leaf(99, 2, 0, 566);
    assert(reconstruct(leaf0, 0, sib0) == root0, "user0 path must reconstruct root");
    assert(reconstruct(leaf1, 1, sib1) == root1, "user1 path must reconstruct root");
    println(f"two_user_root = {root0}");
}
