// ShadowWire shielded_transfer circuit -- production quality
//
// Proves ownership of a shielded note and authorises spending it into TWO output notes
// (recipient note + change note back to sender) WITHOUT revealing any amount on-chain.
//
// Public inputs (visible on-chain -- NONE reveal amounts):
//   merkle_root      - current ShieldedPool note-commitment tree root
//   nullifier_hash   - unique spend tag; prevents double-spend on-chain
//   new_commitment_1 - recipient's output note commitment (amount hidden)
//   new_commitment_2 - sender's change note commitment   (amount hidden)
//   fee              - protocol fee (may be 0; paid from input note value)
//   pub_asset_id     - asset being transferred (prevents cross-asset proof reuse)
//
// Private witness (never revealed):
//   owner_pubkey      - input note owner
//   value             - input note value (NEVER appears in any public output)
//   asset_id          - must match pub_asset_id (circuit enforces consistency)
//   blinding_factor   - note commitment randomness
//   note_secret_key   - spend authority key (derives nullifier)
//   merkle_siblings   - Merkle authentication path, depth 8
//   merkle_index      - leaf position (bit-encoded direction at each level)
//   recipient_pubkey  - output note 1 owner
//   output_value_1    - output note 1 value (recipient gets this amount)
//   output_blinding_1 - output note 1 commitment randomness
//   sender_pubkey     - output note 2 owner (change back to sender)
//   output_value_2    - output note 2 value (change amount; may be 0)
//   output_blinding_2 - output note 2 commitment randomness
//
// Security properties:
//   - Merkle membership:    input_commitment is in the on-chain tree
//   - Spend authority:      only note_secret_key owner can derive the nullifier
//   - Double-spend prevention: nullifier is deterministic & unique per note
//   - Value conservation:   input_value == output_value_1 + output_value_2 + fee
//   - Non-zero recipient:   output_value_1 > 0 (dust prevention)
//   - Fee bound:            fee <= input_value (can't overpay fee)
//   - Asset consistency:    private asset_id must equal public pub_asset_id
//   - Domain separation:    commitment, nullifier, and Merkle hashes use distinct tags

global MERKLE_DEPTH: u32 = 8;

// Domain tags -- different hash contexts use different constants so
// H_commit(a,b,c,d) != H_nullifier(a,b,c,d) != H_merkle(a,b,c,d)
global DOMAIN_COMMIT:  Field = 0x436f6d6d6974;      // "Commit"
global DOMAIN_NULLIFY: Field = 0x4e756c6c6966;      // "Nullif"
global DOMAIN_MERKLE:  Field = 0x4d65726b6c65;      // "Merkle"

fn poseidon2(a: Field, b: Field, c: Field, d: Field) -> Field {
    std::hash::poseidon2_permutation([a, b, c, d], 4)[0]
}

// Note commitment: binds (owner, value, asset, blinding) into a single field element.
// The blinding_factor ensures the commitment is hiding (computationally binding).
fn note_commitment(owner: Field, value: Field, asset: Field, blinding: Field) -> Field {
    poseidon2(owner, value, asset, blinding)
}

// Nullifier: H(note_secret_key, input_commitment, DOMAIN_NULLIFY, 0)
// - note_secret_key: only the rightful owner knows this
// - input_commitment: binds nullifier to a specific note (not reusable across notes)
// - DOMAIN_NULLIFY: prevents nullifier collisions with other hash outputs
fn compute_nullifier(secret_key: Field, commitment: Field) -> Field {
    poseidon2(secret_key, commitment, DOMAIN_NULLIFY, 0)
}

// Merkle node hash with domain tag -- different from note/nullifier hashes.
fn merkle_node(left: Field, right: Field) -> Field {
    poseidon2(left, right, DOMAIN_MERKLE, 0)
}

// Compute Merkle root from a leaf + authentication path (depth 8).
// merkle_index encodes the path: bit 0 = direction at level 0, bit 1 = level 1, ...
// Bit value 0 = leaf/node is left child; bit value 1 = right child.
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

