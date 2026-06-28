#!/usr/bin/env node
/**
 * deploy-attest-protocol.mjs
 *
 * Deploys the REAL AttestProtocol "protocol" contract (Stellar's EAS-equivalent
 * on-chain attestation service) to testnet, initializes it, and registers our
 * KYC schema.
 *
 * Why self-deploy: AttestProtocol's public testnet contracts were wiped by a
 * testnet reset (see contracts/external/README.md). We host the same audited
 * code ourselves so the ShieldedPool can verify KYC attestations on-chain.
 *
 * Outputs (written to testnet-addresses.json + frontend/public copy):
 *   contracts.attest_protocol   — deployed protocol contract id
 *   attestation.kyc_schema_uid  — UID of the registered KYC schema (hex)
 *   attestation.kyc_authority   — deployer G-address (the trusted attester)
 *   attestation.kyc_schema_def  — exact schema definition string
 *
 * Usage:
 *   node scripts/deploy-attest-protocol.mjs
 */

import { spawnSync } from "node:child_process";
import fs   from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const ROOT       = path.resolve(__dirname, "..");
const ADDRS_FILE = path.join(ROOT, "testnet-addresses.json");
const NETWORK    = "testnet";
const WASM       = path.join(ROOT, "contracts/external/attest_protocol.wasm");

// Must byte-match what the issuer and pool expect. Keep in sync with
// mock-issuer kyc-attest.ts (KYC_SCHEMA_DEF).
const KYC_SCHEMA_DEF = "struct KYC { bool verified; u32 tier; u32 country; }";

function log(m) { console.log(m); }
function section(t) {
  console.log(`\n${"─".repeat(60)}\n  ${t}\n${"─".repeat(60)}`);
}
function loadAddresses() { return JSON.parse(fs.readFileSync(ADDRS_FILE, "utf8")); }
function saveAddresses(data) {
  fs.writeFileSync(ADDRS_FILE, JSON.stringify(data, null, 2));
  fs.mkdirSync(path.join(ROOT, "frontend/public"), { recursive: true });
  fs.writeFileSync(
    path.join(ROOT, "frontend/public/testnet-addresses.json"),
    JSON.stringify(data, null, 2)
  );
}

function stellar(...args) {
  const envPath = `${ROOT}/.tools:${process.env.HOME}/.cargo/bin:${process.env.PATH}`;
  log(`  $ stellar ${args.join(" ")}`);
  const r = spawnSync("stellar", args, {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    env: { ...process.env, PATH: envPath },
  });
  if (r.stderr) process.stdout.write(r.stderr);
  if (r.stdout) process.stdout.write(r.stdout);
  const combined = (r.stdout ?? "") + (r.stderr ?? "");
  if (r.status !== 0) {
    const err = new Error(`stellar failed (exit ${r.status})`);
    err.output = combined;
    throw err;
  }
  return combined;
}

