#!/usr/bin/env node
/**
 * deploy-pool-v11.mjs
 *
 * Deploys shielded_pool v11. Same Tier-C on-chain KYC gate as v10, but the gate
 * now also enforces the attestation's *claim* (verified/tier/country), not just
 * its existence. The pool stores a required attestation value per corridor edge
 * and rejects any attestation whose value does not match byte-for-byte:
 *   - deposit  (sending edge)   → value must equal kyc_value_send    (e.g. country 840)
 *   - withdraw (receiving edge) → value must equal kyc_value_receive (e.g. country 566)
 *
 * What changed vs v10:
 *   - Constructor takes 2 extra args: --kyc_value_send, --kyc_value_receive
 *     (sourced from the issuer's /api/kyc/config so issuer + pool agree exactly).
 *   - New gate error KycAttestationValueMismatch (#14).
 *
 * Prereqs (in order):
 *   1. AttestProtocol deployed + KYC schema registered  (scripts/deploy-attest-protocol.mjs)
 *   2. mock-issuer running                               (npm start in mock-issuer)
 *   3. Issuer BLS key registered for the authority       (scripts/register-kyc-bls.mjs)
 *
 * Usage:
 *   node scripts/deploy-pool-v11.mjs            # deploy only
 *   RUN_SELFTEST=1 node scripts/deploy-pool-v11.mjs   # deploy + full corridor self-test
 *
 * Revocation demo (independent, no SRT funding needed): scripts/revoke-kyc.mjs
 *
 * Rollback: v10 remains deployed; testnet-addresses.json keeps the previous pool
 * id under contracts.shielded_pool_v10_prev. Point the frontend back to it to revert.
 */

import { spawnSync, execSync } from "node:child_process";
import fs   from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const ROOT       = path.resolve(__dirname, "..");
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

/** Enroll a wallet (issue a delegated KYC attestation) and return its UID hex. */
async function enroll(address, side) {
  const r = await api("/api/kyc/enroll", { address, side });
  if (!r.attestationUid) throw new Error(`enroll for ${address} returned no attestationUid`);
  log(`       KYC attestation (${side}): ${r.attestationUid}${r.txHash ? `  tx ${r.txHash}` : ""}`);
  return r.attestationUid.replace(/^0x/, "");
}

/**
 * Poll the issuer's KYC status until the attestation is verifiably readable
 * on-chain (get_attestation succeeds). This avoids racing the deposit/withdraw
 * simulation against an RPC ledger that hasn't yet reflected the enroll tx.
 */
async function waitForAttestation(address, maxSecs = 120) {
  const deadline = Date.now() + maxSecs * 1000;
  while (Date.now() < deadline) {
    try {
      const st = await apiGet(`/api/kyc/status?address=${encodeURIComponent(address)}`);
      if (st.verified && st.onChain) return;
    } catch {}
    await new Promise(r => setTimeout(r, 4000));
  }
  throw new Error(`KYC attestation for ${address} not visible on-chain after ${maxSecs}s`);
}

