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
  readPoolRoot,
} from "./pool-state.js";
import { getOperatorPublicKeyHex, signRoot } from "./operator.js";
import { getAttestationForSide, getRegistryRoot, type KycSide } from "./kyc-registry.js";
import {
  loadAttestConfig,
  getBlsPublicKeyHex,
  getKycStatus,
  enrollKyc,
  revokeKyc,
  kycClaimValue,
} from "./kyc-attest.js";
import { getCorridor } from "./corridors.js";
import { resolveKycMode, readRegistryRoot, type KycMode } from "./registry-state.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, "../..");
const PORT      = Number(process.env.PORT ?? 3001);
const NARGO     = process.env.NARGO ?? path.join(ROOT, ".tools/nargo");
const NOIR_CLI  = path.join(ROOT, ".tools/noir-groth16-target/debug/noir-cli");

const CIRCUITS = ["compliance", "shielded_transfer"] as const;

// ---------------------------------------------------------------------------
// KYC compliance state.
//
// The compliance circuit takes `compliance_nullifier` as a PUBLIC INPUT (slot 5).
// The mock-issuer MUST pre-compute it using the compliance_nf_util circuit before
// generating the Groth16 proof, then pass the computed value as the input.
//
// Public signal layout: [0]=merkle_root [1]=corridor_id [2]=min_kyc_tier
//                        [3]=max_amount  [4]=amount      [5]=compliance_nullifier
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

// corridor_id this pool was constructed with — MUST match the pool's CID storage,
// because the operator signs `corridor_id || new_root` and the contract verifies it.
const CORRIDOR_ID = Number(process.env.CORRIDOR_ID ?? DEMO_KYC_BASE.corridor_id);

// KYC_MODE=auto (default) reads the on-chain ComplianceRegistry root and picks
// demo vs registry so compliance proofs always match what deposit() verifies.
// KYC_MODE=registry|demo forces a mode (useful for testing).
let kycMode: KycMode = "demo";

/**
 * KYC inputs for a compliance proof on the given corridor side. In registry mode
 * the sending side carries the US leaf and the receiving side the NG leaf, with
 * corridor limits from the corridor policy; in demo mode it is the legacy leaf.
 */
function complianceKycInputs(side: KycSide) {
  if (kycMode !== "registry") {
    return { ...DEMO_KYC_BASE };
  }
  const att = getAttestationForSide(side);
  const corridor = getCorridor(CORRIDOR_ID);
  return {
    secret_salt:     att.secret_salt,
    kyc_tier:        att.kyc_tier,
    sanctioned_flag: att.sanctioned_flag,
    country_code:    att.country_code,
    merkle_siblings: att.merkle_siblings,
    merkle_index:    att.merkle_index,
    merkle_root:     att.merkle_root,
    corridor_id:     String(corridor.id),
    min_kyc_tier:    corridor.minKycTier,
    max_amount:      corridor.maxAmount,
  };
}

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

/**
 * Normalize any field element representation to a lowercase 64-char hex string
 * (no 0x prefix). This is the canonical form used by loadAllCommitments().
 *
 * Accepted input forms:
 *   - "0x" or "0X" prefixed hex  → strip prefix, lowercase, pad
 *   - raw hex string (contains a-f)  → lowercase, pad
 *   - decimal integer string (only 0-9) → BigInt → hex, pad
 */