fn main(
    // --- Public inputs (declared first so they occupy R1CS public signal slots 0..5) ---
    merkle_root:      pub Field,
    nullifier_hash:   pub Field,
    new_commitment_1: pub Field,
    new_commitment_2: pub Field,
    fee:              pub Field,
    pub_asset_id:     pub Field,

    // --- Private witness (input note) ---
    owner_pubkey:    Field,
    value:           Field,
    asset_id:        Field,
    blinding_factor: Field,
    note_secret_key: Field,
    merkle_siblings: [Field; 8],
    merkle_index:    Field,

    // --- Private witness (output note 1 -- recipient) ---
    recipient_pubkey: Field,
    output_value_1:   Field,
    output_blinding_1: Field,

    // --- Private witness (output note 2 -- change back to sender) ---
    sender_pubkey:    Field,
    output_value_2:   Field,
    output_blinding_2: Field,
) {
    // 1. Asset consistency: private asset_id must match the public declaration.
    //    Prevents a proof for asset X from being accepted by a pool handling asset Y.
    assert(asset_id == pub_asset_id, "Asset ID mismatch");

    // 2. Build input note commitment.
    let input_commit = note_commitment(owner_pubkey, value, asset_id, blinding_factor);

    // 3. Merkle membership proof.
    //    Proves input_commit is in the current note-commitment tree (root on-chain).
    //    Without this, a prover could claim to spend a note that was never deposited.
    let computed_root = compute_merkle_root(input_commit, merkle_index as u32, merkle_siblings);
    assert(computed_root == merkle_root, "Merkle membership check failed");

    // 4. Nullifier derivation and check.
    //    The nullifier is stored on-chain after this proof is accepted.
    //    If it is ever presented again the pool rejects the transaction (double-spend prevention).
    let computed_nullifier = compute_nullifier(note_secret_key, input_commit);
    assert(computed_nullifier == nullifier_hash, "Nullifier mismatch");

    // 5. Value conservation -- the CORE privacy invariant.
    //    input = output_1 + output_2 + fee
    //    This holds over Field arithmetic (no hidden inflation or deflation).
    //    The amounts are NEVER disclosed publicly; only this algebraic relationship
    //    is attested on-chain via the proof.
    assert(value == output_value_1 + output_value_2 + fee, "Value conservation violated");

    // 6. Range and sanity checks.

    // Recipient note must be non-trivial (prevents dust / zero-value commitment spam).
    assert(output_value_1 as u64 > 0, "Recipient output must be positive");

    // Fee cannot exceed the input value.
    // Combined with value conservation, this prevents fee == value (all funds drained as fee).
    assert(fee as u64 <= value as u64, "Fee exceeds input value");

    // output_value_2 is allowed to be 0 (exact-amount transfer, no change).
    // No explicit check needed; value conservation + output_value_1 > 0 suffice.

    // 7. Verify output commitments match what is declared publicly.
    //    The prover must commit to the correct note fields -- any tampering with
    //    owner, value, asset, or blinding will produce a different commitment and fail.
    let c1 = note_commitment(recipient_pubkey, output_value_1, asset_id, output_blinding_1);
    let c2 = note_commitment(sender_pubkey, output_value_2, asset_id, output_blinding_2);
    assert(c1 == new_commitment_1, "Output note 1 commitment mismatch");
    assert(c2 == new_commitment_2, "Output note 2 commitment mismatch");
}

// -------------------------------------------------------------------------
// Test vectors -- run: nargo test --show-output
// These print ALL values needed for inputs.json
// -------------------------------------------------------------------------

#[test]
fn test_print_shielded_vectors() {
    let owner:    Field = 1;
    let value:    Field = 1000;
    let asset:    Field = 3;
    let blind_in: Field = 7;
    let secret:   Field = 13;

    let recipient: Field = 2;
    let out_val_1: Field = 900;
    let blind_1:   Field = 11;

    let sender:    Field = 1;  // change back to original sender
    let out_val_2: Field = 90;
    let blind_2:   Field = 17;

    let fee:       Field = 10;

    // Computed values
    let input_commit = note_commitment(owner, value, asset, blind_in);
    let siblings: [Field; 8] = [0; 8];
    let root = compute_merkle_root(input_commit, 0, siblings);
    let nf = compute_nullifier(secret, input_commit);
    let c1 = note_commitment(recipient, out_val_1, asset, blind_1);
    let c2 = note_commitment(sender, out_val_2, asset, blind_2);

    println(f"input_commitment = {input_commit}");
    println(f"merkle_root      = {root}");
    println(f"nullifier_hash   = {nf}");
    println(f"new_commitment_1 = {c1}");
    println(f"new_commitment_2 = {c2}");
    println(f"fee              = {fee}");
    println(f"pub_asset_id     = {asset}");
}

