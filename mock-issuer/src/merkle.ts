import { buildPoseidon } from "circomlibjs";

export type ComplianceLeaf = {
  secretSalt: bigint;
  kycTier: bigint;
  sanctionedFlag: bigint;
  countryCode: bigint;
};

const MERKLE_DEPTH = 4;

export async function poseidon4(
  a: bigint,
  b: bigint,
  c: bigint,
  d: bigint
): Promise<bigint> {
  const poseidon = await buildPoseidon();
  const hash = poseidon([a, b, c, d]);
  return poseidon.F.toObject(hash) as bigint;
}

export async function hashLeaf(leaf: ComplianceLeaf): Promise<bigint> {
  return poseidon4(
    leaf.secretSalt,
    leaf.kycTier,
    leaf.sanctionedFlag,
    leaf.countryCode
  );
}

export async function merkleRoot(
  leaves: bigint[],
  depth = MERKLE_DEPTH
): Promise<{ root: bigint; paths: Map<number, bigint[]> }> {
  let level = [...leaves];
  const paths = new Map<number, bigint[]>();

  // pad to power of 2
  const size = 1 << depth;
  while (level.length < size) level.push(0n);

  for (let i = 0; i < leaves.length; i++) {
    paths.set(i, new Array(depth).fill(0n));
  }

  let indices = Array.from({ length: size }, (_, i) => i);
  let current = level;

  for (let d = 0; d < depth; d++) {
    const next: bigint[] = [];
    const nextIndices: number[] = [];
    for (let i = 0; i < current.length; i += 2) {
      const left = current[i];
      const right = current[i + 1];
      const parent = await poseidon4(left, right, 0n, 0n);
      next.push(parent);
      for (let j = 0; j < 2; j++) {
        const idx = indices[i + j];
        if (paths.has(idx)) {
          const path = paths.get(idx)!;
          path[d] = j === 0 ? right : left;
        }
      }
      nextIndices.push(indices[i]);
    }
    current = next;
    indices = nextIndices;
  }

  return { root: current[0], paths };
}

export const DEMO_ALICE: ComplianceLeaf = {
  secretSalt: 42n,
  kycTier: 2n,
  sanctionedFlag: 0n,
  countryCode: 91n,
};

export const DEMO_BOB: ComplianceLeaf = {
  secretSalt: 99n,
  kycTier: 2n,
  sanctionedFlag: 0n,
  countryCode: 234n,
};
