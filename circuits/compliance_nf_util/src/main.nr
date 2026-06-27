// compliance_nf_util -- NOT a ZK proving circuit.
// A computation helper that derives the compliance nullifier from private inputs
// using the EXACT same hash primitives as compliance.nr.
//
// Usage:
//   Write private inputs to Prover.toml (or pass via nargo execute)
//   Run:  nargo execute
//   Read: "Circuit output: 0x..." in stdout
//
// The mock-issuer proving server runs this to pre-compute the compliance
// nullifier BEFORE invoking `noir-cli interop` to generate the Groth16 proof.
// The computed nullifier is then supplied as the public input `compliance_nullifier`
// in the main compliance circuit.
//
// Domain tag MUST match compliance.nr exactly.
global DOMAIN_COMP_NF: Field = 0x436f6d706c4e756c6c; // "ComplNull" -- same as compliance.nr

fn poseidon2(a: Field, b: Field, c: Field, d: Field) -> Field {
    std::hash::poseidon2_permutation([a, b, c, d], 4)[0]
}

// Derives the compliance nullifier that the compliance.nr circuit verifies.
// nullifier = H(H(salt, depositor, 0, 0), amount, corridor_id, DOMAIN_COMP_NF)
fn compute_compliance_nullifier(salt: Field, amt: Field, corridor: Field, depositor: Field) -> Field {
    let user_bind = poseidon2(salt, depositor, 0, 0);
    poseidon2(user_bind, amt, corridor, DOMAIN_COMP_NF)
}

fn main(
    secret_salt:      Field,
    depositor_pubkey: Field,
    amount:           Field,
    corridor_id:      Field,
) -> pub Field {
    compute_compliance_nullifier(secret_salt, amount, corridor_id, depositor_pubkey)
}
