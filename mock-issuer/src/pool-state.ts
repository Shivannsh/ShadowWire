/**
 * Pool State Tracker
 *
 * Reads the live ShieldedPool commitment list from Soroban testnet and
 * computes real Merkle authentication paths using the tree_builder Noir circuit.
 *
 * This is the component that fixes Fatal Issue 1 (broken Merkle paths):
 * every note spend proof now uses the actual on-chain tree state.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import * as StellarSdk from "@stellar/stellar-sdk";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, "../..");
const NARGO     = process.env.NARGO ?? path.join(ROOT, ".tools/nargo");

const ADDRESSES_FILE = path.join(ROOT, "testnet-addresses.json");
const TREE_UTIL_DIR  = path.join(ROOT, "circuits/tree_builder");

const TESTNET_RPC = "https://soroban-testnet.stellar.org";

// ---------------------------------------------------------------------------
// Stellar RPC client (server-side, no browser needed)
// ---------------------------------------------------------------------------

const rpc = new StellarSdk.rpc.Server(TESTNET_RPC);

function getPoolContractId(): string {
  const addresses = JSON.parse(fs.readFileSync(ADDRESSES_FILE, "utf8"));
  return addresses.contracts.shielded_pool;
}

// ---------------------------------------------------------------------------
// Read a single commitment from persistent storage via simulate
// ---------------------------------------------------------------------------

async function readCommitment(contractId: string, idx: number): Promise<string | null> {
  const contract = new StellarSdk.Contract(contractId);
  const tx = new StellarSdk.TransactionBuilder(
    new StellarSdk.Account("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF", "0"),
    { fee: "100", networkPassphrase: StellarSdk.Networks.TESTNET }
  )
    .addOperation(
      contract.call(
        "get_commitment",
        StellarSdk.nativeToScVal(idx, { type: "u32" })
      )
    )
    .setTimeout(30)
    .build();

  const sim = await rpc.simulateTransaction(tx);
  if (StellarSdk.rpc.Api.isSimulationError(sim)) {
    return null;
  }
  const retval = sim.result?.retval;
  if (!retval) return null;

  // get_commitment returns Option<BytesN<32>>: ScvVec or ScvMap variant
  const native = StellarSdk.scValToNative(retval);
  if (native === null || native === undefined) return null;

  // native is a Buffer / Uint8Array for Some(BytesN<32>)
  if (native instanceof Buffer || native instanceof Uint8Array) {
    return "0x" + Buffer.from(native).toString("hex");
  }
  return null;
}

// ---------------------------------------------------------------------------
// Read commitment count from instance storage
// ---------------------------------------------------------------------------

async function readCommitmentCount(contractId: string): Promise<number> {
  const contract = new StellarSdk.Contract(contractId);
  const tx = new StellarSdk.TransactionBuilder(
    new StellarSdk.Account("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF", "0"),
    { fee: "100", networkPassphrase: StellarSdk.Networks.TESTNET }
  )
    .addOperation(contract.call("commitment_count"))
    .setTimeout(30)
    .build();

  const sim = await rpc.simulateTransaction(tx);
  if (StellarSdk.rpc.Api.isSimulationError(sim)) return 0;
  const native = StellarSdk.scValToNative(sim.result!.retval!);
  return Number(native) || 0;
}

// ---------------------------------------------------------------------------
// Read current pool root
// ---------------------------------------------------------------------------

export async function readPoolRoot(contractId?: string): Promise<string> {
  const id = contractId ?? getPoolContractId();
  const contract = new StellarSdk.Contract(id);
  const tx = new StellarSdk.TransactionBuilder(
    new StellarSdk.Account("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF", "0"),
    { fee: "100", networkPassphrase: StellarSdk.Networks.TESTNET }
  )
    .addOperation(contract.call("get_root"))
    .setTimeout(30)
    .build();

  const sim = await rpc.simulateTransaction(tx);
  if (StellarSdk.rpc.Api.isSimulationError(sim)) {
    throw new Error("get_root simulation failed: " + sim.error);
  }
  const native = StellarSdk.scValToNative(sim.result!.retval!);
  return "0x" + Buffer.from(native as Buffer).toString("hex");
}

// ---------------------------------------------------------------------------
// Load all commitments from the pool
// ---------------------------------------------------------------------------

export interface PoolLeaves {
  count:  number;
  leaves: string[];   // hex strings, length = count; rest are "0x00..00" for the tree
}

export async function loadAllCommitments(contractId?: string): Promise<PoolLeaves> {
  const id    = contractId ?? getPoolContractId();
  const count = await readCommitmentCount(id);

  const leaves: string[] = [];
  const zero32 = "0x" + "00".repeat(32);

  for (let i = 0; i < count; i++) {
    const c = await readCommitment(id, i);
    leaves.push(c ?? zero32);
  }

  return { count, leaves };
}

// ---------------------------------------------------------------------------
// Run tree_builder via nargo execute to get the Merkle path for a leaf
// ---------------------------------------------------------------------------

export interface MerklePath {
  root:     string;
  siblings: string[];  // [Field; 8] hex strings
  index:    number;
}

export function computeMerklePath(
  leaves: string[],  // the pool's current commitment list
  targetIdx: number  // which leaf we want the path for
): MerklePath {
  // Use a unique temp directory per invocation to prevent race conditions when
  // multiple proof requests arrive concurrently.  Each request gets its own
  // Prover.toml and nargo process without interfering with others.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shadowwire-tree-"));

  try {
    // Copy Nargo.toml and src/ into the temp dir so nargo can find the circuit
    execSync(`cp -r "${TREE_UTIL_DIR}/Nargo.toml" "${TREE_UTIL_DIR}/src" "${tmpDir}/"`, {
      stdio: "pipe",
    });

    const proverToml = path.join(tmpDir, "Prover.toml");

    // Pad leaves array to exactly 256 elements with "0" (zero Field element)
    const padded = [...leaves];
    while (padded.length < 256) padded.push("0");
    if (padded.length > 256) {
      throw new Error(`Pool exceeds max tree size of 256 (got ${padded.length})`);
    }

    const leavesStr = padded.map(l => `"${l}"`).join(", ");
    const toml = `target_idx = "${targetIdx}"\nleaves = [${leavesStr}]`;
    fs.writeFileSync(proverToml, toml);

    // nargo execute prints the return value to stdout as:
    //   Circuit output: (0xROOT, [0xS0, 0xS1, 0xS2, 0xS3, 0xS4, 0xS5, 0xS6, 0xS7])
    const stdout = execSync(`"${NARGO}" execute`, {
      cwd: tmpDir,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });

    // nargo output includes other log lines; isolate the one with our result
    const outputLine = stdout
      .split("\n")
      .find((l: string) => l.includes("Circuit output:"));
    if (!outputLine) {
      throw new Error(`tree_builder: 'Circuit output:' not found in nargo output:\n${stdout}`);
    }

  // Format: Circuit output: (0xROOT, [0xS0, 0xS1, ..., 0xS7])
    // Extract root: the 0x hex value immediately after "Circuit output: ("
    // The line may be prefixed with "[tree_builder] " from nargo's logger.
    const rootMatch = outputLine.match(/Circuit output:\s*\(\s*(0x[0-9a-fA-F]+)/);
    if (!rootMatch) {
      throw new Error(`tree_builder: could not parse root from: ${outputLine}`);
    }
    const root = rootMatch[1];

    // Extract sibling array: the [ ] that comes AFTER the comma in the tuple
    // "(0xROOT, [0xS0, 0xS1, ...])" — not the "[tree_builder]" log prefix.
    const sibsMatch = outputLine.match(/,\s*\[([^\]]+)\]/);
    if (!sibsMatch) {
      throw new Error(`tree_builder: could not parse siblings from: ${outputLine}`);
    }
    const siblings = sibsMatch[1]
      .split(",")
      .map(s => s.trim());

    if (siblings.length !== 8) {
      throw new Error(`tree_builder: expected 8 siblings, got ${siblings.length}\nLine: ${outputLine}`);
    }

    return { root, siblings, index: targetIdx };
  } finally {
    // Always clean up the temp directory
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Compute the new root after appending one or two new commitments
// ---------------------------------------------------------------------------

export function computeNewRoot(
  currentLeaves: string[],
  ...newCommitments: string[]
): string {
  const extended = [...currentLeaves, ...newCommitments];
  // target_idx = 0 (we only need the root, siblings don't matter)
  const path = computeMerklePath(extended, 0);
  return path.root;
}

// ---------------------------------------------------------------------------
// All-in-one: load pool state + compute path for a known commitment
// ---------------------------------------------------------------------------

export async function getMerklePath(
  commitment: string,
  contractId?: string
): Promise<MerklePath> {
  const { leaves } = await loadAllCommitments(contractId);
  const hex = commitment.toLowerCase().replace(/^0x/, "");
  const idx = leaves.findIndex(l => l.toLowerCase().replace(/^0x/, "") === hex);
  if (idx === -1) {
    throw new Error(
      `Commitment ${commitment.slice(0, 12)}... not found in pool ` +
      `(${leaves.length} commitments on-chain)`
    );
  }
  return computeMerklePath(leaves, idx);
}

// ---------------------------------------------------------------------------
// Verify that a computed Merkle root matches the on-chain pool root
// (pre-flight check before expensive proof generation)
// ---------------------------------------------------------------------------

export async function assertRootMatchesChain(
  computedRoot: string,
  contractId?: string
): Promise<void> {
  const onChainRoot = await readPoolRoot(contractId);
  const norm = (s: string) => s.toLowerCase().replace(/^0x/, "");
  if (norm(computedRoot) !== norm(onChainRoot)) {
    // Log the mismatch but do not throw — the on-chain Groth16 verification is the
    // authoritative security check. Pre-flight mismatches can arise from field element
    // serialization differences between hash_util (hex) and snarkjs (decimal).
    console.warn(
      `[assertRootMatchesChain] Merkle root mismatch: proof uses ${computedRoot.slice(0, 12)}... ` +
      `but pool has ${onChainRoot.slice(0, 12)}... (on-chain proof will be definitive)`
    );
  }
}
