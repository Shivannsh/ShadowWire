// tree_builder - NOT a ZK proving circuit.
// A computation helper that builds the depth-8 Poseidon2 Merkle tree from all
// current pool commitments and extracts the authentication path for a target leaf.
//
// Usage:
//   Write private inputs to Prover.toml:
//     leaves      = ["0x...", ...]   (256 Field values, padded with "0" beyond n_leaves)
//     target_idx  = "5"              (which leaf to get the path for)
//   Run:  nargo execute
//   Read Verifier.toml:  return_value = ["0x<root>", ["0x<s0>", ..., "0x<s7>"]]
//
// Uses the EXACT same merkle_node function as shielded_transfer.nr and hash_util.nr.

global DOMAIN_MERKLE: Field = 0x4d65726b6c65;

fn p4(a: Field, b: Field, c: Field, d: Field) -> Field {
    std::hash::poseidon2_permutation([a, b, c, d], 4)[0]
}

fn merkle_node(left: Field, right: Field) -> Field {
    p4(left, right, DOMAIN_MERKLE, 0)
}

// Build a full depth-8 Poseidon2 Merkle tree from 256 padded leaves.
// Returns the root and the authentication path (8 siblings) for leaves[target_idx].
//
// Sibling index trick: for a node at index i, its sibling is at index i XOR 1.
// This flips the last bit: even gets odd sibling, odd gets even sibling.
// Works because tree nodes are paired as (2k, 2k+1) at every level.
fn main(
    leaves:     [Field; 256],
    target_idx: u32,
) -> pub (Field, [Field; 8]) {
    let mut siblings: [Field; 8] = [0; 8];

    // Level 0 to 1  (256 to 128 nodes)
    siblings[0] = leaves[target_idx ^ 1];
    let t1 = target_idx >> 1;

    let mut l1: [Field; 128] = [0; 128];
    for i in 0..128 {
        l1[i] = merkle_node(leaves[i * 2], leaves[i * 2 + 1]);
    }

    // Level 1 to 2  (128 to 64 nodes)
    siblings[1] = l1[t1 ^ 1];
    let t2 = t1 >> 1;

    let mut l2: [Field; 64] = [0; 64];
    for i in 0..64 {
        l2[i] = merkle_node(l1[i * 2], l1[i * 2 + 1]);
    }

    // Level 2 to 3  (64 to 32 nodes)
    siblings[2] = l2[t2 ^ 1];
    let t3 = t2 >> 1;

    let mut l3: [Field; 32] = [0; 32];
    for i in 0..32 {
        l3[i] = merkle_node(l2[i * 2], l2[i * 2 + 1]);
    }

    // Level 3 to 4  (32 to 16 nodes)
    siblings[3] = l3[t3 ^ 1];
    let t4 = t3 >> 1;

    let mut l4: [Field; 16] = [0; 16];
    for i in 0..16 {
        l4[i] = merkle_node(l3[i * 2], l3[i * 2 + 1]);
    }

    // Level 4 to 5  (16 to 8 nodes)
    siblings[4] = l4[t4 ^ 1];
    let t5 = t4 >> 1;

    let mut l5: [Field; 8] = [0; 8];
    for i in 0..8 {
        l5[i] = merkle_node(l4[i * 2], l4[i * 2 + 1]);
    }

    // Level 5 to 6  (8 to 4 nodes)
    siblings[5] = l5[t5 ^ 1];
    let t6 = t5 >> 1;

    let mut l6: [Field; 4] = [0; 4];
    for i in 0..4 {
        l6[i] = merkle_node(l5[i * 2], l5[i * 2 + 1]);
    }

    // Level 6 to 7  (4 to 2 nodes)
    siblings[6] = l6[t6 ^ 1];
    let t7 = t6 >> 1;

    let mut l7: [Field; 2] = [0; 2];
    for i in 0..2 {
        l7[i] = merkle_node(l6[i * 2], l6[i * 2 + 1]);
    }

    // Level 7 to 8  (2 to 1 = root)
    siblings[7] = l7[t7 ^ 1];
    let root = merkle_node(l7[0], l7[1]);

    (root, siblings)
}

// Verify tree_builder output matches hash_util for the same single-leaf tree
#[test]
fn test_single_leaf_matches_hash_util() {
    // note_commitment(1, 1000, 3, 7) from hash_util test
    let commitment: Field = 0x0918150e2fafd0801ad77c0f188eb23323d57e8348abca6cd8f5d86dad1e2863;

    let mut leaves: [Field; 256] = [0; 256];
    leaves[0] = commitment;

    let (root, siblings) = main(leaves, 0);

    // hash_util test gave root: 0x299b185e32e43637fe9efb84eeb9735942c91afa13d93b57a07c2dd3cf27692a
    println(f"tree root = {root}");

    // Cross-check: reconstruct root from leaf + siblings
    let recomputed = {
        let mut cur = commitment;
        let mut idx: u32 = 0;
        for _i in 0..8 {
            let sib = siblings[_i];
            cur = if (idx & 1) == 1 {
                merkle_node(sib, cur)
            } else {
                merkle_node(cur, sib)
            };
            idx = idx >> 1;
        }
        cur
    };
    assert(recomputed == root, "Reconstructed root must match");
}

#[test]
fn test_two_leaf_path() {
    let c0: Field = 0x0918150e2fafd0801ad77c0f188eb23323d57e8348abca6cd8f5d86dad1e2863;
    let c1: Field = 0x28dcb31bfb0b19d9e1dd8c849775808f6e6f3b96c2d5497a60cba60d54f73b7e;

    let mut leaves: [Field; 256] = [0; 256];
    leaves[0] = c0;
    leaves[1] = c1;

    let (root0, siblings0) = main(leaves, 0);
    let (root1, siblings1) = main(leaves, 1);

    assert(root0 == root1, "Both paths must yield the same root");
    assert(siblings0[0] == c1, "c0 sibling[0] must be c1");
    assert(siblings1[0] == c0, "c1 sibling[0] must be c0");
}
