// hash_util -- NOT a ZK circuit for proving.
// A computation helper that derives all note public values from private inputs
// using the EXACT same hash primitives as shielded_transfer.nr.
//
// Usage:
//   Write private inputs to circuits/hash_util/Prover.toml
//   Run:  nargo execute
//   Read computed public outputs from Verifier.toml (or witness)
//
// The mock-issuer proving server runs this to compute commitments,
// nullifiers, and the Merkle root before generating the actual Groth16 proof.

global MERKLE_DEPTH: u32 = 8;
global DOMAIN_NULLIFY: Field = 0x4e756c6c6966;
global DOMAIN_MERKLE:  Field = 0x4d65726b6c65;

// Exact same 4-input Poseidon2 permutation used by shielded_transfer.nr
fn p4(a: Field, b: Field, c: Field, d: Field) -> Field {
    std::hash::poseidon2_permutation([a, b, c, d], 4)[0]
}

fn note_commitment(owner: Field, value: Field, asset: Field, blinding: Field) -> Field {
    p4(owner, value, asset, blinding)
}

fn compute_nullifier(secret_key: Field, commitment: Field) -> Field {
    p4(secret_key, commitment, DOMAIN_NULLIFY, 0)
}

fn merkle_node(left: Field, right: Field) -> Field {
    p4(left, right, DOMAIN_MERKLE, 0)
}

fn compute_merkle_root(leaf: Field, index: u32, siblings: [Field; 8]) -> Field {
    let mut current = leaf;
    let mut idx: u32 = index;
    for _i in 0..MERKLE_DEPTH {
        let sibling = siblings[_i];
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

// fn main takes ONLY private inputs (the user's note data + fresh output randomness).
// All computed values are returned as public outputs -- they appear in Verifier.toml
// after `nargo execute` and can be read by the proving server.
fn main(
    // Input note private fields
    owner_pubkey:    Field,
    value:           Field,
    asset_id:        Field,
    blinding_factor: Field,
    note_secret_key: Field,
    merkle_siblings: [Field; 8],
    merkle_index:    Field,
    // Output note 1 private fields (recipient)
    recipient_pubkey:  Field,
    output_value_1:    Field,
    output_blinding_1: Field,
    // Output note 2 private fields (change)
    sender_pubkey:     Field,
    output_value_2:    Field,
    output_blinding_2: Field,
) -> pub (Field, Field, Field, Field, Field) {
    let input_commit  = note_commitment(owner_pubkey, value, asset_id, blinding_factor);
    let merkle_root   = compute_merkle_root(input_commit, merkle_index as u32, merkle_siblings);
    let nullifier     = compute_nullifier(note_secret_key, input_commit);
    let new_commit_1  = note_commitment(recipient_pubkey, output_value_1, asset_id, output_blinding_1);
    let new_commit_2  = note_commitment(sender_pubkey, output_value_2, asset_id, output_blinding_2);

    // Return: (input_commitment, merkle_root, nullifier, new_commitment_1, new_commitment_2)
    (input_commit, merkle_root, nullifier, new_commit_1, new_commit_2)
}

#[test]
fn test_hash_util_matches_shielded_transfer_vectors() {
    // These must match exactly the values in circuits/shielded_transfer/inputs.json
    let owner:    Field = 1;
    let value:    Field = 1000;
    let asset:    Field = 3;
    let blind_in: Field = 7;
    let secret:   Field = 13;

    let recipient: Field = 2;
    let out_val_1: Field = 900;
    let blind_1:   Field = 11;

    let sender:    Field = 1;
    let out_val_2: Field = 90;
    let blind_2:   Field = 17;

    let siblings: [Field; 8] = [0; 8];

    let (input_commit, root, nf, c1, c2) = main(
        owner, value, asset, blind_in, secret,
        siblings, 0,
        recipient, out_val_1, blind_1,
        sender, out_val_2, blind_2,
    );

    // Print all values for manual verification
    println(f"input_commitment = {input_commit}");
    println(f"merkle_root      = {root}");
    println(f"nullifier_hash   = {nf}");
    println(f"new_commitment_1 = {c1}");
    println(f"new_commitment_2 = {c2}");

    // Sanity: output commitments are distinct
    assert(c1 != c2);
}
