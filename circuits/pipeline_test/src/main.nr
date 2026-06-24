// Trivial circuit for Day 1 pipeline de-risk: prove x^2 = y without revealing x.
fn main(x: Field, y: pub Field) {
    assert(x * x == y);
}
