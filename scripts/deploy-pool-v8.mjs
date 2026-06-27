#!/usr/bin/env node
/**
 * deploy-pool-v8.mjs
 *
 * Deploys a fresh shielded_pool (v8) reusing all existing verifier contracts,
 * then immediately runs the full corridor (deposit → transfer → withdraw) to
 * prove the fix is correct end-to-end.
 *
 * Why v8?  Pool v7's stored Merkle root is inconsistent with its stored leaves
 * because newRoot was computed from hash_util commitment values while the
 * on-chain leaves came from snarkjs public signals.  That mismatch permanently
 * breaks any withdraw proof on v7.  v8 uses the corrected code (newRoot always
 * computed from result.publicSignals) so root and leaves stay consistent.
 *
 * Usage:
 *   node scripts/deploy-pool-v8.mjs
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

// The corridor self-test (Step 3) deposits/withdraws with the deployer-keystore
// alice/bob accounts. Those accounts are friendbot-funded (XLM only) and are NOT
// KYC'd/funded with the anchor's SRT, so the self-test can only run when they
// actually hold the pool asset. It is therefore opt-in; the production deploy
// (Steps 1–2) always runs and is what the frontend uses.
const RUN_SELFTEST = process.env.RUN_SELFTEST === "1";

// All-zero 32-byte initial Merkle root (empty tree)
const INITIAL_ROOT = "0".repeat(64);

function log(msg) { console.log(msg); }
function section(title) {
  console.log();
  console.log(`${"─".repeat(60)}`);
  console.log(`  ${title}`);
  console.log(`${"─".repeat(60)}`);
}

function loadAddresses() {
  return JSON.parse(fs.readFileSync(ADDRS_FILE, "utf8"));
}

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
  if (result.status !== 0) {
    throw new Error(`stellar failed (exit ${result.status})`);
  }
  return (result.stdout ?? "") + (result.stderr ?? "");
}

function extractContractId(output) {
  // Strip ANSI colours, match a Soroban contract ID (starts with C, 56 chars)
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

function fieldToHex(field) {
  const s = String(field).trim();
  const stripped = (s.startsWith("0x") || s.startsWith("0X")) ? s.slice(2) : s;
  // If it contains any a-f letter it is already hex (no conversion needed)
  if (/[a-fA-F]/.test(stripped)) return stripped.toLowerCase().padStart(64, "0");
  // Pure digits — decimal field element, convert via BigInt
  return BigInt(s).toString(16).padStart(64, "0");
}

function bytesToHex(arr) {
  return arr.map(b => b.toString(16).padStart(2, "0")).join("");
}

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

// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  log("╔═══════════════════════════════════════════════════════════╗");
  log("║  ShadowWire — Deploy Pool v8 + Full Corridor              ║");
  log("╚═══════════════════════════════════════════════════════════╝");

  // ── Step 0: confirm issuer is running ─────────────────────────────────────
  section("Step 0 — Confirm proving server is up");
  await waitForIssuer();

  // ── Step 1: build shielded_pool WASM ──────────────────────────────────────
  section("Step 1 — Build shielded_pool WASM");
  const envPath = `${ROOT}/.tools:${process.env.HOME}/.cargo/bin:${process.env.PATH}`;
  log("  cargo build --release...");
  execSync(
    `stellar contract build --manifest-path "${ROOT}/contracts/shielded_pool/Cargo.toml" --package shielded_pool --optimize`,
    { stdio: "inherit", env: { ...process.env, PATH: envPath, CARGO_TARGET_DIR: `${ROOT}/contracts/target` } }
  );
  log("  WASM built ✓");

  // ── Step 2: deploy fresh pool instance ────────────────────────────────────
  section("Step 2 — Deploy pool v8 (reusing existing verifiers + registry)");

  const addrs = loadAddresses();
  const COMPLIANCE_V = addrs.contracts.compliance_verifier;
  const SHIELDED_V   = addrs.contracts.shielded_transfer_verifier;
  const REGISTRY     = addrs.contracts.compliance_registry;
  const DEPLOYER     = stellar("keys", "public-key", "deployer").trim();
  const ALICE        = stellar("keys", "public-key", "alice").trim();
  const BOB          = stellar("keys", "public-key", "bob").trim();

  // Pool asset = the Stellar Asset Contract (SAC) of the anchor's SRT classic asset.
  // Derived from testnet-addresses.json so it always matches what SEP-24 deposits/
  // off-ramps and the frontend balance checks use. (A previous build hardcoded the
  // native XLM SAC here, so the pool moved XLM instead of SRT and off-ramp recipients
  // never received any SRT.)
  const assetCode   = addrs.anchor?.asset_code;
  const assetIssuer = addrs.anchor?.asset_issuer;
  if (!assetCode || !assetIssuer) {
    throw new Error("anchor.asset_code / anchor.asset_issuer missing in testnet-addresses.json");
  }
  const ASSET = extractContractId(
    stellar("contract", "id", "asset", "--asset", `${assetCode}:${assetIssuer}`, "--network", NETWORK)
  );
  if (!ASSET) {
    throw new Error(`Could not derive SAC contract id for ${assetCode}:${assetIssuer}`);
  }

  log(`  Pool asset (SRT SAC): ${ASSET}  (${assetCode}:${assetIssuer.slice(0, 8)}...)`);
  log(`  Compliance verifier:  ${COMPLIANCE_V}`);
  log(`  Shielded verifier:    ${SHIELDED_V}`);
  log(`  Registry:             ${REGISTRY}`);

  const WASM = `${ROOT}/contracts/target/wasm32v1-none/release/shielded_pool.wasm`;
  const deployOut = stellar(
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
    "--corridor_id",         "1",
    "--initial_root",        INITIAL_ROOT,
  );

  const POOL_V8 = extractContractId(deployOut);
  if (!POOL_V8) throw new Error("Failed to extract pool contract ID from deploy output");
  log(`  Pool v8 deployed: ${POOL_V8}`);

  // Archive old pool, set new one as active
  const prevPool = addrs.contracts.shielded_pool;
  addrs.contracts.shielded_pool_v7_prev = prevPool;
  addrs.contracts.shielded_pool = POOL_V8;
  addrs.txs = addrs.txs ?? {};
  const deployTx = extractTx(deployOut);
  addrs.txs.pool_v8_deploy = deployTx ?? "";
  saveAddresses(addrs);
  log(`  testnet-addresses.json updated — active pool: ${POOL_V8}`);

  // ── Step 3: Run the full corridor (opt-in self-test) ──────────────────────
  if (!RUN_SELFTEST) {
    section("Step 3 — Corridor self-test skipped");
    log("  The deployer-keystore alice/bob accounts are friendbot-funded (XLM only)");
    log(`  and do not hold ${assetCode}, so the on-chain corridor self-test cannot run.`);
    log("  Verify end-to-end through the frontend instead: a SEP-24 deposit funds Alice");
    log("  with real SRT, which then flows deposit → transfer → withdraw → SEP-24 off-ramp.");
    log("  (Set RUN_SELFTEST=1 only if the keystore alice/bob accounts hold SRT.)");
    log("");
    log(`  ✅ Pool v8 deployed with asset ${ASSET}; testnet-addresses.json updated.`);
    return;
  }

  section("Step 3 — Full corridor: deposit → transfer → withdraw");
  log(`  Pool:   ${POOL_V8}`);
  log(`  Alice:  ${ALICE}`);
  log(`  Bob:    ${BOB}`);
  log(`  Amount: ${AMOUNT} (raw units = raw Field element = raw i128 in contract)`);

  // Wait for chain state to settle after deploy
  log("  Waiting 20s for pool deployment to propagate on Soroban RPC...");
  await new Promise(r => setTimeout(r, 20000));

  // ─ 3a: Deposit ─────────────────────────────────────────────────────────
  log("");
  log("  [3a] Alice deposits into pool (compliance + note commitment)");

  const depositNote = await api("/api/prove/deposit", {
    ownerField: "1",
    value:      AMOUNT,
    assetId:    "3",
    blinding:   "7",
    secretKey:  "13",
  });
  log(`       Note commitment: 0x${depositNote.commitment}`);
  log(`       New pool root:   0x${depositNote.newRoot}`);

  const depositComp = await api("/api/prove/compliance", {
    amount:     AMOUNT,
    ownerField: "1",
  });
  const compNullifierHex = fieldToHex(depositComp.complianceNullifier);
  log(`       Compliance nullifier: 0x${compNullifierHex}`);

  const depositOut2 = stellar(
    "contract", "invoke",
    "--id",             POOL_V8,
    "--network",        NETWORK,
    "--source-account", "alice",
    "--send=yes",
    "--",
    "deposit",
    "--depositor",              ALICE,
    "--amount",                 AMOUNT,
    "--note_commitment",        depositNote.commitment.replace(/^0x/, ""),
    "--new_root",               depositNote.newRoot.replace(/^0x/, ""),
    "--compliance_nullifier",   compNullifierHex,
    "--compliance_proof",       bytesToHex(depositComp.proof),
    "--compliance_pub_signals", bytesToHex(depositComp.pubSignals),
  );
  const depositTx2 = extractTx(depositOut2);
  log(`       ✅ Deposit tx: ${depositTx2}`);
  log(`          https://stellar.expert/explorer/testnet/tx/${depositTx2}`);

  // Poll the on-chain root until it shows the post-deposit value.
  // The Soroban RPC may lag: instance storage (root) and persistent storage
  // (commitment array) propagate independently. We must wait for BOTH before
  // generating the transfer proof or the assert_pool_root_matches check will fail.
  const expectedRoot = depositNote.newRoot.replace(/^0x/, "").replace(/^0x/, "");
  log(`       Waiting for on-chain root to match deposit root (${expectedRoot.slice(0, 8)}...)...`);
  {
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      try {
        const rootOut = stellar("contract", "invoke", "--id", POOL_V8, "--network", NETWORK,
          "--source-account", "alice", "--", "get_root");
        // stellar prints the result as a quoted hex string, e.g. "27b651..."
        const rootHex = rootOut.trim().replace(/^"|"$/g, "").toLowerCase();
        if (rootHex === expectedRoot.toLowerCase()) {
          log(`       On-chain root confirmed: ${rootHex.slice(0, 16)}...  ✓`);
          break;
        }
        log(`       On-chain root: ${rootHex.slice(0, 16)}... (waiting for ${expectedRoot.slice(0, 8)}...)`);
      } catch (e) {
        log(`       (get_root poll failed: ${e.message.slice(0, 60)})`);
      }
      await new Promise(r => setTimeout(r, 5000));
    }
  }

  // ─ 3b: Shielded Transfer ────────────────────────────────────────────────
  log("");
  log("  [3b] Alice sends privately to Bob (amount NEVER in tx)");

  const SEND_AMOUNT = String(Math.floor(Number(AMOUNT) * 0.9));
  const transferData = await api("/api/prove/transfer", {
    ownerField:   "1",
    value:        AMOUNT,
    assetId:      "3",
    blinding:     "7",
    secretKey:    "13",
    recipient:    "2",
    outputValue1: SEND_AMOUNT,
    fee:          "0",
    // Pass the exact on-chain commitment from the deposit response so the server
    // can skip recomputing it (avoids any hash_util vs circuit formula divergence).
    commitment:   depositNote.commitment,
  });
  const bobNote = transferData.bobNote;
  log(`       Send amount:      ${SEND_AMOUNT} (90% to Bob — hidden on-chain)`);
  log(`       Spend nullifier:  0x${fieldToHex(transferData.spendNullifier)}`);
  log(`       Bob commitment:   0x${fieldToHex(transferData.newCommitment1)}`);
  log(`       newRoot:          0x${transferData.newRoot}`);

  const transferOut2 = stellar(
    "contract", "invoke",
    "--id",             POOL_V8,
    "--network",        NETWORK,
    "--source-account", "alice",
    "--send=yes",
    "--",
    "transfer",
    "--sender",               ALICE,
    "--spend_nullifier",      fieldToHex(transferData.spendNullifier),
    "--new_commitment_1",     fieldToHex(transferData.newCommitment1),
    "--new_commitment_2",     fieldToHex(transferData.newCommitment2),
    "--new_root",             transferData.newRoot.replace(/^0x/, ""),
    "--shielded_proof",       bytesToHex(transferData.proof),
    "--shielded_pub_signals", bytesToHex(transferData.pubSignals),
  );
  const transferTx2 = extractTx(transferOut2);
  log(`       ✅ Transfer tx: ${transferTx2}`);
  log(`          https://stellar.expert/explorer/testnet/tx/${transferTx2}`);
  log(`          ↳ Inspect it — you will see: nullifier + 2 commitments. No amount.`);

  // Wait for post-transfer root to be visible on-chain before generating withdraw proof
  const expectedTransferRoot = (transferData.newRoot ?? "").replace(/^0x/, "").replace(/^0x/, "");
  log(`       Waiting for post-transfer root (${expectedTransferRoot.slice(0, 8)}...) to confirm...`);
  {
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      try {
        const rootOut = stellar("contract", "invoke", "--id", POOL_V8, "--network", NETWORK,
          "--source-account", "bob", "--", "get_root");
        const rootHex = rootOut.trim().replace(/^"|"$/g, "").toLowerCase();
        if (rootHex === expectedTransferRoot.toLowerCase()) {
          log(`       Post-transfer root confirmed: ${rootHex.slice(0, 16)}...  ✓`);
          break;
        }
        log(`       On-chain root: ${rootHex.slice(0, 16)}... (still waiting)`);
      } catch (e) {
        log(`       (get_root poll failed: ${e.message.slice(0, 60)})`);
      }
      await new Promise(r => setTimeout(r, 5000));
    }
  }

  // ─ 3c: Withdraw ─────────────────────────────────────────────────────────
  log("");
  log("  [3c] Bob withdraws from pool (spend proof + off-ramp compliance)");
  await new Promise(r => setTimeout(r, 6000));

  const withdrawData = await api("/api/prove/withdraw", {
    ownerField:  bobNote.owner,
    value:       bobNote.value,
    assetId:     bobNote.assetId,
    blinding:    bobNote.blinding,
    secretKey:   bobNote.secretKey,
    recipient:   bobNote.owner,
    // Pass the exact on-chain commitment so server uses it directly.
    // This is the clean fix: avoids the input vs output commitment formula mismatch.
    commitment:  bobNote.commitment,
  });
  log(`       Withdraw amount:          ${bobNote.value}`);
  log(`       Spend nullifier:          0x${fieldToHex(withdrawData.spendNullifier)}`);
  log(`       Off-ramp comp nullifier:  0x${fieldToHex(withdrawData.complianceNullifier)}`);

  const withdrawOut2 = stellar(
    "contract", "invoke",
    "--id",             POOL_V8,
    "--network",        NETWORK,
    "--source-account", "bob",
    "--send=yes",
    "--",
    "withdraw",
    "--recipient",               BOB,
    "--amount",                  bobNote.value,
    "--spend_nullifier",         fieldToHex(withdrawData.spendNullifier),
    "--new_root",                withdrawData.newRoot.replace(/^0x/, ""),
    "--shielded_proof",          bytesToHex(withdrawData.proof),
    "--shielded_pub_signals",    bytesToHex(withdrawData.pubSignals),
    "--compliance_nullifier",    fieldToHex(withdrawData.complianceNullifier),
    "--compliance_proof",        bytesToHex(withdrawData.complianceProof),
    "--compliance_pub_signals",  bytesToHex(withdrawData.compliancePubSignals),
  );
  const withdrawTx2 = extractTx(withdrawOut2);
  log(`       ✅ Withdraw tx: ${withdrawTx2}`);
  log(`          https://stellar.expert/explorer/testnet/tx/${withdrawTx2}`);

  // ── Record all tx hashes ───────────────────────────────────────────────
  const finalAddrs = loadAddresses();
  finalAddrs.txs.corridor_deposit_v8  = depositTx2  ?? "";
  finalAddrs.txs.corridor_transfer_v8 = transferTx2 ?? "";
  finalAddrs.txs.corridor_withdraw_v8 = withdrawTx2 ?? "";
  saveAddresses(finalAddrs);

  // ── Summary ────────────────────────────────────────────────────────────
  log("");
  log("╔═══════════════════════════════════════════════════════════╗");
  log("║  Pool v8 deployed and full corridor verified ✅            ║");
  log("╠═══════════════════════════════════════════════════════════╣");
  log(`║  Pool v8:  ${POOL_V8}  ║`);
  log(`║  Deposit:  ${depositTx2?.slice(0, 48)}  ║`);
  log(`║  Transfer: ${transferTx2?.slice(0, 48)}  ║`);
  log(`║  Withdraw: ${withdrawTx2?.slice(0, 48)}  ║`);
  log("╠═══════════════════════════════════════════════════════════╣");
  log("║  Privacy proof: open the Transfer tx — no amount field.   ║");
  log("║  testnet-addresses.json updated. Frontend will use v8.    ║");
  log("╚═══════════════════════════════════════════════════════════╝");
}

main().catch(err => {
  console.error("\n❌  deploy-pool-v8 failed:", err.message ?? err);
  process.exit(1);
});