function fieldToHex64(field: string): string {
  const s = String(field).trim();
  // Strip 0x/0X prefix if present
  const stripped = (s.startsWith("0x") || s.startsWith("0X")) ? s.slice(2) : s;
  // If any character is a-f or A-F the string is already hex
  if (/[a-fA-F]/.test(stripped)) {
    return stripped.toLowerCase().padStart(64, "0");
  }
  // Pure decimal digits — convert via BigInt
  return BigInt(s).toString(16).padStart(64, "0");
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
// Compute compliance nullifier using compliance_nf_util (nargo execute).
// Uses the same Poseidon2 formula as compliance.nr so there is no JS dependency
// on Poseidon2.  Returns the nullifier as a 0x-prefixed hex field string.
// ---------------------------------------------------------------------------

function computeComplianceNullifier(
  secretSalt:      string,
  depositorPubkey: string,
  amount:          string,
  corridorId:      string,
): string {
  const utilDir = path.join(ROOT, "circuits/compliance_nf_util");
  const tmpDir  = fs.mkdtempSync(path.join(os.tmpdir(), "shadowwire-compnf-"));
  try {
    // Copy circuit source into a temp workspace to avoid concurrent-write races.
    execSync(`cp -r "${utilDir}/Nargo.toml" "${utilDir}/src" "${tmpDir}/"`, { stdio: "pipe" });

    const proverToml = path.join(tmpDir, "Prover.toml");
    fs.writeFileSync(proverToml, [
      `secret_salt      = "${secretSalt}"`,
      `depositor_pubkey = "${depositorPubkey}"`,
      `amount           = "${amount}"`,
      `corridor_id      = "${corridorId}"`,
    ].join("\n"));

    const stdout = execSync(`"${NARGO}" execute`, {
      cwd: tmpDir,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });

    const line = stdout.split("\n").find(l => l.includes("Circuit output:"));
    if (!line) {
      throw new Error(`compliance_nf_util: 'Circuit output:' not found:\n${stdout}`);
    }
    const match = line.match(/Circuit output:\s*(0x[0-9a-fA-F]+)/);
    if (!match) {
      throw new Error(`compliance_nf_util: could not parse hex from: ${line}`);
    }
    return match[1];
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
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
  if (kycMode === "registry") {
    try {
      const corridor = getCorridor(CORRIDOR_ID);
      const send = getAttestationForSide("send");
      const recv = getAttestationForSide("receive");
      res.json({
        mode:        "registry",
        merkleRoot:  getRegistryRoot(),
        corridorId:  String(corridor.id),
        minKycTier:  Number(corridor.minKycTier),
        maxAmount:   corridor.maxAmount,
        // Cross-border: distinct sending/receiving jurisdictions, each KYC-bound.
        sending:     { country: corridor.sendingLabel,   countryCode: send.country_code, kycTier: send.kyc_tier },
        receiving:   { country: corridor.receivingLabel, countryCode: recv.country_code, kycTier: recv.kyc_tier },
      });
      return;
    } catch (err) {
      res.status(500).json({ error: String(err) });
      return;
    }
  }
  const i = DEMO_KYC_BASE;
  res.json({
    mode:        "demo",
    merkleRoot:  i.merkle_root,
    corridorId:  i.corridor_id,
    minKycTier:  Number(i.min_kyc_tier),
    maxAmount:   i.max_amount,
    countryCode: i.country_code,
    kycTier:     i.kyc_tier,
  });
});

// ---------------------------------------------------------------------------
// GET /api/corridor — the active cross-border lane (sending -> receiving).
// ---------------------------------------------------------------------------
app.get("/api/corridor", (_req, res) => {
  try {
    const c = getCorridor(CORRIDOR_ID);
    res.json({
      id: c.id,
      sending:   { country: c.sendingLabel,   countryCode: c.sendingCountry },
      receiving: { country: c.receivingLabel, countryCode: c.receivingCountry },
      minKycTier: Number(c.minKycTier),
      maxAmount:  c.maxAmount,
      kycMode,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// POST /api/prove/compliance
//
// Body: { amount: string, ownerField?: string }
// Returns: { proof, pubSignals, publicSignals, complianceNullifier, merkleRoot }
//
// compliance_nullifier is a PUBLIC INPUT (slot 5).  We pre-compute it via
// compliance_nf_util (nargo execute), then pass it to the Groth16 prover.
// The circuit constrains it to equal the Poseidon2 hash of the private inputs,
// so the proof guarantees it was correctly derived.
//
// Public signal layout: [0]=merkle_root [1]=corridor_id [2]=min_kyc_tier
//                        [3]=max_amount  [4]=amount      [5]=compliance_nullifier
// ---------------------------------------------------------------------------

app.post("/api/prove/compliance", (req, res) => {
  const { amount, ownerField } = req.body as { amount?: string; ownerField?: string };
  if (!amount) { res.status(400).json({ error: "amount is required" }); return; }

  const depositorPubkey = ownerField ?? "1";

  try {
    // Deposit is the on-ramp (sending) side of the corridor.
    const kyc = complianceKycInputs("send");

    // Step 1: pre-compute the nullifier using the compliance_nf_util circuit.
    const complianceNullifier = computeComplianceNullifier(
      kyc.secret_salt,
      depositorPubkey,
      String(amount),
      kyc.corridor_id,
    );

    // Step 2: generate the Groth16 proof with the nullifier as a public input.
    const inputs = {
      ...kyc,
      amount:               String(amount),
      depositor_pubkey:     depositorPubkey,
      compliance_nullifier: complianceNullifier,
    };
    const result = generateProof("compliance", inputs);

    // signal[5] is the compliance_nullifier (public input verified by the circuit).
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

    res.json({ commitment, newRoot, rootSignature: signRoot(CORRIDOR_ID, newRoot) });
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
    /** Caller-supplied commitment to skip recomputation (avoids formula mismatch). */
    commitment?:     string;
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
    // Step 1: Resolve the input note commitment.
    // Use caller-supplied value if provided to avoid input-commitment formula mismatch.
    // fieldToHex64 handles both 0x-hex and decimal field element strings.
    const commitment = body.commitment
      ? fieldToHex64(body.commitment)
      : fieldToHex64(computeNoteCommitment(body.ownerField, body.value, assetId, body.blinding));

    // Step 2: Load the real pool tree and find the Merkle path.
    // Poll for up to 60 seconds to handle Soroban testnet RPC propagation delay.
    let leaves: string[] = [];
    let targetIdx = -1;
    const pollDeadline = Date.now() + 60_000;
    while (Date.now() < pollDeadline) {
      ({ leaves } = await loadAllCommitments());
      targetIdx = leaves.findIndex(
        l => l.toLowerCase().replace(/^0x/, "") === commitment
      );
      if (targetIdx !== -1) break;
      console.log(
        `[transfer] Waiting for commitment ${commitment.slice(0, 8)}... ` +
        `to appear on-chain (${leaves.length} leaf/leaves visible so far)...`
      );
      await new Promise(r => setTimeout(r, 3000));
    }

    if (targetIdx === -1) {
      throw new Error(
        `Note commitment ${commitment.slice(0, 12)}... not found in pool after 60s. ` +
        `Deposit the note first.`
      );
    }

    const merklePath = computeMerklePath(leaves, targetIdx);

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

    // Normalize output commitments to the same hex form that loadAllCommitments
    // returns. publicSignals[] values are decimal strings from snarkjs; the
    // on-chain leaves come back as hex. Keeping them in the same format ensures
    // the findIndex comparison in the withdraw step always succeeds.
    const actualCommit1 = fieldToHex64(result.publicSignals[2] ?? pubVals.newCommitment1);
    const actualCommit2 = fieldToHex64(result.publicSignals[3] ?? pubVals.newCommitment2);
    const actualNewRoot = computeNewRoot(leaves, "0x" + actualCommit1, "0x" + actualCommit2);

    // Bob's note receipt: everything Bob needs to spend his output note.
    // commitment is hex-normalized so it directly matches the on-chain leaf.
    const bobNote = {
      owner:      body.recipient,
      value:      outputValue1,
      assetId,
      blinding:   outputBlinding1,
      secretKey:  randomField(),
      commitment: "0x" + actualCommit1,  // 0x-hex, 64 chars — ready for leaf comparison
    };

    res.json({
      proof:          result.proof,
      pubSignals:     result.pubSignals,
      publicSignals:  result.publicSignals,
      spendNullifier: result.publicSignals[1] ?? "0",
      newCommitment1: actualCommit1,   // hex (no 0x) — callers use fieldToHex on this
      newCommitment2: actualCommit2,
      merkleRoot:     result.publicSignals[0] ?? "0",
      newRoot:        actualNewRoot,
      rootSignature:  signRoot(CORRIDOR_ID, actualNewRoot),
      bobNote,
    });
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// POST /api/prove/withdraw
//
// Generates TWO Groth16 proofs for Bob's off-ramp:
//   1. shielded_transfer proof  — proves Bob owns the note and authorises spending.
//      (pub_withdraw_amount = outputValue1, dual-mode withdraw path)
//   2. compliance proof         — proves Bob is KYC'd for the receiving corridor.
//      (PRD §6.2 — used at BOTH deposit and withdraw edges)
//
// Both proofs are verified on-chain inside ShieldedPool.withdraw().
// ---------------------------------------------------------------------------

app.post("/api/prove/withdraw", async (req, res) => {
  const body = req.body as {
    ownerField?:  string;
    value?:       string;
    assetId?:     string;
    blinding?:    string;
    secretKey?:   string;
    recipient?:   string;
    /** If provided, use this commitment directly instead of recomputing.
     *  Bob's note commitment is an OUTPUT commitment (different formula from input),
     *  so recomputation via computeNoteCommitment would produce the wrong value. */
    commitment?:  string;
  };

  if (!body.ownerField || !body.value || !body.blinding || !body.secretKey || !body.recipient) {
    res.status(400).json({ error: "ownerField, value, blinding, secretKey, recipient required" });
    return;
  }

  const assetId       = body.assetId ?? ASSET_ID;
  const outputValue1  = body.value;  // full note value goes to recipient
  const fee           = "0";
  const outputValue2  = "0";        // no change note
  const outputBlinding1 = randomField();
  const outputBlinding2 = randomField();

  try {
    // ── Step 1: Shielded spend proof ──────────────────────────────────────────

    // Use the caller-supplied commitment if available (avoids input vs output
    // commitment formula mismatch for Bob's note).
    // fieldToHex64 normalises 0x-hex, raw hex, or decimal to 64-char lowercase hex.
    const commitment = fieldToHex64(
      body.commitment ??
      computeNoteCommitment(body.ownerField, body.value, assetId, body.blinding)
    );

    // ── Phase 1: Wait until Bob's commitment appears AND the pool root is stable ──
    //
    // Alice's transfer adds TWO leaves (Bob's note + change note). The Soroban
    // testnet RPC can lag: one leaf might appear before the other, and the RPC
    // node might serve a stale cached root that doesn't reflect the full insertion.
    //
    // We wait until:
    //   (a) Bob's commitment is visible in loadAllCommitments(), AND
    //   (b) tree_builder's computed root equals readPoolRoot(), AND
    //   (c) That root is confirmed STABLE across 2 extra reads (3 s apart).
    //
    // Stability confirmation prevents the common failure where a momentarily-
    // lagging RPC node briefly matches but then refreshes to a different value
    // while nargo is running (~30 s), causing the proof's merkle_root to be stale.

    let wLeaves: string[] = [];
    let wTargetIdx = -1;
    let merklePath = { root: "", siblings: [] as string[], index: -1 };

    const wPollDeadline = Date.now() + 180_000; // 3 min total
    outer: while (Date.now() < wPollDeadline) {
      ({ leaves: wLeaves } = await loadAllCommitments());
      wTargetIdx = wLeaves.findIndex(l => l.toLowerCase().replace(/^0x/, "") === commitment);

      if (wTargetIdx === -1) {
        console.log(
          `[withdraw] Waiting for commitment ${commitment.slice(0, 8)}... ` +
          `to appear on-chain (${wLeaves.length} leaves visible so far)...`
        );
        await new Promise(r => setTimeout(r, 4000));
        continue;
      }

      // Commitment found — verify root consistency.
      merklePath = computeMerklePath(wLeaves, wTargetIdx);
      const onChainRoot = await readPoolRoot();
      const computedRoot = merklePath.root.toLowerCase().replace(/^0x/, "");
      const storedRoot   = onChainRoot.toLowerCase().replace(/^0x/, "");

      if (computedRoot !== storedRoot) {
        console.log(
          `[withdraw] Commitment found but root mismatch: computed ${computedRoot.slice(0, 8)}... ` +
          `stored ${storedRoot.slice(0, 8)}... — waiting for all leaves to propagate...`
        );
        await new Promise(r => setTimeout(r, 4000));
        continue;
      }

      // Root matched once. Confirm it's STABLE by checking 2 more times, 3 s apart.
      for (let c = 1; c <= 2; c++) {
        await new Promise(r => setTimeout(r, 3000));
        const confirmRoot = (await readPoolRoot()).toLowerCase().replace(/^0x/, "");
        if (confirmRoot !== computedRoot) {
          console.log(
            `[withdraw] Root changed during stability check #${c}: ` +
            `was ${computedRoot.slice(0, 8)}..., now ${confirmRoot.slice(0, 8)}... — reloading...`
          );
          await new Promise(r => setTimeout(r, 2000));
          continue outer;
        }
        console.log(`[withdraw] Root stability ${c}/2 ✓ (${computedRoot.slice(0, 8)}...)`);
      }

      console.log(`[withdraw] Commitment at index ${wTargetIdx}, root stable and confirmed ✓`);
      break;
    }

    if (wTargetIdx === -1) {
      throw new Error(
        `Note commitment ${commitment.slice(0, 12)}... not found in pool after 180s. ` +
        `Did the transfer (deposit → transfer) complete on-chain first?`
      );
    }

    // ── Phase 2: Generate proof with retry if root drifts while nargo runs ───
    //
    // nargo can take 30–60 s. If any new pool transaction lands during that window,
    // the root stored on-chain diverges from pubVals.merkleRoot → StaleRoot.
    //
    // After nargo finishes, re-read the root. If it changed, reload pool state
    // (so siblings cover the new leaf) and regenerate. Up to 3 attempts total.

    let pubVals!: ReturnType<typeof computeNoteValues>;
    let leaves!: string[];
    let newRoot!: string;
    const MAX_PROOF_RETRIES = 3;

    for (let attempt = 1; attempt <= MAX_PROOF_RETRIES; attempt++) {
      leaves = wLeaves;

      pubVals = computeNoteValues({
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

      // Re-read pool root immediately after nargo returns to detect drift.
      const postProofRoot = (await readPoolRoot()).toLowerCase().replace(/^0x/, "");
      const proofRoot     = pubVals.merkleRoot.toLowerCase().replace(/^0x/, "");

      if (postProofRoot === proofRoot) {
        console.log(`[withdraw] Post-proof root check ✓ (attempt ${attempt})`);
        break;
      }

      console.log(
        `[withdraw] Root drifted while nargo ran (attempt ${attempt}/${MAX_PROOF_RETRIES}): ` +
        `proof has ${proofRoot.slice(0, 8)}..., chain now has ${postProofRoot.slice(0, 8)}...`
      );

      if (attempt === MAX_PROOF_RETRIES) {
        throw new Error(
          `Pool root kept changing during proof generation (${MAX_PROOF_RETRIES} attempts). ` +
          `Ensure no new deposits/transfers are submitted while Bob withdraws, then retry.`
        );
      }

      // Reload pool state so the next attempt's siblings cover the new leaf.
      console.log(`[withdraw] Reloading pool state for retry ${attempt + 1}...`);
      await new Promise(r => setTimeout(r, 5000));

      ({ leaves: wLeaves } = await loadAllCommitments());
      wTargetIdx = wLeaves.findIndex(l => l.toLowerCase().replace(/^0x/, "") === commitment);
      if (wTargetIdx === -1) {
        throw new Error(`Commitment disappeared from pool on retry ${attempt + 1}?`);
      }
      merklePath = computeMerklePath(wLeaves, wTargetIdx);
    }

    newRoot = computeNewRoot(leaves, pubVals.newCommitment1, pubVals.newCommitment2);

    // Off-ramp: pub_withdraw_amount = outputValue1 (amount revealed at anchor edge).
    // Dual-mode constraint: (outputValue1 - outputValue1) * outputValue1 == 0 — satisfied.
    // Contract's withdraw() checks signal[6] == amount to close the drain vulnerability.
    const shieldedInputs = {
      merkle_root:         pubVals.merkleRoot,
      nullifier_hash:      pubVals.nullifierHash,
      new_commitment_1:    pubVals.newCommitment1,
      new_commitment_2:    pubVals.newCommitment2,
      fee,
      pub_asset_id:        assetId,
      pub_withdraw_amount: pubVals.outputValue1,
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

    const shieldedResult = generateProof("shielded_transfer", shieldedInputs);

    // ── Step 2: Compliance proof for the off-ramp edge (PRD §6.2) ─────────────
    //
    // Bob must prove he is KYC'd for the receiving jurisdiction and not
    // sanctioned, and that the withdrawal amount is within corridor limits.
    //
    // Pre-compute the compliance_nullifier via compliance_nf_util, then pass it
    // as a public input.  Using body.ownerField (Bob's pubkey) as depositor_pubkey
    // ensures Bob's off-ramp nullifier is distinct from Alice's deposit nullifier.
    // Withdraw is the off-ramp (receiving) side of the corridor.
    const withdrawKyc = complianceKycInputs("receive");
    const withdrawComplianceNullifier = computeComplianceNullifier(
      withdrawKyc.secret_salt,
      body.ownerField,
      outputValue1,
      withdrawKyc.corridor_id,
    );
    const complianceInputs = {
      ...withdrawKyc,
      amount:               outputValue1,
      depositor_pubkey:     body.ownerField,
      compliance_nullifier: withdrawComplianceNullifier,
    };
    const complianceResult = generateProof("compliance", complianceInputs);

    res.json({
      // Shielded spend proof
      proof:          shieldedResult.proof,
      pubSignals:     shieldedResult.pubSignals,
      publicSignals:  shieldedResult.publicSignals,
      spendNullifier: shieldedResult.publicSignals[1] ?? "0",
      newCommitment1: shieldedResult.publicSignals[2] ?? "0",
      newCommitment2: shieldedResult.publicSignals[3] ?? "0",
      merkleRoot:     shieldedResult.publicSignals[0] ?? "0",
      newRoot,
      rootSignature:  signRoot(CORRIDOR_ID, newRoot),
      // Compliance proof for off-ramp KYC gate
      complianceProof:          complianceResult.proof,
      compliancePubSignals:     complianceResult.pubSignals,
      compliancePublicSignals:  complianceResult.publicSignals,
      complianceNullifier:      complianceResult.publicSignals[5] ?? "0",
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

// Operator root-attestation public key (hex). The pool (v9+) is constructed with
// this key and verifies that every new root is signed by it. Used by the deploy
// script (scripts/deploy-pool-v9.mjs) to wire the constructor argument.
app.get("/api/operator-pubkey", (_req, res) => {
  res.json({ operatorPubkey: getOperatorPublicKeyHex(), corridorId: CORRIDOR_ID });
});

// ---------------------------------------------------------------------------
// AttestProtocol on-chain KYC attestations (Tier C)
//
// The issuer is a real KYC *authority*: it issues delegated AttestProtocol
// attestations about a wallet, which the ShieldedPool then verifies on-chain.
//   GET  /api/kyc/config            -> protocol id, authority, schema, bls pubkey
//   GET  /api/kyc/status?address=G  -> { verified, attestationUid, ... }
//   POST /api/kyc/enroll { address, side } -> issues delegated attestation
// ---------------------------------------------------------------------------

// Country code per corridor side (ISO-3166 numeric). Sending = US(840), receiving = NG(566).
function sideKycAttributes(side: KycSide): { tier: number; country: number } {
  return side === "receive" ? { tier: 2, country: 566 } : { tier: 2, country: 840 };
}

app.get("/api/kyc/config", (_req, res) => {
  const cfg = loadAttestConfig();
  if (!cfg) {
    res.json({ configured: false });
    return;
  }
  // Per-edge expected attestation value. The pool (v11+) enforces these
  // byte-for-byte on-chain, so they are the single source of truth shared by
  // the deploy script (constructor args) and any client.
  const send = sideKycAttributes("send");
  const recv = sideKycAttributes("receive");
  res.json({
    configured:           true,
    provider:             "AttestProtocol",
    protocol:             cfg.protocol,
    authority:            cfg.authority,
    schemaUid:            cfg.schemaUid.toString("hex"),
    schemaDef:            cfg.schemaDef,
    blsPublicKey:         getBlsPublicKeyHex(),
    expectedValueSend:    kycClaimValue(send.tier, send.country),
    expectedValueReceive: kycClaimValue(recv.tier, recv.country),
  });
});

app.get("/api/kyc/status", async (req, res) => {
  try {
    const address = String(req.query.address ?? "").trim();
    if (!address.startsWith("G") || address.length !== 56) {
      res.status(400).json({ error: "valid `address` (G...) query param required" });
      return;
    }
    res.json(await getKycStatus(address));
  } catch (err: any) {
    res.status(500).json({ error: String(err?.message ?? err) });
  }
});

app.post("/api/kyc/enroll", async (req, res) => {
  try {
    const address = String(req.body?.address ?? "").trim();
    if (!address.startsWith("G") || address.length !== 56) {
      res.status(400).json({ error: "valid `address` (G...) required" });
      return;
    }
    const side: KycSide = req.body?.side === "receive" ? "receive" : "send";
    if (!loadAttestConfig()) {
      res.status(503).json({ error: "AttestProtocol not configured — run scripts/deploy-attest-protocol.mjs" });
      return;
    }
    const { tier, country } = sideKycAttributes(side);
    const result = await enrollKyc(address, { tier, country, side });
    res.json({ ok: true, ...result });
  } catch (err: any) {
    console.error("KYC enroll failed:", err);
    res.status(500).json({ error: String(err?.message ?? err) });
  }
});

// Revoke a wallet's KYC attestation (authority action). After this propagates,
// the pool's on-chain gate rejects the wallet with KycAttestationRevoked.
app.post("/api/kyc/revoke", async (req, res) => {
  try {
    const address = String(req.body?.address ?? "").trim();
    if (!address.startsWith("G") || address.length !== 56) {
      res.status(400).json({ error: "valid `address` (G...) required" });
      return;
    }
    if (!loadAttestConfig()) {
      res.status(503).json({ error: "AttestProtocol not configured — run scripts/deploy-attest-protocol.mjs" });
      return;
    }
    const result = await revokeKyc(address);
    res.json({ ok: true, ...result });
  } catch (err: any) {
    console.error("KYC revoke failed:", err);
    res.status(500).json({ error: String(err?.message ?? err) });
  }
});

async function main() {
  try {
    kycMode = await resolveKycMode(
      process.env.KYC_MODE,
      DEMO_KYC_BASE.merkle_root,
      getRegistryRoot(),
    );
    const onChain = await readRegistryRoot();
    console.log(`KYC mode: ${kycMode} (on-chain registry root ${onChain.slice(0, 14)}…)`);
  } catch (err) {
    console.warn(`Could not auto-detect KYC mode (${err}) — using demo`);
    kycMode = process.env.KYC_MODE === "registry" ? "registry" : "demo";
    console.log(`KYC mode: ${kycMode} (fallback)`);
  }

  app.listen(PORT, () => {
    console.log(`ShadowWire proving server on http://localhost:${PORT}`);
    console.log(`Operator root-attestation pubkey: ${getOperatorPublicKeyHex()}`);
    console.log(`POST /api/prove/compliance  { amount }`);
    console.log(`POST /api/prove/deposit     { ownerField, value, blinding, secretKey }`);
    console.log(`POST /api/prove/transfer    { ownerField, value, blinding, secretKey, recipient, outputValue1, fee }`);
    console.log(`POST /api/prove/withdraw    { ownerField, value, blinding, secretKey, recipient }`);
    console.log(`GET  /api/operator-pubkey`);
    const attestCfg = loadAttestConfig();
    if (attestCfg) {
      console.log(`AttestProtocol KYC: ${attestCfg.protocol} (authority ${attestCfg.authority.slice(0, 8)}…)`);
      console.log(`POST /api/kyc/enroll        { address, side }`);
      console.log(`POST /api/kyc/revoke        { address }`);
      console.log(`GET  /api/kyc/status        ?address=G…`);
      console.log(`GET  /api/kyc/config`);
    } else {
      console.log(`AttestProtocol KYC: not configured (run scripts/deploy-attest-protocol.mjs)`);
    }
  });
}

main().catch(err => {
  console.error("Failed to start proving server:", err);
  process.exit(1);
});
