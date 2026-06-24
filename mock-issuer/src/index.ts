import express from "express";
import cors from "cors";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const PORT = Number(process.env.PORT ?? 3001);

const CIRCUITS = ["compliance", "shielded_transfer"] as const;

function ensureArtifacts(circuit: string) {
  const proofDir = path.join(ROOT, "target/groth16", circuit, "proof");
  const stellarDir = path.join(ROOT, "target/groth16", circuit, "stellar");
  if (!fs.existsSync(path.join(proofDir, "proof.json"))) {
    const ptaupower = circuit === "shielded_transfer" ? "15" : "12";
    execSync(`PTAU_POWER=${ptaupower} bash scripts/run-circuit.sh circuits/${circuit}`, {
      cwd: ROOT,
      stdio: "inherit",
    });
  }
  fs.mkdirSync(stellarDir, { recursive: true });
  const encode = path.join(ROOT, "scripts/encode_bn254_for_soroban.mjs");
  for (const kind of ["proof", "public"] as const) {
    const out = path.join(stellarDir, `${kind}.hex`);
    if (!fs.existsSync(out)) {
      const hex = execSync(`node "${encode}" ${kind} "${proofDir}/${kind}.json"`, {
        encoding: "utf8",
      }).trim();
      fs.writeFileSync(out, hex);
    }
  }
}

function loadProofBundle(circuit: string) {
  ensureArtifacts(circuit);
  const stellarDir = path.join(ROOT, "target/groth16", circuit, "stellar");
  const proofDir = path.join(ROOT, "target/groth16", circuit, "proof");
  const proofHex = fs.readFileSync(path.join(stellarDir, "proof.hex"), "utf8").trim();
  const publicHex = fs.readFileSync(path.join(stellarDir, "public.hex"), "utf8").trim();
  const publicSignals = JSON.parse(
    fs.readFileSync(path.join(proofDir, "public.json"), "utf8")
  ) as string[];
  const inputs = JSON.parse(
    fs.readFileSync(path.join(ROOT, "circuits", circuit, "inputs.json"), "utf8")
  ) as Record<string, string>;
  return { proofHex, publicHex, publicSignals, inputs };
}

function hexToBytes(hex: string): number[] {
  const clean = hex.replace(/^0x/i, "");
  const out: number[] = [];
  for (let i = 0; i < clean.length; i += 2) {
    out.push(parseInt(clean.slice(i, i + 2), 16));
  }
  return out;
}

const app = express();
app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "shadowwire-mock-issuer" });
});

app.get("/api/attestation", (_req, res) => {
  const bundle = loadProofBundle("compliance");
  res.json({
    attributeCommitment: bundle.inputs.attribute_commitment,
    minKycTier: Number(bundle.inputs.min_kyc_tier),
    maxAmount: bundle.inputs.max_amount,
    amount: bundle.inputs.amount,
    countryCode: bundle.inputs.country_code,
    kycTier: bundle.inputs.kyc_tier,
  });
});

app.get("/api/proofs/:circuit", (req, res) => {
  const circuit = req.params.circuit;
  if (!CIRCUITS.includes(circuit as (typeof CIRCUITS)[number])) {
    res.status(404).json({ error: "unknown circuit" });
    return;
  }
  const bundle = loadProofBundle(circuit);
  res.json({
    circuit,
    proof: hexToBytes(bundle.proofHex),
    pubSignals: hexToBytes(bundle.publicHex),
    publicSignals: bundle.publicSignals,
    inputs: bundle.inputs,
  });
});

app.get("/api/demo-note", (_req, res) => {
  const bundle = loadProofBundle("shielded_transfer");
  const i = bundle.inputs;
  res.json({
    inputCommitment: "0x0918150e2fafd0801ad77c0f188eb23323d57e8348abca6cd8f5d86dad1e2863",
    merkleRoot: i.merkle_root,
    nullifierHash: i.nullifier_hash,
    newCommitment: i.new_commitment,
    fee: i.fee,
    inputCommitmentNote: {
      owner: i.owner_pubkey,
      value: i.value,
      assetId: i.asset_id,
      blinding: i.blinding_factor,
      secretKey: i.note_secret_key,
    },
    outputNote: {
      owner: i.recipient_pubkey,
      value: i.output_value,
      blinding: i.output_blinding,
    },
  });
});

app.listen(PORT, () => {
  console.log(`ShadowWire mock issuer listening on http://localhost:${PORT}`);
});
