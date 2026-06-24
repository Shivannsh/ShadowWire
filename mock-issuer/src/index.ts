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
// Fixed KYC state for the demo compliance tree.
// In production each user would register their own KYC leaf in ComplianceRegistry.
// ---------------------------------------------------------------------------

const DEMO_COMPLIANCE_INPUTS = {
  secret_salt:           "42",
  kyc_tier:              "2",
  sanctioned_flag:       "0",
  country_code:          "91",
  merkle_siblings:       ["0", "0", "0", "0", "0", "0", "0", "0", "0", "0"],
  merkle_index:          "0",
  merkle_root:           "0x04cb8cd7088dfd9b428e728e60afdc55a6b5fff80144db7c497ef79d014a5211",
  corridor_id:           "1",
  min_kyc_tier:          "1",
  max_amount:            "1000000",
  compliance_nullifier:  "0x0f77c274c15388b0b8156c1b9e4f7d83e856e7cfb325a84eec38e4a8c165dc7b",
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
  const hashUtilDir  = path.join(ROOT, "circuits/hash_util");
  const proverToml   = path.join(hashUtilDir, "Prover.toml");
  const verifierToml = path.join(hashUtilDir, "Verifier.toml");

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

  execSync(`"${NARGO}" execute`, { cwd: hashUtilDir, stdio: "pipe" });

  const verifier = fs.readFileSync(verifierToml, "utf8");
  const match = verifier.match(/return_value\s*=\s*\[([^\]]+)\]/);
  if (!match) throw new Error("hash_util Verifier.toml: return_value not found");
  const values = match[1].split(",").map(s => s.trim().replace(/^"|"$/g, ""));

  return {
    inputCommitment: values[0],
    merkleRoot:      values[1],
    nullifierHash:   values[2],
    newCommitment1:  values[3],
    newCommitment2:  values[4],
  };
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
  const i = DEMO_COMPLIANCE_INPUTS;
  res.json({
    merkleRoot:          i.merkle_root,
    corridorId:          i.corridor_id,
    minKycTier:          Number(i.min_kyc_tier),
    maxAmount:           i.max_amount,
    complianceNullifier: i.compliance_nullifier,
    countryCode:         i.country_code,
    kycTier:             i.kyc_tier,
  });
});

// ---------------------------------------------------------------------------
// POST /api/prove/compliance
//
// Body: { amount: string }
// Returns: { proof, pubSignals, publicSignals, complianceNullifier, merkleRoot }
// ---------------------------------------------------------------------------

app.post("/api/prove/compliance", (req, res) => {
  const { amount } = req.body as { amount?: string };
  if (!amount) { res.status(400).json({ error: "amount is required" }); return; }

  try {
    const inputs = { ...DEMO_COMPLIANCE_INPUTS, amount: String(amount) };
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
    const inputs = {
      merkle_root:       pubVals.merkleRoot,
      nullifier_hash:    pubVals.nullifierHash,
      new_commitment_1:  pubVals.newCommitment1,
      new_commitment_2:  pubVals.newCommitment2,
      fee,
      pub_asset_id:      assetId,
      owner_pubkey:      body.ownerField,
      value:             body.value,
      asset_id:          assetId,
      blinding_factor:   body.blinding,
      note_secret_key:   body.secretKey,
      merkle_siblings:   merklePath.siblings,
      merkle_index:      String(merklePath.index),
      recipient_pubkey:  body.recipient,
      output_value_1:    outputValue1,
      output_blinding_1: outputBlinding1,
      sender_pubkey:     body.ownerField,
      output_value_2:    outputValue2,
      output_blinding_2: outputBlinding2,
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

    const inputs = {
      merkle_root:       pubVals.merkleRoot,
      nullifier_hash:    pubVals.nullifierHash,
      new_commitment_1:  pubVals.newCommitment1,
      new_commitment_2:  pubVals.newCommitment2,
      fee,
      pub_asset_id:      assetId,
      owner_pubkey:      body.ownerField,
      value:             body.value,
      asset_id:          assetId,
      blinding_factor:   body.blinding,
      note_secret_key:   body.secretKey,
      merkle_siblings:   merklePath.siblings,
      merkle_index:      String(merklePath.index),
      recipient_pubkey:  body.recipient,
      output_value_1:    outputValue1,
      output_blinding_1: outputBlinding1,
      sender_pubkey:     body.ownerField,
      output_value_2:    outputValue2,
      output_blinding_2: outputBlinding2,
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
