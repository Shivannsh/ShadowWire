#!/usr/bin/env node
/**
 * deploy-pool-v9.mjs
 *
 * Deploys a fresh shielded_pool (v9) that closes the prover-supplied-root
 * vulnerability. v9 requires every new commitment-tree root to be signed by a
 * registered operator ed25519 key (the proving server), so a caller can no longer
 * install the root of a fabricated tree and drain the pool.
 *
 * What changed vs v8:
 *   - Constructor takes an extra `--operator_pubkey` (32-byte hex, from the issuer).
 *   - deposit/transfer/withdraw take an extra `--root_signature` (64-byte hex)
 *     right after `--new_root`. The issuer returns it as `rootSignature`.
 *
 * Prereqs:
 *   - mock-issuer running (npm run issuer) so we can read the operator pubkey and
 *     get signed roots. The operator key is persisted at mock-issuer/.operator-key.json.
 *   - CORRIDOR_ID env in the issuer must match the pool's corridor_id (default 1).
 *
 * Usage:
 *   node scripts/deploy-pool-v9.mjs            # deploy only
 *   RUN_SELFTEST=1 node scripts/deploy-pool-v9.mjs   # deploy + full corridor self-test
 */

import { spawnSync, execSync } from "node:child_process";
import fs   from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, "..");
const ADDRS_FILE = path.join(ROOT, "testnet-addresses.json");
const ISSUER_URL = process.env.ISSUER_URL ?? "http://localhost:3001";
const NETWORK    = "testnet";
const AMOUNT     = process.env.AMOUNT ?? "5";
const CORRIDOR_ID = process.env.CORRIDOR_ID ?? "1";
const RUN_SELFTEST = process.env.RUN_SELFTEST === "1";

const INITIAL_ROOT = "0".repeat(64);

function log(msg) { console.log(msg); }
function section(title) {
  console.log();
  console.log(`${"─".repeat(60)}`);
  console.log(`  ${title}`);
  console.log(`${"─".repeat(60)}`);
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
  const result = spawnSync("stellar", args, {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    env: { ...process.env, PATH: envPath },
  });
  if (result.stderr) process.stdout.write(result.stderr);
  if (result.stdout) process.stdout.write(result.stdout);
  const combined = (result.stdout ?? "") + (result.stderr ?? "");
  if (result.status !== 0) {
    const err = new Error(`stellar failed (exit ${result.status})`);
    err.output = combined;
    throw err;
  }
  return combined;
}

/**
 * Run `stellar contract deploy` with retry on TxBadSeq.
 *
 * The CLI submits WASM upload then contract deploy as two sequential txs. If the
 * deploy tx is built before Horizon reflects the upload's sequence bump, submission
 * fails with TxBadSeq even though the WASM is already on-chain. Retrying fixes it —
 * the retry skips install and only sends deploy.
 */
