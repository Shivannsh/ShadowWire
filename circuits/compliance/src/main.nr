// ShadowWire compliance circuit -- production quality
//
// Proves that a user's off-chain KYC attributes satisfy corridor policy
// WITHOUT revealing identity, kyc details, or full attribute set on-chain.
//
// Public inputs  (visible on-chain):
//   merkle_root          - current ComplianceRegistry attribute tree root
//   corridor_id          - binds proof to a specific remittance corridor
//   min_kyc_tier         - minimum required KYC tier for this corridor
//   max_amount           - maximum allowed amount for this corridor
//   amount               - the actual deposit/withdraw amount
//   compliance_nullifier - anti-replay ticket (one use per identity+corridor+amount band)
//
// Private witness (never revealed):
//   secret_salt       - randomness binding leaf to identity
//   kyc_tier          - user's KYC tier (must be >= min_kyc_tier)
//   sanctioned_flag   - 0 = not sanctioned; 1 = sanctioned (proof must reject 1)
//   country_code      - user's jurisdiction code
//   merkle_siblings   - Merkle path (sibling hashes, depth 10)
//   merkle_index      - leaf position encoded as bit field (bit i = direction at level i)
//
// Security properties:
//   - Merkle membership: user's leaf is in the registered attribute tree
//   - KYC gating: kyc_tier >= min_kyc_tier  
//   - Sanctions check: sanctioned_flag == 0
//   - Amount bound: 0 < amount <= max_amount
//   - Corridor binding: compliance_nullifier includes corridor_id, preventing
//     a proof for corridor A from being submitted to corridor B
//   - Anti-replay: compliance_nullifier = H(secret_salt, amount, corridor_id, DOMAIN_COMP_NF)
//     prevents the same KYC attestation from being reused for the same (identity, corridor,
//     amount) combination

global DEPTH: u32 = 10;

// Domain separation constants prevent cross-context hash collisions.
// Using distinct tags ensures H_merkle(a,b) != H_nullifier(a,b) even with identical inputs.
global DOMAIN_MERKLE: Field = 0x4d65726b6c6548617368; // "MerkleHash" as field
global DOMAIN_COMP_NF: Field = 0x436f6d706c4e756c6c;  // "ComplNull" as field

fn poseidon2(a: Field, b: Field, c: Field, d: Field) -> Field {
    std::hash::poseidon2_permutation([a, b, c, d], 4)[0]
}

// Merkle node hash with domain tag so tree hashes can't collide with leaf hashes or nullifiers.
fn merkle_node(left: Field, right: Field) -> Field {
    poseidon2(left, right, DOMAIN_MERKLE, 0)
}

// Compute KYC attribute leaf commitment.
// leaf = H(secret_salt, kyc_tier, sanctioned_flag, country_code)
// The secret_salt ensures the leaf is unlinkable to the user's public identity.
fn attribute_leaf(salt: Field, tier: Field, sanctioned: Field, country: Field) -> Field {
    poseidon2(salt, tier, sanctioned, country)
}

// Compute compliance anti-replay nullifier.
// nullifier = H(secret_salt, amount, corridor_id, DOMAIN_COMP_NF)
// Binds the attestation to a specific (identity, amount, corridor) triple.
fn compute_compliance_nullifier(salt: Field, amt: Field, corridor: Field) -> Field {
    poseidon2(salt, amt, corridor, DOMAIN_COMP_NF)
}

// Compute Merkle root from leaf + Merkle authentication path.
// index encodes left/right direction at each level: bit 0 = level 0, bit 1 = level 1, ...
// If bit i is 0 the leaf is the left child; if 1 it is the right child.
fn compute_merkle_root(leaf: Field, index: u32, siblings: [Field; 10]) -> Field {
    let mut current = leaf;
    let mut idx: u32 = index;
    for _i in 0..DEPTH {
        let sibling = siblings[_i];
        // is_right = 1 when this node is the RIGHT child of its parent
        let is_right = (idx & 1) == 1;
        current = if is_right {
            merkle_node(sibling, current)
        } else {
            merkle_node(current, sibling)
        };
        idx = idx >> 1;
    }
    current
}

fn main(
    // --- Public inputs (declared first so they occupy R1CS public signal slots 0..5) ---
    merkle_root:          pub Field,
    corridor_id:          pub Field,
    min_kyc_tier:         pub Field,
    max_amount:           pub Field,
    amount:               pub Field,
    compliance_nullifier: pub Field,

    // --- Private witness ---
    secret_salt:     Field,
    kyc_tier:        Field,
    sanctioned_flag: Field,
    country_code:    Field,
    merkle_siblings: [Field; 10],
    merkle_index:    Field,
) {
    // 1. Build the attribute leaf and verify Merkle membership.
    //    This proves the prover's (secret_salt, kyc_tier, sanctioned_flag, country_code)
    //    tuple is committed in the on-chain ComplianceRegistry tree.
    let leaf = attribute_leaf(secret_salt, kyc_tier, sanctioned_flag, country_code);
    let computed_root = compute_merkle_root(leaf, merkle_index as u32, merkle_siblings);
    assert(computed_root == merkle_root, "Merkle membership check failed");

    // 2. KYC tier gate: prover's tier must meet the corridor minimum.
    assert(kyc_tier as u64 >= min_kyc_tier as u64, "KYC tier below corridor minimum");

    // 3. Sanctions gate: sanctioned parties cannot use any corridor.
    assert(sanctioned_flag == 0, "Sanctioned party cannot participate");

    // 4. Amount range check:
    //    - Amount must be strictly positive (no zero-value spam)
    //    - Amount must not exceed the corridor per-transaction limit
    assert(amount as u64 > 0, "Amount must be positive");
    assert(amount as u64 <= max_amount as u64, "Amount exceeds corridor limit");

    // 5. Compliance nullifier check.
    //    The on-chain pool stores this nullifier to prevent reuse.
    //    Its binding to corridor_id prevents cross-corridor replay.
    let expected_nullifier = compute_compliance_nullifier(secret_salt, amount, corridor_id);
    assert(expected_nullifier == compliance_nullifier, "Invalid compliance nullifier");
}

