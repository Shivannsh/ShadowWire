#!/usr/bin/env node
/**
 * ShadowWire — full corridor e2e (CLI, headless)
 *
 * Runs the complete private remittance corridor on Stellar testnet:
 *   1. Alice deposits SRT into the shielded pool (compliance proof + note commitment)
 *   2. Alice sends privately to Bob (shielded transfer — no amount on-chain)
 *   3. Bob withdraws from the pool (shielded spend proof + off-ramp compliance proof)
 *
 * Requires:
 *   - mock-issuer proving server running on :3001 (npm run issuer)
 *   - Stellar CLI with 'alice', 'bob', 'deployer' key-pairs funded on testnet
 *   - Pool v6 deployed (with compliance-at-withdraw)
 *
 * Usage:
 *   node scripts/corridor-e2e.mjs
 *   # or with a custom amount:
 *   AMOUNT=500 node scripts/corridor-e2e.mjs
 */

import { execSync, spawnSync } from "node:child_process";
import fs            from "node:fs";
import path          from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, "..");
const ADDRS_FILE = path.join(ROOT, "testnet-addresses.json");
const ISSUER_URL = process.env.ISSUER_URL ?? "http://localhost:3001";
const NETWORK    = process.env.NETWORK   ?? "testnet";
const AMOUNT     = process.env.AMOUNT    ?? "500";   // raw integer (same unit in proof + contract)

// ── Helpers ────────────────────────────────────────────────────────────────

function addresses() {
  return JSON.parse(fs.readFileSync(ADDRS_FILE, "utf8"));
}