function stellarDeployWithRetry(deployArgs, maxAttempts = 4) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return stellar(...deployArgs);
    } catch (err) {
      lastErr = err;
      const out = String(err?.output ?? err?.message ?? err);
      if (attempt < maxAttempts && /TxBadSeq|bad seq/i.test(out)) {
        const waitMs = attempt * 3000;
        log(`  ⚠ TxBadSeq on deploy (attempt ${attempt}/${maxAttempts}) — waiting ${waitMs / 1000}s, then retrying…`);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

function extractContractId(output) {
  const clean = output.replace(/\x1b\[[0-9;]*m/g, "");
  const match = clean.match(/\b(C[A-Z2-7]{55})\b/);
  return match ? match[1] : null;
}
function extractTx(output) {
  const clean = output.replace(/\x1b\[[0-9;]*m/g, "");
  const match = clean.match(/testnet\/tx\/([a-f0-9]{64})/i);
  return match ? match[1] : null;
}

async function api(endpoint, body) {
  const res = await fetch(`${ISSUER_URL}${endpoint}`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`POST ${endpoint} failed (${res.status}): ${text}`);
  return JSON.parse(text);
}
async function apiGet(endpoint) {
  const res = await fetch(`${ISSUER_URL}${endpoint}`);
  const text = await res.text();
  if (!res.ok) throw new Error(`GET ${endpoint} failed (${res.status}): ${text}`);
  return JSON.parse(text);
}

function fieldToHex(field) {
  const s = String(field).trim();
  const stripped = (s.startsWith("0x") || s.startsWith("0X")) ? s.slice(2) : s;
  if (/[a-fA-F]/.test(stripped)) return stripped.toLowerCase().padStart(64, "0");
  return BigInt(s).toString(16).padStart(64, "0");
}
function bytesToHex(arr) { return arr.map(b => b.toString(16).padStart(2, "0")).join(""); }

async function waitForIssuer(maxSecs = 60) {
  for (let i = 0; i < maxSecs; i++) {
    try {
      const r = await fetch(`${ISSUER_URL}/api/attestation/status`);
      if (r.ok) { log("  Proving server: ✓"); return; }
    } catch {}
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error(`Proving server not reachable at ${ISSUER_URL} after ${maxSecs}s`);
}

async function main() {
  log("╔═══════════════════════════════════════════════════════════╗");
  log("║  ShadowWire — Deploy Pool v9 (operator-signed root)       ║");
  log("╚═══════════════════════════════════════════════════════════╝");

  section("Step 0 — Confirm proving server + read operator key");
  await waitForIssuer();
  const { operatorPubkey, corridorId } = await apiGet("/api/operator-pubkey");
  if (!operatorPubkey || operatorPubkey.length !== 64) {
    throw new Error(`Bad operator pubkey from issuer: ${operatorPubkey}`);
  }
  if (String(corridorId) !== String(CORRIDOR_ID)) {
    throw new Error(
      `corridor_id mismatch: issuer signs for ${corridorId} but deploy uses ${CORRIDOR_ID}. ` +
      `Set CORRIDOR_ID consistently for both the issuer and this script.`
    );
  }
  log(`  Operator pubkey: ${operatorPubkey}`);
  log(`  Corridor id:     ${CORRIDOR_ID}`);

  section("Step 1 — Build shielded_pool WASM");
  const envPath = `${ROOT}/.tools:${process.env.HOME}/.cargo/bin:${process.env.PATH}`;
  execSync(
    `stellar contract build --manifest-path "${ROOT}/contracts/shielded_pool/Cargo.toml" --package shielded_pool --optimize`,
    { stdio: "inherit", env: { ...process.env, PATH: envPath, CARGO_TARGET_DIR: `${ROOT}/contracts/target` } }
  );
  log("  WASM built ✓");

  section("Step 2 — Deploy pool v9 (reusing existing verifiers + registry)");
  const addrs = loadAddresses();
  const COMPLIANCE_V = addrs.contracts.compliance_verifier;
  const SHIELDED_V   = addrs.contracts.shielded_transfer_verifier;
  const REGISTRY     = addrs.contracts.compliance_registry;
  const DEPLOYER     = stellar("keys", "public-key", "deployer").trim();
  const ALICE        = stellar("keys", "public-key", "alice").trim();
  const BOB          = stellar("keys", "public-key", "bob").trim();

  const assetCode   = addrs.anchor?.asset_code;
  const assetIssuer = addrs.anchor?.asset_issuer;
  if (!assetCode || !assetIssuer) {
    throw new Error("anchor.asset_code / anchor.asset_issuer missing in testnet-addresses.json");
  }
  const ASSET = extractContractId(
    stellar("contract", "id", "asset", "--asset", `${assetCode}:${assetIssuer}`, "--network", NETWORK)
  );
  if (!ASSET) throw new Error(`Could not derive SAC contract id for ${assetCode}:${assetIssuer}`);

  log(`  Pool asset (SRT SAC): ${ASSET}`);
  log(`  Compliance verifier:  ${COMPLIANCE_V}`);
  log(`  Shielded verifier:    ${SHIELDED_V}`);
  log(`  Registry:             ${REGISTRY}`);

  const WASM = `${ROOT}/contracts/target/wasm32v1-none/release/shielded_pool.wasm`;
  const deployOut = stellarDeployWithRetry([
    "contract", "deploy",
    "--wasm", WASM,
    "--network", NETWORK,
    "--source-account", "deployer",
    "--",
    "--admin",               DEPLOYER,
    "--asset",               ASSET,
    "--compliance_verifier", COMPLIANCE_V,
    "--shielded_verifier",   SHIELDED_V,
    "--registry",            REGISTRY,
    "--corridor_id",         CORRIDOR_ID,
    "--initial_root",        INITIAL_ROOT,
    "--operator_pubkey",     operatorPubkey,
  ]);

  const POOL_V9 = extractContractId(deployOut);
  if (!POOL_V9) throw new Error("Failed to extract pool contract ID from deploy output");
  log(`  Pool v9 deployed: ${POOL_V9}`);

  const prevPool = addrs.contracts.shielded_pool;
  addrs.contracts.shielded_pool_v8_prev = prevPool;
  addrs.contracts.shielded_pool = POOL_V9;
  addrs.txs = addrs.txs ?? {};
  addrs.txs.pool_v9_deploy = extractTx(deployOut) ?? "";
  saveAddresses(addrs);
  log(`  testnet-addresses.json updated — active pool: ${POOL_V9}`);
  log("");
  log("  ⚠ Set NEXT_PUBLIC_POOL_SIGNED_ROOT=true in the frontend env so it sends");
  log("    the root signature with each deposit/transfer/withdraw.");

  if (!RUN_SELFTEST) {
    section("Step 3 — Corridor self-test skipped (set RUN_SELFTEST=1)");
    log(`  ✅ Pool v9 deployed with operator-signed roots.`);
    return;
  }

  section("Step 3 — Full corridor self-test (signed roots)");
  log("  Waiting 20s for pool deployment to propagate on Soroban RPC...");
  await new Promise(r => setTimeout(r, 20000));

  // 3a: deposit
  log("\n  [3a] Alice deposits");
  const depositNote = await api("/api/prove/deposit", {
    ownerField: "1", value: AMOUNT, assetId: "3", blinding: "7", secretKey: "13",
  });
  const depositComp = await api("/api/prove/compliance", { amount: AMOUNT, ownerField: "1" });
  if (!depositNote.rootSignature) throw new Error("issuer did not return rootSignature for deposit");
  const depositOut = stellar(
    "contract", "invoke", "--id", POOL_V9, "--network", NETWORK,
    "--source-account", "alice", "--send=yes", "--",
    "deposit",
    "--depositor",              ALICE,
    "--amount",                 AMOUNT,
    "--note_commitment",        depositNote.commitment.replace(/^0x/, ""),
    "--new_root",               depositNote.newRoot.replace(/^0x/, ""),
    "--root_signature",         depositNote.rootSignature.replace(/^0x/, ""),
    "--compliance_nullifier",   fieldToHex(depositComp.complianceNullifier),
    "--compliance_proof",       bytesToHex(depositComp.proof),
    "--compliance_pub_signals", bytesToHex(depositComp.pubSignals),
  );
  log(`       ✅ Deposit tx: ${extractTx(depositOut)}`);

  const expectedRoot = depositNote.newRoot.replace(/^0x/, "");
  {
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      try {
        const rootOut = stellar("contract", "invoke", "--id", POOL_V9, "--network", NETWORK,
          "--source-account", "alice", "--", "get_root");
        if (rootOut.trim().replace(/^"|"$/g, "").toLowerCase() === expectedRoot.toLowerCase()) break;
      } catch {}
      await new Promise(r => setTimeout(r, 5000));
    }
  }

  // 3b: transfer
  log("\n  [3b] Alice → Bob private transfer");
  const SEND_AMOUNT = String(Math.floor(Number(AMOUNT) * 0.9));
  const transferData = await api("/api/prove/transfer", {
    ownerField: "1", value: AMOUNT, assetId: "3", blinding: "7", secretKey: "13",
    recipient: "2", outputValue1: SEND_AMOUNT, fee: "0", commitment: depositNote.commitment,
  });
  if (!transferData.rootSignature) throw new Error("issuer did not return rootSignature for transfer");
  const bobNote = transferData.bobNote;
  const transferOut = stellar(
    "contract", "invoke", "--id", POOL_V9, "--network", NETWORK,
    "--source-account", "alice", "--send=yes", "--",
    "transfer",
    "--sender",               ALICE,
    "--spend_nullifier",      fieldToHex(transferData.spendNullifier),
    "--new_commitment_1",     fieldToHex(transferData.newCommitment1),
    "--new_commitment_2",     fieldToHex(transferData.newCommitment2),
    "--new_root",             transferData.newRoot.replace(/^0x/, ""),
    "--root_signature",       transferData.rootSignature.replace(/^0x/, ""),
    "--shielded_proof",       bytesToHex(transferData.proof),
    "--shielded_pub_signals", bytesToHex(transferData.pubSignals),
  );
  log(`       ✅ Transfer tx: ${extractTx(transferOut)}`);

  const expectedTransferRoot = (transferData.newRoot ?? "").replace(/^0x/, "");
  {
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      try {
        const rootOut = stellar("contract", "invoke", "--id", POOL_V9, "--network", NETWORK,
          "--source-account", "bob", "--", "get_root");
        if (rootOut.trim().replace(/^"|"$/g, "").toLowerCase() === expectedTransferRoot.toLowerCase()) break;
      } catch {}
      await new Promise(r => setTimeout(r, 5000));
    }
  }

  // 3c: withdraw
  log("\n  [3c] Bob withdraws");
  await new Promise(r => setTimeout(r, 6000));
  const withdrawData = await api("/api/prove/withdraw", {
    ownerField: bobNote.owner, value: bobNote.value, assetId: bobNote.assetId,
    blinding: bobNote.blinding, secretKey: bobNote.secretKey,
    recipient: bobNote.owner, commitment: bobNote.commitment,
  });
  if (!withdrawData.rootSignature) throw new Error("issuer did not return rootSignature for withdraw");
  const withdrawOut = stellar(
    "contract", "invoke", "--id", POOL_V9, "--network", NETWORK,
    "--source-account", "bob", "--send=yes", "--",
    "withdraw",
    "--recipient",               BOB,
    "--amount",                  bobNote.value,
    "--spend_nullifier",         fieldToHex(withdrawData.spendNullifier),
    "--new_root",                withdrawData.newRoot.replace(/^0x/, ""),
    "--root_signature",          withdrawData.rootSignature.replace(/^0x/, ""),
    "--shielded_proof",          bytesToHex(withdrawData.proof),
    "--shielded_pub_signals",    bytesToHex(withdrawData.pubSignals),
    "--compliance_nullifier",    fieldToHex(withdrawData.complianceNullifier),
    "--compliance_proof",        bytesToHex(withdrawData.complianceProof),
    "--compliance_pub_signals",  bytesToHex(withdrawData.compliancePubSignals),
  );
  log(`       ✅ Withdraw tx: ${extractTx(withdrawOut)}`);

  const finalAddrs = loadAddresses();
  finalAddrs.txs.corridor_deposit_v9  = extractTx(depositOut)  ?? "";
  finalAddrs.txs.corridor_transfer_v9 = extractTx(transferOut) ?? "";
  finalAddrs.txs.corridor_withdraw_v9 = extractTx(withdrawOut) ?? "";
  saveAddresses(finalAddrs);

  log("\n╔═══════════════════════════════════════════════════════════╗");
  log("║  Pool v9 deployed; corridor verified with signed roots ✅  ║");
  log("╚═══════════════════════════════════════════════════════════╝");
}

main().catch(err => {
  console.error("\n❌  deploy-pool-v9 failed:", err.message ?? err);
  process.exit(1);
});