async function main() {
  log("╔═══════════════════════════════════════════════════════════╗");
  log("║  ShadowWire — Deploy Pool v11 (KYC claim enforced on-chain) ║");
  log("╚═══════════════════════════════════════════════════════════╝");

  section("Step 0 — Confirm proving server + read operator + KYC config");
  await waitForIssuer();
  const { operatorPubkey, corridorId } = await apiGet("/api/operator-pubkey");
  if (!operatorPubkey || operatorPubkey.length !== 64) {
    throw new Error(`Bad operator pubkey from issuer: ${operatorPubkey}`);
  }
  if (String(corridorId) !== String(CORRIDOR_ID)) {
    throw new Error(
      `corridor_id mismatch: issuer signs for ${corridorId} but deploy uses ${CORRIDOR_ID}.`
    );
  }
  const kyc = await apiGet("/api/kyc/config");
  if (!kyc.configured) {
    throw new Error("Issuer reports AttestProtocol not configured (run deploy-attest-protocol.mjs).");
  }
  const ATTEST_PROTOCOL = kyc.protocol;
  const KYC_AUTHORITY   = kyc.authority;
  const KYC_SCHEMA      = String(kyc.schemaUid).replace(/^0x/, "");
  const KYC_VALUE_SEND    = kyc.expectedValueSend;
  const KYC_VALUE_RECEIVE = kyc.expectedValueReceive;
  if (!ATTEST_PROTOCOL || !KYC_AUTHORITY || KYC_SCHEMA.length !== 64) {
    throw new Error(`Bad KYC config from issuer: ${JSON.stringify(kyc)}`);
  }
  if (!KYC_VALUE_SEND || !KYC_VALUE_RECEIVE) {
    throw new Error(
      `Issuer /api/kyc/config did not return expectedValueSend/Receive — ` +
      `restart the mock-issuer with the updated build.`
    );
  }
  log(`  Operator pubkey:  ${operatorPubkey}`);
  log(`  AttestProtocol:   ${ATTEST_PROTOCOL}`);
  log(`  KYC authority:    ${KYC_AUTHORITY}`);
  log(`  KYC schema UID:   ${KYC_SCHEMA}`);
  log(`  KYC value (send):    ${KYC_VALUE_SEND}`);
  log(`  KYC value (receive): ${KYC_VALUE_RECEIVE}`);

  section("Step 1 — Build shielded_pool WASM");
  const envPath = `${ROOT}/.tools:${process.env.HOME}/.cargo/bin:${process.env.PATH}`;
  execSync(
    `stellar contract build --manifest-path "${ROOT}/contracts/shielded_pool/Cargo.toml" --package shielded_pool --optimize`,
    { stdio: "inherit", env: { ...process.env, PATH: envPath, CARGO_TARGET_DIR: `${ROOT}/contracts/target` } }
  );
  log("  WASM built ✓");

  section("Step 2 — Deploy pool v11 (reusing verifiers + registry + AttestProtocol)");
  const addrs = loadAddresses();
  const COMPLIANCE_V = addrs.contracts.compliance_verifier;
  const SHIELDED_V   = addrs.contracts.shielded_transfer_verifier;
  const REGISTRY     = addrs.contracts.compliance_registry;
  const DEPLOYER     = stellar("keys", "public-key", "deployer").trim();
  const ALICE        = stellar("keys", "public-key", "alice").trim();
  const BOB          = stellar("keys", "public-key", "bob").trim();

  if (KYC_AUTHORITY !== DEPLOYER) {
    log(`  ⚠ KYC authority (${KYC_AUTHORITY}) != deployer (${DEPLOYER}); proceeding with configured authority.`);
  }

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
    "--attest_protocol",     ATTEST_PROTOCOL,
    "--kyc_authority",       KYC_AUTHORITY,
    "--kyc_schema",          KYC_SCHEMA,
    "--kyc_value_send",      KYC_VALUE_SEND,
    "--kyc_value_receive",   KYC_VALUE_RECEIVE,
  ]);

  const POOL_V11 = extractContractId(deployOut);
  if (!POOL_V11) throw new Error("Failed to extract pool contract ID from deploy output");
  log(`  Pool v11 deployed: ${POOL_V11}`);

  const prevPool = addrs.contracts.shielded_pool;
  // Preserve earlier rollback targets; track the previous v10 separately so
  // re-running this script never clobbers the v10 fallback.
  if (!addrs.contracts.shielded_pool_v10_prev) addrs.contracts.shielded_pool_v10_prev = prevPool;
  addrs.contracts.shielded_pool_v11_prev = prevPool;
  addrs.contracts.shielded_pool = POOL_V11;
  addrs.txs = addrs.txs ?? {};
  addrs.txs.pool_v11_deploy = extractTx(deployOut) ?? "";
  saveAddresses(addrs);
  log(`  testnet-addresses.json updated — active pool: ${POOL_V11}`);

  if (!RUN_SELFTEST) {
    section("Step 3 — Corridor self-test skipped (set RUN_SELFTEST=1)");
    log(`  ✅ Pool v11 deployed: on-chain KYC gate now enforces the claim.`);
    return;
  }

  section("Step 3 — Full corridor self-test (KYC-gated)");
  log("  Waiting 20s for pool deployment to propagate on Soroban RPC...");
  await new Promise(r => setTimeout(r, 20000));

  // 3a: enroll both edges (issue real on-chain KYC attestations)
  log("\n  [3a] Issue on-chain KYC attestations");
  const aliceUid = await enroll(ALICE, "send");
  const bobUid   = await enroll(BOB, "receive");
  log("       Waiting for attestations to become readable on-chain…");
  await waitForAttestation(ALICE);
  await waitForAttestation(BOB);
  log("       Attestations confirmed on-chain ✓");

  // 3b: deposit (KYC-gated)
  log("\n  [3b] Alice deposits");
  const depositNote = await api("/api/prove/deposit", {
    ownerField: "1", value: AMOUNT, assetId: "3", blinding: "7", secretKey: "13",
  });
  const depositComp = await api("/api/prove/compliance", { amount: AMOUNT, ownerField: "1" });
  if (!depositNote.rootSignature) throw new Error("issuer did not return rootSignature for deposit");
  const depositOut = stellar(
    "contract", "invoke", "--id", POOL_V11, "--network", NETWORK,
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
    "--kyc_attestation_uid",    aliceUid,
  );
  log(`       ✅ Deposit tx: ${extractTx(depositOut)}`);

  const expectedRoot = depositNote.newRoot.replace(/^0x/, "");
  {
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      try {
        const rootOut = stellar("contract", "invoke", "--id", POOL_V11, "--network", NETWORK,
          "--source-account", "alice", "--", "get_root");
        if (rootOut.trim().replace(/^"|"$/g, "").toLowerCase() === expectedRoot.toLowerCase()) break;
      } catch {}
      await new Promise(r => setTimeout(r, 5000));
    }
  }

  // 3c: transfer (unchanged — no KYC arg)
  log("\n  [3c] Alice → Bob private transfer");
  const SEND_AMOUNT = String(Math.floor(Number(AMOUNT) * 0.9));
  const transferData = await api("/api/prove/transfer", {
    ownerField: "1", value: AMOUNT, assetId: "3", blinding: "7", secretKey: "13",
    recipient: "2", outputValue1: SEND_AMOUNT, fee: "0", commitment: depositNote.commitment,
  });
  if (!transferData.rootSignature) throw new Error("issuer did not return rootSignature for transfer");
  const bobNote = transferData.bobNote;
  const transferOut = stellar(
    "contract", "invoke", "--id", POOL_V11, "--network", NETWORK,
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
        const rootOut = stellar("contract", "invoke", "--id", POOL_V11, "--network", NETWORK,
          "--source-account", "bob", "--", "get_root");
        if (rootOut.trim().replace(/^"|"$/g, "").toLowerCase() === expectedTransferRoot.toLowerCase()) break;
      } catch {}
      await new Promise(r => setTimeout(r, 5000));
    }
  }

  // 3d: withdraw (KYC-gated)
  log("\n  [3d] Bob withdraws");
  await new Promise(r => setTimeout(r, 6000));
  const withdrawData = await api("/api/prove/withdraw", {
    ownerField: bobNote.owner, value: bobNote.value, assetId: bobNote.assetId,
    blinding: bobNote.blinding, secretKey: bobNote.secretKey,
    recipient: bobNote.owner, commitment: bobNote.commitment,
  });
  if (!withdrawData.rootSignature) throw new Error("issuer did not return rootSignature for withdraw");
  const withdrawOut = stellar(
    "contract", "invoke", "--id", POOL_V11, "--network", NETWORK,
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
    "--kyc_attestation_uid",     bobUid,
  );
  log(`       ✅ Withdraw tx: ${extractTx(withdrawOut)}`);

  const finalAddrs = loadAddresses();
  finalAddrs.txs.corridor_deposit_v11  = extractTx(depositOut)  ?? "";
  finalAddrs.txs.corridor_transfer_v11 = extractTx(transferOut) ?? "";
  finalAddrs.txs.corridor_withdraw_v11 = extractTx(withdrawOut) ?? "";
  finalAddrs.txs.kyc_attest_alice = aliceUid;
  finalAddrs.txs.kyc_attest_bob   = bobUid;
  saveAddresses(finalAddrs);

  log("\n╔═══════════════════════════════════════════════════════════╗");
  log("║  Pool v11 deployed; KYC-gated corridor verified ✅         ║");
  log("╚═══════════════════════════════════════════════════════════╝");
}

main().catch(err => {
  console.error("\n❌  deploy-pool-v11 failed:", err.message ?? err);
  if (err.output) console.error(err.output);
  process.exit(1);
});