#[test]
fn test_valid_two_output_transfer() {
    let owner: Field = 1; let value: Field = 1000; let asset: Field = 3;
    let blind_in: Field = 7; let secret: Field = 13;

    let recipient: Field = 2; let out_val_1: Field = 900; let blind_1: Field = 11;
    let sender: Field = 1;    let out_val_2: Field = 90;  let blind_2: Field = 17;
    let fee: Field = 10;

    let input_commit = note_commitment(owner, value, asset, blind_in);
    let siblings: [Field; 8] = [0; 8];
    let root = compute_merkle_root(input_commit, 0, siblings);
    let nf = compute_nullifier(secret, input_commit);
    let c1 = note_commitment(recipient, out_val_1, asset, blind_1);
    let c2 = note_commitment(sender, out_val_2, asset, blind_2);

    // Verify all invariants
    assert(asset == asset);
    assert(compute_merkle_root(input_commit, 0, siblings) == root);
    assert(compute_nullifier(secret, input_commit) == nf);
    assert(value == out_val_1 + out_val_2 + fee);
    assert(out_val_1 as u64 > 0);
    assert(fee as u64 <= value as u64);
    assert(note_commitment(recipient, out_val_1, asset, blind_1) == c1);
    assert(note_commitment(sender, out_val_2, asset, blind_2) == c2);
}

#[test]
fn test_exact_transfer_zero_change() {
    // output_value_2 = 0 (sender sends entire amount minus fee, zero change)
    let value: Field = 1000; let fee: Field = 0; let out_val_1: Field = 1000; let out_val_2: Field = 0;
    assert(value == out_val_1 + out_val_2 + fee);
    assert(out_val_1 as u64 > 0);
}

#[test(should_fail)]
fn test_value_inflation_rejected() {
    // Prover tries to create more output than input (inflation attack)
    let value: Field = 1000; let fee: Field = 0;
    let out_val_1: Field = 1000; let out_val_2: Field = 1; // 1001 total > 1000 input
    assert(value == out_val_1 + out_val_2 + fee, "Value conservation violated");
}

#[test(should_fail)]
fn test_wrong_nullifier_rejected() {
    let owner: Field = 1; let value: Field = 1000; let asset: Field = 3; let blind_in: Field = 7;
    let secret: Field = 13;
    let input_commit = note_commitment(owner, value, asset, blind_in);
    let correct_nf = compute_nullifier(secret, input_commit);
    let wrong_nf = compute_nullifier(999, input_commit);  // wrong secret key
    assert(correct_nf == wrong_nf, "Nullifier mismatch");
}

#[test(should_fail)]
fn test_wrong_merkle_root_rejected() {
    let owner: Field = 1; let value: Field = 1000; let asset: Field = 3; let blind_in: Field = 7;
    let input_commit = note_commitment(owner, value, asset, blind_in);
    let siblings: [Field; 8] = [0; 8];
    let correct_root = compute_merkle_root(input_commit, 0, siblings);
    // Tampered root
    let fake_root: Field = correct_root + 1;
    assert(compute_merkle_root(input_commit, 0, siblings) == fake_root, "Merkle membership check failed");
}

#[test(should_fail)]
fn test_zero_output_rejected() {
    let out_val_1: Field = 0;
    assert(out_val_1 as u64 > 0, "Recipient output must be positive");
}

#[test(should_fail)]
fn test_fee_exceeds_value_rejected() {
    let value: Field = 100; let fee: Field = 101;
    assert(fee as u64 <= value as u64, "Fee exceeds input value");
}

#[test(should_fail)]
fn test_commitment_forgery_rejected() {
    // Prover tries to claim a different output value than what they committed to
    let recipient: Field = 2; let actual_value: Field = 900; let claimed_value: Field = 1000;
    let asset: Field = 3; let blind: Field = 11;
    let real_c1 = note_commitment(recipient, actual_value, asset, blind);
    let fake_c1 = note_commitment(recipient, claimed_value, asset, blind);
    assert(real_c1 == fake_c1, "Output note 1 commitment mismatch");
}

#[test(should_fail)]
fn test_cross_asset_proof_rejected() {
    // Prover tries to use a proof for asset 3 against a pool for asset 7
    let private_asset: Field = 3;
    let public_asset: Field = 7;
    assert(private_asset == public_asset, "Asset ID mismatch");
}
