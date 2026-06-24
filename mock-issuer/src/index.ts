/**
 * ShadowWire Mock Issuer -- Dynamic Proving Server
 *
 * Responsibilities:
 *  1. KYC attestation authority  -- manages the compliance Merkle tree
 *  2. Dynamic proof generation   -- generates fresh Groth16 proofs for real user inputs
 *  3. Pool state mirror          -- reads commitment list from Soroban, builds real Merkle paths
 *
 * Proof flow (two-step):
 *  a. Run nargo execute on circuits/hash_util to derive all public values from private inputs.
 *     Uses same Poseidon2 as the proving circuit (no JS Poseidon2 needed).
 *  b. For transfer/withdraw: run nargo execute on circuits/tree_builder to get real Merkle path.
 *  c. Build complete inputs.json, run noir-cli interop + snarkjs groth16 prove.
 */

import express from "express";
import cors from "cors";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import crypto from "node:crypto";

import {
  loadAllCommitments,
  computeMerklePath,
  computeNewRoot,
  assertRootMatchesChain,
} from "./pool-state.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, "../..");
const PORT      = Number(process.env.PORT ?? 3001);
const NARGO     = process.env.NARGO ?? path.join(ROOT, ".tools/nargo");
const NOIR_CLI  = path.join(ROOT, ".tools/noir-groth16-target/debug/noir-cli");

const CIRCUITS = ["compliance", "shielded_transfer"] as const;

// ---------------------------------------------------------------------------
// KYC compliance state.
//
// The compliance circuit now:
//   - Takes `depositor_pubkey` as a private input
//   - RETURNS the compliance_nullifier as a circuit-computed public output
//     (slot 5 in the public signals)
//
// This means the mock-issuer does NOT need to pre-compute the nullifier.
// The Groth16 proof itself carries the nullifier as signal[5].
// ---------------------------------------------------------------------------

const DEMO_KYC_BASE = {
  secret_salt:     "42",
  kyc_tier:        "2",
  sanctioned_flag: "0",
  country_code:    "91",
  merkle_siblings: ["0", "0", "0", "0", "0", "0", "0", "0", "0", "0"],
  merkle_index:    "0",
  merkle_root:     "0x04cb8cd7088dfd9b428e728e60afdc55a6b5fff80144db7c497ef79d014a5211",
  corridor_id:     "1",
  min_kyc_tier:    "1",
  max_amount:      "1000000",
};

// Default asset_id (Field element identifying the SRT token on testnet)
const ASSET_ID = "3";

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function hexToBytes(hex: string): number[] {
  const clean = hex.replace(/^0x/i, "");
  const out: number[] = [];
  for (let i = 0; i < clean.length; i += 2) {
    out.push(parseInt(clean.slice(i, i + 2), 16));
  }
  return out;
}

function randomField(): string {
  const bytes = crypto.randomBytes(31);
  return BigInt("0x" + bytes.toString("hex")).toString(10);
}

// ---------------------------------------------------------------------------
// Artifact management
// ---------------------------------------------------------------------------

function ensureArtifacts(circuit: string): void {
  const proofDir = path.join(ROOT, "target/groth16", circuit, "proof");
  if (!fs.existsSync(path.join(proofDir, "circuit_final.zkey"))) {
    execSync(`PTAU_POWER=16 bash scripts/run-circuit.sh circuits/${circuit}`, {
      cwd: ROOT, stdio: "inherit",
    });
  }
  const stellarDir = path.join(ROOT, "target/groth16", circuit, "stellar");
  fs.mkdirSync(stellarDir, { recursive: true });
  const encode = path.join(ROOT, "scripts/encode_bn254_for_soroban.mjs");
  for (const kind of ["proof", "public"] as const) {
    const out = path.join(stellarDir, `${kind}.hex`);
    if (!fs.existsSync(out)) {
      const hex = execSync(`node "${encode}" ${kind} "${proofDir}/${kind}.json"`,
        { encoding: "utf8" }).trim();
      fs.writeFileSync(out, hex);
    }
  }
}