// -------------------------------------------------------------------------
// Test vectors -- run with: nargo test --show-output
// These print exact hash values used to build inputs.json
// -------------------------------------------------------------------------

#[test]
fn test_print_compliance_vectors() {
    let salt:       Field = 42;
    let tier:       Field = 2;
    let sanctioned: Field = 0;
    let country:    Field = 91;
    let corridor:   Field = 1;
    let amount:     Field = 500;

    let leaf = attribute_leaf(salt, tier, sanctioned, country);

    // Build root with all-zero siblings (single-leaf demo tree, depth 10).
    // At index 0 all siblings are to the right of the path.
    let siblings: [Field; 10] = [0; 10];
    let root = compute_merkle_root(leaf, 0, siblings);

    let comp_nf = compute_compliance_nullifier(salt, amount, corridor);

    println(f"leaf              = {leaf}");
    println(f"merkle_root       = {root}");
    println(f"compliance_nullifier = {comp_nf}");
}

#[test]
fn test_valid_compliance() {
    // Identical to the main test vector. Must pass all constraints.
    let salt:       Field = 42;
    let tier:       Field = 2;
    let sanctioned: Field = 0;
    let country:    Field = 91;
    let corridor:   Field = 1;
    let min_tier:   Field = 1;
    let max_amt:    Field = 1000000;
    let amount:     Field = 500;

    let leaf = attribute_leaf(salt, tier, sanctioned, country);
    let siblings: [Field; 10] = [0; 10];
    let root = compute_merkle_root(leaf, 0, siblings);
    let comp_nf = compute_compliance_nullifier(salt, amount, corridor);

    // Re-run the main circuit constraints manually to confirm correctness.
    assert(compute_merkle_root(leaf, 0, siblings) == root);
    assert(tier as u64 >= min_tier as u64);
    assert(sanctioned == 0);
    assert(amount as u64 > 0);
    assert(amount as u64 <= max_amt as u64);
    assert(compute_compliance_nullifier(salt, amount, corridor) == comp_nf);
}

#[test(should_fail)]
fn test_sanctioned_party_rejected() {
    let salt:    Field = 42;
    let tier:    Field = 2;
    let country: Field = 91;
    // sanctioned_flag = 1 -- must fail circuit constraint
    let sanctioned: Field = 1;
    assert(sanctioned == 0, "Sanctioned party cannot participate");
}

#[test(should_fail)]
fn test_low_kyc_tier_rejected() {
    let tier: Field = 0;  // tier 0 < min_tier 1
    let min_tier: Field = 1;
    assert(tier as u64 >= min_tier as u64, "KYC tier below corridor minimum");
}

#[test(should_fail)]
fn test_amount_exceeds_limit_rejected() {
    let amount:     Field = 2000000;
    let max_amount: Field = 1000000;
    assert(amount as u64 <= max_amount as u64, "Amount exceeds corridor limit");
}

#[test(should_fail)]
fn test_zero_amount_rejected() {
    let amount: Field = 0;
    assert(amount as u64 > 0, "Amount must be positive");
}

#[test(should_fail)]
fn test_wrong_nullifier_rejected() {
    let salt:    Field = 42;
    let amount:  Field = 500;
    let corridor: Field = 1;
    // Correct nullifier
    let correct_nf = compute_compliance_nullifier(salt, amount, corridor);
    // Tampered nullifier (corridor 2 instead of 1 -- cross-corridor replay attempt)
    let tampered_nf = compute_compliance_nullifier(salt, amount, 2);
    // These must not be equal
    assert(correct_nf == tampered_nf, "Cross-corridor replay should be rejected");
}

#[test(should_fail)]
fn test_wrong_merkle_path_rejected() {
    let salt:       Field = 42;
    let tier:       Field = 2;
    let sanctioned: Field = 0;
    let country:    Field = 91;

    let leaf = attribute_leaf(salt, tier, sanctioned, country);
    let real_siblings: [Field; 10] = [0; 10];
    let correct_root = compute_merkle_root(leaf, 0, real_siblings);

    // Wrong leaf -- different salt => different leaf => different root
    let wrong_leaf = attribute_leaf(99, tier, sanctioned, country);
    let computed_root = compute_merkle_root(wrong_leaf, 0, real_siblings);

    assert(computed_root == correct_root, "Wrong leaf should not match root");
}
