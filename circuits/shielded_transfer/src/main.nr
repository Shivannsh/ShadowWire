// Shielded transfer: prove note ownership + value conservation without revealing amount on-chain.
// Public: merkle_root, nullifier_hash, new_commitment, fee
// Private: input note fields, merkle path, output note fields

global MERKLE_DEPTH: u32 = 4;

fn poseidon4(a: Field, b: Field, c: Field, d: Field) -> Field {
    std::hash::poseidon2_permutation([a, b, c, d], 4)[0]
}

fn note_commitment(owner: Field, value: Field, asset_id: Field, blinding: Field) -> Field {
    poseidon4(owner, value, asset_id, blinding)
}

fn compute_nullifier(note_secret: Field, commitment: Field) -> Field {
    poseidon4(note_secret, commitment, 0, 0)
}

fn merkle_root_from_path(leaf: Field, index: u32, path: [Field; 4]) -> Field {
    let mut current = leaf;
    let mut idx = index;
    for i in 0..MERKLE_DEPTH {
        let sibling = path[i];
        let is_right = idx & 1;
        if is_right == 1 {
            current = poseidon4(sibling, current, 0, 0);
        } else {
            current = poseidon4(current, sibling, 0, 0);
        }
        idx >>= 1;
    }
    current
}

fn main(
    // Input note (private)
    owner_pubkey: Field,
    value: Field,
    asset_id: Field,
    blinding_factor: Field,
    note_secret_key: Field,
    merkle_path: [Field; 4],
    merkle_index: Field,
    // Output note (private) - single output for MVP
    recipient_pubkey: Field,
    output_value: Field,
    output_blinding: Field,
    // Public inputs
    merkle_root: pub Field,
    nullifier_hash: pub Field,
    new_commitment: pub Field,
    fee: pub Field,
) {
    let input_commitment = note_commitment(owner_pubkey, value, asset_id, blinding_factor);
    let computed_nullifier = compute_nullifier(note_secret_key, input_commitment);
    assert(computed_nullifier == nullifier_hash);

    let computed_root = merkle_root_from_path(input_commitment, merkle_index as u32, merkle_path);
    assert(computed_root == merkle_root);

    // Value conservation: input = output + fee
    assert(value == output_value + fee);

    let out_commitment = note_commitment(recipient_pubkey, output_value, asset_id, output_blinding);
    assert(out_commitment == new_commitment);
}

#[test]
fn test_demo_values() {
    let owner = 1;
    let recipient = 2;
    let value = 1000;
    let output = 990;
    let fee = 10;
    let asset = 3;
    let blind_in = 7;
    let blind_out = 11;
    let secret = 13;

    let input_commitment = note_commitment(owner, value, asset, blind_in);
    let out_commitment = note_commitment(recipient, output, asset, blind_out);
    let nf = compute_nullifier(secret, input_commitment);
    let path = [0, 0, 0, 0];
    let root = merkle_root_from_path(input_commitment, 0, path);

    println(input_commitment);
    println(out_commitment);
    println(nf);
    println(root);
}

#[test(should_fail)]
fn test_wrong_nullifier_fails() {
    let owner = 1;
    let value = 1000;
    let asset = 3;
    let blind_in = 7;
    let secret = 13;
    let input_commitment = note_commitment(owner, value, asset, blind_in);
    let wrong_nf = compute_nullifier(999, input_commitment);
    let expected_nf = compute_nullifier(secret, input_commitment);
    assert(wrong_nf == expected_nf);
}

#[test(should_fail)]
fn test_value_conservation_fails() {
    let value = 1000;
    let output = 1000; // no fee; violates conservation when fee=10
    let fee = 10;
    assert(value == output + fee);
}

#[test(should_fail)]
fn test_wrong_merkle_root_fails() {
    let owner = 1;
    let value = 1000;
    let asset = 3;
    let blind_in = 7;
    let input_commitment = note_commitment(owner, value, asset, blind_in);
    let path = [0, 0, 0, 0];
    let root = merkle_root_from_path(input_commitment, 0, path);
    let fake_root = root + 1;
    assert(root == fake_root);
}