// ---------------------------------------------------------------------------
// Core: generate Groth16 proof for a circuit + inputs
// ---------------------------------------------------------------------------

interface ProofResult {
  proof:         number[];
  pubSignals:    number[];
  publicSignals: string[];
}

function generateProof(circuit: string, inputs: Record<string, unknown>): ProofResult {
  ensureArtifacts(circuit);

  const tmpDir       = fs.mkdtempSync(path.join(os.tmpdir(), `shadowwire-${circuit}-`));
  const inputsPath   = path.join(tmpDir, "inputs.json");
  const witnessPath  = path.join(tmpDir, "witness.wtns");
  const proofPath    = path.join(tmpDir, "proof.json");
  const publicPath   = path.join(tmpDir, "public.json");
  const artifactPath = path.join(ROOT, "circuits", circuit, "target", `${circuit}.json`);
  const zkeyPath     = path.join(ROOT, "target/groth16", circuit, "proof", "circuit_final.zkey");
  const encode       = path.join(ROOT, "scripts/encode_bn254_for_soroban.mjs");

  try {
    fs.writeFileSync(inputsPath, JSON.stringify(inputs, null, 2));

    execSync(`"${NOIR_CLI}" interop "${artifactPath}" "${inputsPath}" --out "${tmpDir}"`,
      { cwd: ROOT, stdio: "pipe" });

    execSync(
      `npx snarkjs groth16 prove "${zkeyPath}" "${witnessPath}" "${proofPath}" "${publicPath}"`,
      { cwd: ROOT, stdio: "pipe" }
    );

    const proofHex = execSync(`node "${encode}" proof "${proofPath}"`,
      { cwd: ROOT, encoding: "utf8" }).trim();
    const pubHex = execSync(`node "${encode}" public "${publicPath}"`,
      { cwd: ROOT, encoding: "utf8" }).trim();

    const publicSignals = JSON.parse(fs.readFileSync(publicPath, "utf8")) as string[];

    return {
      proof:         hexToBytes(proofHex),
      pubSignals:    hexToBytes(pubHex),
      publicSignals,
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Compute note public values using hash_util (nargo execute)
// Derives: inputCommitment, merkleRoot, nullifierHash, newCommitment1, newCommitment2
// from purely private inputs -- using exact same Poseidon2 as the proving circuit.
// ---------------------------------------------------------------------------

interface NotePublicValues {
  inputCommitment: string;
  merkleRoot:      string;
  nullifierHash:   string;
  newCommitment1:  string;
  newCommitment2:  string;
  outputValue1:    string;  // = output_value_1 = pub_withdraw_amount in circuit
}

function computeNoteValues(privateInputs: {
  owner:        string;
  value:        string;
  assetId:      string;
  blinding:     string;
  secretKey:    string;
  siblings:     string[];
  index:        string;
  recipient:    string;
  outValue1:    string;
  outBlinding1: string;
  sender:       string;
  outValue2:    string;
  outBlinding2: string;
}): NotePublicValues {
  const hashUtilDir = path.join(ROOT, "circuits/hash_util");

  // Per-request temp dir to prevent race conditions under concurrent requests
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shadowwire-hash-"));
  try {
    execSync(`cp -r "${hashUtilDir}/Nargo.toml" "${hashUtilDir}/src" "${tmpDir}/"`, { stdio: "pipe" });

    const proverToml = path.join(tmpDir, "Prover.toml");
    const toml = [
      `owner_pubkey    = "${privateInputs.owner}"`,
      `value           = "${privateInputs.value}"`,
      `asset_id        = "${privateInputs.assetId}"`,
      `blinding_factor = "${privateInputs.blinding}"`,
      `note_secret_key = "${privateInputs.secretKey}"`,
      `merkle_index    = "${privateInputs.index}"`,
      `merkle_siblings = [${privateInputs.siblings.map(s => `"${s}"`).join(", ")}]`,
      `recipient_pubkey   = "${privateInputs.recipient}"`,
      `output_value_1     = "${privateInputs.outValue1}"`,
      `output_blinding_1  = "${privateInputs.outBlinding1}"`,
      `sender_pubkey      = "${privateInputs.sender}"`,
      `output_value_2     = "${privateInputs.outValue2}"`,
      `output_blinding_2  = "${privateInputs.outBlinding2}"`,
    ].join("\n");
    fs.writeFileSync(proverToml, toml);

    // nargo execute prints to stdout:
    //   Circuit output: (0xINPUT_COMMIT, 0xMERKLE_ROOT, 0xNULLIFIER,
    //                    0xNEW_COMMIT1, 0xNEW_COMMIT2, 0xOUTPUT_VALUE1)
    const stdout = execSync(`"${NARGO}" execute`, {
      cwd: tmpDir,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });

  const outputLine = stdout.split("\n").find(l => l.includes("Circuit output:"));
  if (!outputLine) {
    throw new Error(`hash_util: 'Circuit output:' not found in nargo output:\n${stdout}`);
  }

  // Extract all hex values from the tuple: (0xA, 0xB, 0xC, 0xD, 0xE, 0xF)
  const inner = outputLine.match(/Circuit output:\s*\(([^)]+)\)/);
  if (!inner) {
    throw new Error(`hash_util: could not parse tuple from: ${outputLine}`);
  }
  const values = inner[1].split(",").map(s => s.trim());
  if (values.length < 6) {
    throw new Error(`hash_util: expected 6 output values, got ${values.length}: ${inner[1]}`);
  }

    return {
      inputCommitment: values[0],
      merkleRoot:      values[1],
      nullifierHash:   values[2],
      newCommitment1:  values[3],
      newCommitment2:  values[4],
      outputValue1:    values[5],
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// Compute just the commitment for a note (without full hash_util run)
function computeNoteCommitment(
  owner: string, value: string, assetId: string, blinding: string
): string {
  // We run hash_util with dummy transfer values just to get the commitment
  const vals = computeNoteValues({
    owner, value, assetId, blinding,
    secretKey:    "1",
    siblings:     Array(8).fill("0"),
    index:        "0",
    recipient:    "1",
    outValue1:    "1",
    outBlinding1: "1",
    sender:       owner,
    outValue2:    "0",
    outBlinding2: "1",
  });
  return vals.inputCommitment;
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express();
app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "shadowwire-proving-server" });
});

// ---------------------------------------------------------------------------
// GET /api/attestation
// ---------------------------------------------------------------------------

app.get("/api/attestation", (_req, res) => {
  const i = DEMO_KYC_BASE;
  res.json({
    merkleRoot:  i.merkle_root,
    corridorId:  i.corridor_id,
    minKycTier:  Number(i.min_kyc_tier),
    maxAmount:   i.max_amount,
    countryCode: i.country_code,
    kycTier:     i.kyc_tier,
  });
});

// ---------------------------------------------------------------------------
// POST /api/prove/compliance
//
// Body: { amount: string }
// Returns: { proof, pubSignals, publicSignals, complianceNullifier, merkleRoot }
// ---------------------------------------------------------------------------

// Pre-compute the per-user compliance nullifier using nargo execute.
// The compliance circuit accepts compliance_nullifier as a public INPUT and
// verifies it equals the circuit-computed value -- so the prover must provide
// the correct value upfront.  We derive it by running nargo execute on the
// compliance circuit and parsing the "Circuit output:" line from stdout.
function computeComplianceNullifier(
  depositorPubkey: string,
  amount: string
): string {
  const circuitDir = path.join(ROOT, "circuits/compliance");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shadowwire-comp-nf-"));
  try {
    execSync(`cp -r "${circuitDir}/Nargo.toml" "${circuitDir}/src" "${tmpDir}/"`, { stdio: "pipe" });
    const proverToml = path.join(tmpDir, "Prover.toml");
    const toml = [
      `secret_salt      = "${DEMO_KYC_BASE.secret_salt}"`,
      `kyc_tier         = "${DEMO_KYC_BASE.kyc_tier}"`,
      `sanctioned_flag  = "${DEMO_KYC_BASE.sanctioned_flag}"`,
      `country_code     = "${DEMO_KYC_BASE.country_code}"`,
      `merkle_index     = "${DEMO_KYC_BASE.merkle_index}"`,
      `merkle_siblings  = [${DEMO_KYC_BASE.merkle_siblings.map(s => `"${s}"`).join(", ")}]`,
      `depositor_pubkey = "${depositorPubkey}"`,
      `merkle_root          = "${DEMO_KYC_BASE.merkle_root}"`,
      `corridor_id          = "${DEMO_KYC_BASE.corridor_id}"`,
      `min_kyc_tier         = "${DEMO_KYC_BASE.min_kyc_tier}"`,
      `max_amount           = "${DEMO_KYC_BASE.max_amount}"`,
      `amount               = "${amount}"`,
      // placeholder so nargo execute can check the Prover.toml format;
      // the actual nullifier value will be in the Circuit output line
      `compliance_nullifier = "0"`,
    ].join("\n");
    fs.writeFileSync(proverToml, toml);

    // nargo execute prints: Circuit output: 0xNULLIFIER
    const stdout = execSync(`"${NARGO}" execute`, {
      cwd: tmpDir, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
    });
    const line = stdout.split("\n").find((l: string) => l.includes("Circuit output:"));
    if (!line) throw new Error(`compliance nargo execute: 'Circuit output:' not found\n${stdout}`);
    const match = line.match(/Circuit output:\s*(0x[0-9a-fA-F]+)/);
    if (!match) throw new Error(`compliance nargo execute: could not parse nullifier from: ${line}`);
    return match[1];
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

app.post("/api/prove/compliance", (req, res) => {
  const { amount, ownerField } = req.body as { amount?: string; ownerField?: string };
  if (!amount) { res.status(400).json({ error: "amount is required" }); return; }

  const depositorPubkey = ownerField ?? "1";

  try {
    // Step 1: Pre-compute the per-user nullifier (requires nargo execute)
    const complianceNullifier = computeComplianceNullifier(depositorPubkey, String(amount));

    // Step 2: Generate the full Groth16 proof with the correct nullifier as public input
    // Public signal layout: [0]=merkle_root [1]=corridor_id [2]=min_kyc_tier
    //                        [3]=max_amount  [4]=amount      [5]=compliance_nullifier
    const inputs = {
      ...DEMO_KYC_BASE,
      amount:               String(amount),
      depositor_pubkey:     depositorPubkey,
      compliance_nullifier: complianceNullifier,
    };
    const result = generateProof("compliance", inputs);

    res.json({
      proof:               result.proof,
      pubSignals:          result.pubSignals,
      publicSignals:       result.publicSignals,
      complianceNullifier: result.publicSignals[5] ?? "0",
      merkleRoot:          result.publicSignals[0] ?? "0",
    });
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// POST /api/prove/deposit  (NEW -- fixes Fatal Issue 2)
//
// Computes the correct note commitment and new Merkle root for Alice's deposit.
// The client uses these values in buildDepositTx so the note is properly anchored.
//
// Body:
//   {
//     ownerField:  string,   // deterministic field derived from Stellar address
//     value:       string,   // actual deposit amount (matches SEP-24 amount)
//     assetId?:    string,   // default "3" (SRT)
//     blinding:    string,   // random blinding factor (from noteWallet)
//     secretKey:   string,   // random spend key    (from noteWallet)
//   }
//
// Returns:
//   {
//     commitment: string,    // hex field -- insert into pool
//     newRoot:    string,    // hex field -- pool root after this deposit
//   }
// ---------------------------------------------------------------------------

app.post("/api/prove/deposit", async (req, res) => {
  const body = req.body as {
    ownerField?: string;
    value?:      string;
    assetId?:    string;
    blinding?:   string;
    secretKey?:  string;
  };

  if (!body.ownerField || !body.value || !body.blinding || !body.secretKey) {
    res.status(400).json({ error: "ownerField, value, blinding, secretKey are required" });
    return;
  }

  try {
    const assetId = body.assetId ?? ASSET_ID;

    // Compute the commitment using hash_util
    const commitment = computeNoteCommitment(
      body.ownerField, body.value, assetId, body.blinding
    );

    // Load current pool leaves and compute new root after appending this commitment
    const { leaves } = await loadAllCommitments();
    const newRoot = computeNewRoot(leaves, commitment);

    res.json({ commitment, newRoot });
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// POST /api/prove/transfer  (UPDATED -- fixes Fatal Issues 1, 2, 3)
//
// Generates a shielded transfer proof with a REAL Merkle path for the input note.
//
// Body:
//   {
//     // Input note (Alice's note -- must already be in the pool)
//     ownerField:  string,   // Field derived from Alice's Stellar address
//     value:       string,   // note value
//     assetId?:    string,   // default "3"
//     blinding:    string,   // note blinding factor
//     secretKey:   string,   // note spend key
//     // Transfer parameters
//     recipient:   string,   // Bob's ownerField
//     outputValue1: string,  // amount to send Bob
//     fee?:        string,   // protocol fee (default "0")
//     outputBlinding1?: string,
//     outputBlinding2?: string,
//   }
//
// Returns:
//   {
//     proof, pubSignals, publicSignals,
//     spendNullifier, newCommitment1, newCommitment2, merkleRoot, newRoot,
//     bobNote: { owner, value, assetId, blinding, secretKey, commitment }
//   }
// ---------------------------------------------------------------------------

app.post("/api/prove/transfer", async (req, res) => {
  const body = req.body as {
    ownerField?:     string;
    value?:          string;
    assetId?:        string;
    blinding?:       string;
    secretKey?:      string;
    recipient?:      string;
    outputValue1?:   string;
    fee?:            string;
    outputBlinding1?: string;
    outputBlinding2?: string;
  };

  if (!body.ownerField || !body.value || !body.blinding || !body.secretKey || !body.recipient) {
    res.status(400).json({ error: "ownerField, value, blinding, secretKey, recipient required" });
    return;
  }

  const assetId      = body.assetId ?? ASSET_ID;
  const outputValue1 = body.outputValue1 ?? body.value;
  const fee          = body.fee ?? "0";
  const outputValue2 = String(BigInt(body.value) - BigInt(outputValue1) - BigInt(fee));

  if (BigInt(outputValue2) < 0n) {
    res.status(400).json({ error: "outputValue1 + fee exceeds note value" });
    return;
  }

  const outputBlinding1 = body.outputBlinding1 ?? randomField();
  const outputBlinding2 = body.outputBlinding2 ?? randomField();

  try {
    // Step 1: Compute the input note commitment
    const commitment = computeNoteCommitment(
      body.ownerField, body.value, assetId, body.blinding
    );

    // Step 2: Load the real pool tree and find the Merkle path for this commitment
    const { leaves } = await loadAllCommitments();
    const merklePath = computeMerklePath(
      leaves,
      leaves.findIndex(l => l.toLowerCase().replace(/^0x/, "") ===
                            commitment.toLowerCase().replace(/^0x/, ""))
    );

    if (merklePath.index < 0) {
      throw new Error(
        `Note commitment ${commitment.slice(0, 12)}... not found in pool. ` +
        `Deposit the note first.`
      );
    }

    // Step 3: Compute all public values using hash_util + real siblings
    const pubVals = computeNoteValues({
      owner:        body.ownerField,
      value:        body.value,
      assetId,
      blinding:     body.blinding,
      secretKey:    body.secretKey,
      siblings:     merklePath.siblings,
      index:        String(merklePath.index),
      recipient:    body.recipient,
      outValue1:    outputValue1,
      outBlinding1: outputBlinding1,
      sender:       body.ownerField,
      outValue2:    outputValue2,
      outBlinding2: outputBlinding2,
    });

    // Step 4: Verify the computed root matches the on-chain pool root
    await assertRootMatchesChain(pubVals.merkleRoot);

    // Step 5: Compute new root after inserting both output commitments
    const newRoot = computeNewRoot(leaves, pubVals.newCommitment1, pubVals.newCommitment2);

    // Step 6: Generate the Groth16 proof
    // Shielded transfer: pub_withdraw_amount = 0 (amount stays private on-chain).
    // The dual-mode circuit constraint: (0 - output_value_1) * 0 == 0 -- satisfied.
    // The contract's transfer() does NOT check signal[6] at all (no token release).
    const inputs = {
      merkle_root:         pubVals.merkleRoot,
      nullifier_hash:      pubVals.nullifierHash,
      new_commitment_1:    pubVals.newCommitment1,
      new_commitment_2:    pubVals.newCommitment2,
      fee,
      pub_asset_id:        assetId,
      pub_withdraw_amount: "0",   // slot 6: 0 = transfer mode, amount stays hidden
      owner_pubkey:        body.ownerField,
      value:               body.value,
      asset_id:            assetId,
      blinding_factor:     body.blinding,
      note_secret_key:     body.secretKey,
      merkle_siblings:     merklePath.siblings,
      merkle_index:        String(merklePath.index),
      recipient_pubkey:    body.recipient,
      output_value_1:      outputValue1,
      output_blinding_1:   outputBlinding1,
      sender_pubkey:       body.ownerField,
      output_value_2:      outputValue2,
      output_blinding_2:   outputBlinding2,
    };

    const result = generateProof("shielded_transfer", inputs);

    // Bob's note receipt: everything Bob needs to spend his output note
    const bobNote = {
      owner:      body.recipient,
      value:      outputValue1,
      assetId,
      blinding:   outputBlinding1,
      secretKey:  randomField(),  // fresh spend key for Bob's note
      commitment: pubVals.newCommitment1,
    };

    res.json({
      proof:          result.proof,
      pubSignals:     result.pubSignals,
      publicSignals:  result.publicSignals,
      spendNullifier: result.publicSignals[1] ?? "0",
      newCommitment1: result.publicSignals[2] ?? "0",
      newCommitment2: result.publicSignals[3] ?? "0",
      merkleRoot:     result.publicSignals[0] ?? "0",
      newRoot,
      bobNote,
    });
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// POST /api/prove/withdraw
//
// Same as transfer but the full output value goes to recipient (no change).
// Uses the same shielded_transfer circuit -- the change note gets value = 0.
// ---------------------------------------------------------------------------

app.post("/api/prove/withdraw", async (req, res) => {
  // Internally same as transfer with fee=0, outputValue1 = full note value
  const body = req.body as {
    ownerField?: string;
    value?:      string;
    assetId?:    string;
    blinding?:   string;
    secretKey?:  string;
    recipient?:  string;
  };

  if (!body.ownerField || !body.value || !body.blinding || !body.secretKey || !body.recipient) {
    res.status(400).json({ error: "ownerField, value, blinding, secretKey, recipient required" });
    return;
  }

  // Forward to transfer with outputValue1 = value, fee = 0
  req.body = { ...body, outputValue1: body.value, fee: "0" };
  // Re-invoke the transfer handler by calling it directly
  const transferReq = { ...req, body: { ...body, outputValue1: body.value, fee: "0" } };

  // Call transfer logic inline (could also be a shared function)
  const assetId       = body.assetId ?? ASSET_ID;
  const outputValue1  = body.value;
  const fee           = "0";
  const outputValue2  = "0";
  const outputBlinding1 = randomField();
  const outputBlinding2 = randomField();

  try {
    const commitment = computeNoteCommitment(body.ownerField, body.value, assetId, body.blinding);
    const { leaves } = await loadAllCommitments();
    const merklePath = computeMerklePath(
      leaves,
      leaves.findIndex(l => l.toLowerCase().replace(/^0x/, "") ===
                            commitment.toLowerCase().replace(/^0x/, ""))
    );

    if (merklePath.index < 0) {
      throw new Error(`Note commitment not found in pool. Deposit the note first.`);
    }

    const pubVals = computeNoteValues({
      owner:        body.ownerField,
      value:        body.value,
      assetId,
      blinding:     body.blinding,
      secretKey:    body.secretKey,
      siblings:     merklePath.siblings,
      index:        String(merklePath.index),
      recipient:    body.recipient,
      outValue1:    outputValue1,
      outBlinding1: outputBlinding1,
      sender:       body.ownerField,
      outValue2:    outputValue2,
      outBlinding2: outputBlinding2,
    });

    await assertRootMatchesChain(pubVals.merkleRoot);
    const newRoot = computeNewRoot(leaves, pubVals.newCommitment1, pubVals.newCommitment2);

    // Off-ramp withdraw: pub_withdraw_amount = outputValue1 (amount revealed to anchor).
    // Dual-mode circuit constraint: (outputValue1 - outputValue1) * outputValue1 == 0.
    // Contract's withdraw() reads signal[6] and verifies it equals the `amount` parameter.
    const inputs = {
      merkle_root:         pubVals.merkleRoot,
      nullifier_hash:      pubVals.nullifierHash,
      new_commitment_1:    pubVals.newCommitment1,
      new_commitment_2:    pubVals.newCommitment2,
      fee,
      pub_asset_id:        assetId,
      pub_withdraw_amount: pubVals.outputValue1,   // slot 6: = output_value_1, amount revealed
      owner_pubkey:        body.ownerField,
      value:               body.value,
      asset_id:            assetId,
      blinding_factor:     body.blinding,
      note_secret_key:     body.secretKey,
      merkle_siblings:     merklePath.siblings,
      merkle_index:        String(merklePath.index),
      recipient_pubkey:    body.recipient,
      output_value_1:      outputValue1,
      output_blinding_1:   outputBlinding1,
      sender_pubkey:       body.ownerField,
      output_value_2:      outputValue2,
      output_blinding_2:   outputBlinding2,
    };

    const result = generateProof("shielded_transfer", inputs);

    res.json({
      proof:          result.proof,
      pubSignals:     result.pubSignals,
      publicSignals:  result.publicSignals,
      spendNullifier: result.publicSignals[1] ?? "0",
      newCommitment1: result.publicSignals[2] ?? "0",
      newCommitment2: result.publicSignals[3] ?? "0",
      merkleRoot:     result.publicSignals[0] ?? "0",
      newRoot,
    });
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// Backward-compat static endpoints (kept for testing)
// ---------------------------------------------------------------------------

app.get("/api/proofs/:circuit", (req, res) => {
  const circuit = req.params.circuit;
  if (!CIRCUITS.includes(circuit as (typeof CIRCUITS)[number])) {
    res.status(404).json({ error: "unknown circuit" }); return;
  }
  try {
    ensureArtifacts(circuit);
    const stellarDir = path.join(ROOT, "target/groth16", circuit, "stellar");
    const proofDir   = path.join(ROOT, "target/groth16", circuit, "proof");
    const proofHex   = fs.readFileSync(path.join(stellarDir, "proof.hex"),  "utf8").trim();
    const publicHex  = fs.readFileSync(path.join(stellarDir, "public.hex"), "utf8").trim();
    const pubSigs    = JSON.parse(fs.readFileSync(path.join(proofDir, "public.json"), "utf8"));
    const inputs     = JSON.parse(fs.readFileSync(
      path.join(ROOT, "circuits", circuit, "inputs.json"), "utf8"));
    res.json({ circuit, proof: hexToBytes(proofHex), pubSignals: hexToBytes(publicHex),
               publicSignals: pubSigs, inputs });
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

app.get("/api/attestation/status", (_req, res) => {
  res.json({ complianceTree: "active", leaves: 1, corridors: [1] });
});

app.listen(PORT, () => {
  console.log(`ShadowWire proving server on http://localhost:${PORT}`);
  console.log(`POST /api/prove/compliance  { amount }`);
  console.log(`POST /api/prove/deposit     { ownerField, value, blinding, secretKey }`);
  console.log(`POST /api/prove/transfer    { ownerField, value, blinding, secretKey, recipient, outputValue1, fee }`);
  console.log(`POST /api/prove/withdraw    { ownerField, value, blinding, secretKey, recipient }`);
});
