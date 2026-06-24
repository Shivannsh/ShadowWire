// Stretch: selective disclosure — prove a note can be decrypted by auditor view key
// without revealing other users' privacy. Full integration post-hackathon.

fn poseidon4(a: Field, b: Field, c: Field, d: Field) -> Field {
    std::hash::poseidon2_permutation([a, b, c, d], 4)[0]
}

fn main(
    note_secret: Field,
    view_key: Field,
    encrypted_note: pub Field,
    auditor_pubkey: pub Field,
) {
    let enc = poseidon4(note_secret, view_key, auditor_pubkey, 0);
    assert(enc == encrypted_note);
}