async function api(endpoint, body) {
  const url = `${ISSUER_URL}${endpoint}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`POST ${endpoint} failed (${res.status}): ${text}`);
  }
  return JSON.parse(text);
}

function stellar(...args) {
  const stellarBin = "stellar";
  console.log(`  $ ${[stellarBin, ...args].join(" ")}`);
  const envPath = `${ROOT}/.tools:${process.env.HOME}/.cargo/bin:${process.env.PATH}`;
  const result = spawnSync(stellarBin, args, {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    env: { ...process.env, PATH: envPath },
  });
  // Print CLI output (stellar writes progress + URLs to stderr)
  if (result.stderr) process.stdout.write(result.stderr);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.status !== 0) {
    throw new Error(`stellar failed (exit ${result.status}): ${result.stderr ?? result.stdout}`);
  }
  // Return combined so extractTx can find the URL in either stream
  return (result.stdout ?? "") + (result.stderr ?? "");
}

function extractTx(output) {
  // Strip ANSI escape codes (stellar CLI colours the URLs)
  const cleaned = output.replace(/\x1b\[[0-9;]*m/g, "");
  const match = cleaned.match(/testnet\/tx\/([a-f0-9]{64})/i);
  return match ? match[1] : null;
}

/** Convert any field element (0x-hex, raw hex, or decimal) to a 64-char hex string (no 0x prefix) */
function fieldToHex(field) {
  const s = String(field).trim();
  const stripped = (s.startsWith("0x") || s.startsWith("0X")) ? s.slice(2) : s;
  if (/[a-fA-F]/.test(stripped)) return stripped.toLowerCase().padStart(64, "0");
  return BigInt(s).toString(16).padStart(64, "0");
}

/** Convert a bytes-array from the proving server to a Soroban CLI hex string */
function bytesToHex(arr) {
  return arr.map(b => b.toString(16).padStart(2, "0")).join("");
}

/** Wait for mock-issuer to be reachable (up to 30s) */
async function waitForIssuer() {
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch(`${ISSUER_URL}/api/attestation/status`);
      if (r.ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error(`Proving server at ${ISSUER_URL} not reachable after 30s`);
}

// ── Step 0: Sanity check ───────────────────────────────────────────────────

async function checkIssuer() {
  try {
    const res = await fetch(`${ISSUER_URL}/api/attestation/status`);
    if (!res.ok) throw new Error(res.statusText);
    console.log("  Proving server: ✓");
  } catch {
    throw new Error(
      `Proving server not reachable at ${ISSUER_URL}.\n` +
      `Start it first: cd mock-issuer && npm start`
    );
  }
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log("╔═══════════════════════════════════════════════════════════╗");
  console.log("║  ShadowWire — full corridor e2e (deposit→transfer→withdraw)  ║");
  console.log("╚═══════════════════════════════════════════════════════════╝");
  console.log();

  const addrs  = addresses();
  const POOL   = addrs.contracts.shielded_pool;
  const ALICE  = stellar("keys", "public-key", "alice").trim();
  const BOB    = stellar("keys", "public-key", "bob").trim();

  console.log(`Pool:   ${POOL}`);
  console.log(`Alice:  ${ALICE}`);
  console.log(`Bob:    ${BOB}`);
  console.log(`Amount: ${AMOUNT} (raw units, same in proof + contract)`);
  console.log();

  // ─ Pre-flight ─────────────────────────────────────────────────────────────
  console.log("── [0] Pre-flight ──────────────────────────────────────────");
  await checkIssuer();
  console.log("  Funding alice / bob if needed...");
  try {
    execSync(`bash "${ROOT}/scripts/fund-accounts.sh"`, {
      stdio: "pipe",
      env: { ...process.env, PATH: `${ROOT}/.tools:${process.env.HOME}/.cargo/bin:${process.env.PATH}` },
    });
    console.log("  Accounts funded: ✓");
  } catch (e) {
    console.log("  fund-accounts.sh skipped (likely already funded):", e.message.slice(0, 80));
  }
  console.log();

  // ─ Step 1: Deposit ────────────────────────────────────────────────────────
  console.log("── [1] Deposit (Alice → pool, compliance proof) ────────────");

  // 1a. Compute fresh note + pool root via proving server
  const depositNoteData = await api("/api/prove/deposit", {
    ownerField: "1",   // simplified ownerField for CLI demo (matches DEMO_KYC_BASE.depositor_pubkey)
    value:      AMOUNT,
    assetId:    "3",
    blinding:   "7",
    secretKey:  "13",
  });
  console.log(`  Note commitment: 0x${depositNoteData.commitment}`);
  console.log(`  New pool root:   0x${depositNoteData.newRoot}`);

  // 1b. Compliance proof for on-ramp
  const depositCompliance = await api("/api/prove/compliance", {
    amount:     AMOUNT,
    ownerField: "1",
  });
  const complianceNullifierHex = fieldToHex(depositCompliance.complianceNullifier);
  console.log(`  Compliance nullifier: 0x${complianceNullifierHex}`);

  const commitmentHex       = depositNoteData.commitment.replace(/^0x/, "");
  const newRootAfterDeposit = depositNoteData.newRoot.replace(/^0x/, "");
  const compProofHex        = bytesToHex(depositCompliance.proof);
  const compPubHex          = bytesToHex(depositCompliance.pubSignals);

  console.log("  Submitting deposit tx...");
  const depositOut = stellar(
    "contract", "invoke",
    "--id", POOL,
    "--network", NETWORK,
    "--source-account", "alice",
    "--send=yes",
    "--",
    "deposit",
    "--depositor",               ALICE,
    "--amount",                  AMOUNT,
    "--note_commitment",         commitmentHex,
    "--new_root",                newRootAfterDeposit,
    "--compliance_nullifier",    complianceNullifierHex,
    "--compliance_proof",        compProofHex,
    "--compliance_pub_signals",  compPubHex,
  );
  const depositTx = extractTx(depositOut);
  console.log(`  ✅ Deposit tx: ${depositTx}`);
  console.log(`     https://stellar.expert/explorer/testnet/tx/${depositTx}`);
  console.log();

  // ─ Step 2: Shielded Transfer ───────────────────────────────────────────────
  console.log("── [2] Shielded Transfer (Alice → Bob, amount hidden) ───────");

  // Brief pause after deposit tx to let chain state propagate before the
  // issuer queries the pool root in assertRootMatchesChain
  console.log("  Waiting 5s for chain state to propagate...");
  await new Promise(r => setTimeout(r, 5000));
  await waitForIssuer();

  const SEND_AMOUNT   = String(Math.floor(Number(AMOUNT) * 0.9));  // 90% to Bob
  const transferData  = await api("/api/prove/transfer", {
    ownerField:   "1",
    value:        AMOUNT,
    assetId:      "3",
    blinding:     "7",
    secretKey:    "13",
    recipient:    "2",   // Bob's ownerField
    outputValue1: SEND_AMOUNT,
    fee:          "0",
  });

  const spendNullifier  = fieldToHex(transferData.spendNullifier);
  const newCommitment1  = fieldToHex(transferData.newCommitment1);
  const newCommitment2  = fieldToHex(transferData.newCommitment2);
  const newRootAfterTx  = transferData.newRoot.replace(/^0x/, "");
  const shProofHex      = bytesToHex(transferData.proof);
  const shPubHex        = bytesToHex(transferData.pubSignals);

  console.log(`  Send amount:       ${SEND_AMOUNT} (${AMOUNT} - 0 fee; amount NEVER in tx args)`);
  console.log(`  Spend nullifier:   0x${spendNullifier}`);
  console.log(`  Bob's commitment:  0x${newCommitment1}`);

  // Store Bob's note details for the withdraw step
  const bobNote = transferData.bobNote;
  console.log(`  Bob's note value:  ${bobNote.value}`);

  console.log("  Submitting transfer tx...");
  const transferOut = stellar(
    "contract", "invoke",
    "--id", POOL,
    "--network", NETWORK,
    "--source-account", "alice",
    "--send=yes",
    "--",
    "transfer",
    "--sender",            ALICE,
    "--spend_nullifier",   spendNullifier,
    "--new_commitment_1",  newCommitment1,
    "--new_commitment_2",  newCommitment2,
    "--new_root",          newRootAfterTx,
    "--shielded_proof",    shProofHex,
    "--shielded_pub_signals", shPubHex,
  );
  const transferTx = extractTx(transferOut);
  console.log(`  ✅ Transfer tx: ${transferTx}`);
  console.log(`     https://stellar.expert/explorer/testnet/tx/${transferTx}`);
  console.log(`  ↳  Inspect this tx — no amount field anywhere.  That is the whole point.`);
  console.log();

  // ─ Step 3: Withdraw ────────────────────────────────────────────────────────
  console.log("── [3] Withdraw (Bob spends note + compliance proof) ────────");

  console.log("  Waiting 5s for transfer state to propagate...");
  await new Promise(r => setTimeout(r, 5000));
  await waitForIssuer();

  const withdrawData = await api("/api/prove/withdraw", {
    ownerField:  bobNote.owner,       // Bob's ownerField (="2" for CLI demo)
    value:       bobNote.value,
    assetId:     bobNote.assetId,
    blinding:    bobNote.blinding,
    secretKey:   bobNote.secretKey,
    recipient:   bobNote.owner,
    // Pass the exact on-chain commitment so the server doesn't have to recompute it.
    // Output commitment formula differs from input commitment formula in the circuit,
    // so recomputation always produces the wrong leaf index (target_idx = -1).
    commitment:  bobNote.commitment,
  });

  const wSpendNullifier = fieldToHex(withdrawData.spendNullifier);
  const wNewRoot        = withdrawData.newRoot.replace(/^0x/, "");
  const wShProofHex     = bytesToHex(withdrawData.proof);
  const wShPubHex       = bytesToHex(withdrawData.pubSignals);
  const wCompNullifier  = fieldToHex(withdrawData.complianceNullifier);
  const wCompProofHex   = bytesToHex(withdrawData.complianceProof);
  const wCompPubHex     = bytesToHex(withdrawData.compliancePubSignals);

  console.log(`  Withdrawal amount:        ${bobNote.value}`);
  console.log(`  Spend nullifier:          0x${wSpendNullifier}`);
  console.log(`  Off-ramp compliance null: 0x${wCompNullifier}`);
  console.log("  Submitting withdraw tx (2 Groth16 proofs verified on-chain)...");

  const withdrawOut = stellar(
    "contract", "invoke",
    "--id", POOL,
    "--network", NETWORK,
    "--source-account", "bob",
    "--send=yes",
    "--",
    "withdraw",
    "--recipient",               BOB,
    "--amount",                  bobNote.value,
    "--spend_nullifier",         wSpendNullifier,
    "--new_root",                wNewRoot,
    "--shielded_proof",          wShProofHex,
    "--shielded_pub_signals",    wShPubHex,
    "--compliance_nullifier",    wCompNullifier,
    "--compliance_proof",        wCompProofHex,
    "--compliance_pub_signals",  wCompPubHex,
  );
  const withdrawTx = extractTx(withdrawOut);
  console.log(`  ✅ Withdraw tx: ${withdrawTx}`);
  console.log(`     https://stellar.expert/explorer/testnet/tx/${withdrawTx}`);
  console.log();

  // ─ Record tx hashes ────────────────────────────────────────────────────────
  const addrData = addresses();
  addrData.txs = addrData.txs || {};
  addrData.txs.corridor_deposit_v8  = depositTx  ?? "";
  addrData.txs.corridor_transfer_v8 = transferTx ?? "";
  addrData.txs.corridor_withdraw_v8 = withdrawTx ?? "";
  fs.writeFileSync(ADDRS_FILE, JSON.stringify(addrData, null, 2));
  fs.writeFileSync(
    path.join(ROOT, "frontend/public/testnet-addresses.json"),
    JSON.stringify(addrData, null, 2)
  );
  console.log("Updated testnet-addresses.json with corridor tx hashes.");
  console.log();

  // ─ Summary ────────────────────────────────────────────────────────────────
  console.log("╔═══════════════════════════════════════════════════════════╗");
  console.log("║  Full corridor complete — all 3 steps on pool v8           ║");
  console.log("╠═══════════════════════════════════════════════════════════╣");
  console.log(`║  Deposit  (compliance + note):  ${depositTx?.slice(0, 20)}...  ║`);
  console.log(`║  Transfer (amount hidden):       ${transferTx?.slice(0, 20)}...  ║`);
  console.log(`║  Withdraw (spend + compliance):  ${withdrawTx?.slice(0, 20)}...  ║`);
  console.log("╠═══════════════════════════════════════════════════════════╣");
  console.log("║  Privacy check: open the Transfer tx in the explorer.      ║");
  console.log("║  You will see: nullifier, two commitments.  No amount.     ║");
  console.log("╚═══════════════════════════════════════════════════════════╝");
}

main().catch(err => {
  console.error("Corridor e2e failed:", err.message ?? err);
  process.exit(1);
});