function deployWithRetry(args, maxAttempts = 6) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try { return stellar(...args); }
    catch (err) {
      lastErr = err;
      const out = String(err?.output ?? err?.message ?? err);
      // TxBadSeq: CLI sequence race. "Wasm does not exist"/MissingValue: the
      // upload tx hasn't propagated to RPC yet when deploy simulates.
      if (attempt < maxAttempts && /TxBadSeq|bad seq|Wasm does not exist|MissingValue/i.test(out)) {
        const waitMs = attempt * 4000;
        log(`  ⚠ transient deploy error (attempt ${attempt}/${maxAttempts}) — waiting ${waitMs/1000}s…`);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

function extractContractId(out) {
  const clean = out.replace(/\x1b\[[0-9;]*m/g, "");
  const m = clean.match(/\b(C[A-Z2-7]{55})\b/);
  return m ? m[1] : null;
}
function extractTx(out) {
  const clean = out.replace(/\x1b\[[0-9;]*m/g, "");
  const m = clean.match(/testnet\/tx\/([a-f0-9]{64})/i);
  return m ? m[1] : null;
}
/** Parse a BytesN<32> hex string from a `contract invoke` stdout (quoted JSON). */
function extractHex32(out) {
  const clean = out.replace(/\x1b\[[0-9;]*m/g, "");
  const m = clean.match(/"?([0-9a-fA-F]{64})"?/);
  return m ? m[1].toLowerCase() : null;
}

async function main() {
  log("╔═══════════════════════════════════════════════════════════╗");
  log("║  ShadowWire — Deploy AttestProtocol (real, self-hosted)   ║");
  log("╚═══════════════════════════════════════════════════════════╝");

  if (!fs.existsSync(WASM)) {
    throw new Error(`Vendored wasm not found at ${WASM}. See contracts/external/README.md`);
  }

  const DEPLOYER = stellar("keys", "public-key", "deployer").trim();
  log(`  Deployer / KYC authority: ${DEPLOYER}`);

  section("Step 1a — Upload AttestProtocol WASM");
  const uploadOut = stellar(
    "contract", "upload",
    "--wasm", WASM,
    "--network", NETWORK,
    "--source-account", "deployer",
  );
  const WASM_HASH = (uploadOut.replace(/\x1b\[[0-9;]*m/g, "").match(/\b([0-9a-f]{64})\b/) || [])[1];
  if (!WASM_HASH) throw new Error("Could not parse uploaded wasm hash");
  log(`  WASM hash: ${WASM_HASH}`);
  log("  Waiting 10s for upload to propagate on RPC…");
  await new Promise(r => setTimeout(r, 10000));

  section("Step 1b — Deploy AttestProtocol protocol contract");
  const deployOut = deployWithRetry([
    "contract", "deploy",
    "--wasm-hash", WASM_HASH,
    "--network", NETWORK,
    "--source-account", "deployer",
  ]);
  const ATTEST_ID = extractContractId(deployOut);
  if (!ATTEST_ID) throw new Error("Could not extract AttestProtocol contract id");
  log(`  AttestProtocol deployed: ${ATTEST_ID}`);

  section("Step 2 — initialize(admin = deployer)");
  // Wait for deploy to propagate so the invoke can find the contract.
  log("  Waiting 12s for deploy to propagate…");
  await new Promise(r => setTimeout(r, 12000));
  const initOut = stellar(
    "contract", "invoke", "--id", ATTEST_ID, "--network", NETWORK,
    "--source-account", "deployer", "--send=yes", "--",
    "initialize", "--admin", DEPLOYER,
  );
  log(`  Initialized ✓ (tx ${extractTx(initOut) ?? "?"})`);

  section("Step 3 — register KYC schema");
  log(`  definition: ${KYC_SCHEMA_DEF}`);
  const regOut = stellar(
    "contract", "invoke", "--id", ATTEST_ID, "--network", NETWORK,
    "--source-account", "deployer", "--send=yes", "--",
    "register",
    "--caller", DEPLOYER,
    "--schema_definition", KYC_SCHEMA_DEF,
    "--revocable", "true",
  );
  const SCHEMA_UID = extractHex32(regOut);
  if (!SCHEMA_UID) throw new Error("Could not parse KYC schema UID from register output");
  log(`  KYC schema UID: ${SCHEMA_UID}`);

  section("Step 4 — persist to testnet-addresses.json");
  const addrs = loadAddresses();
  addrs.contracts = addrs.contracts ?? {};
  addrs.contracts.attest_protocol = ATTEST_ID;
  addrs.attestation = {
    provider:       "AttestProtocol",
    protocol:       ATTEST_ID,
    kyc_authority:  DEPLOYER,
    kyc_schema_uid: SCHEMA_UID,
    kyc_schema_def: KYC_SCHEMA_DEF,
    source_commit:  "b242b5b630d1ff41610d6b60e511792fef59d3d4",
  };
  addrs.txs = addrs.txs ?? {};
  addrs.txs.attest_protocol_upload   = extractTx(uploadOut) ?? "";
  addrs.txs.attest_protocol_deploy   = extractTx(deployOut) ?? "";
  addrs.txs.attest_protocol_init     = extractTx(initOut)   ?? "";
  addrs.txs.attest_kyc_schema_register = extractTx(regOut)  ?? "";
  saveAddresses(addrs);
  log("  testnet-addresses.json updated ✓");

  log("\n╔═══════════════════════════════════════════════════════════╗");
  log("║  AttestProtocol live on testnet ✅                         ║");
  log("╚═══════════════════════════════════════════════════════════╝");
  log(`  protocol      : ${ATTEST_ID}`);
  log(`  kyc authority : ${DEPLOYER}`);
  log(`  kyc schema    : ${SCHEMA_UID}`);
  log("\n  Next: register the issuer BLS key + enroll users (mock-issuer).");
}

main().catch(err => {
  console.error("\n❌  deploy-attest-protocol failed:", err.message ?? err);
  if (err.output) console.error(err.output);
  process.exit(1);
});
