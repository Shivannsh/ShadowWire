#!/usr/bin/env node
/**
 * revoke-kyc.mjs — end-to-end revocation demo for the on-chain KYC gate.
 *
 * Proves that an authority revocation actually closes the gate: a deposit that
 * passes the gate before revocation fails with KycAttestationRevoked (#12) after.
 *
 * Why this is robust (and needs no SRT funding): the pool checks the KYC gate as
 * the FIRST step of deposit(), before the token transfer. So we can run the
 * deposit in simulation mode (--send=no):
 *   - BEFORE revoke: the gate passes; the simulation only fails later (e.g. at the
 *     SAC transfer / trustline), so the output never contains contract error #12.
 *   - AFTER revoke:  the gate rejects immediately with Error(Contract, #12).
 *
 * Prereqs: AttestProtocol deployed, mock-issuer running, BLS key registered,
 *          and an active pool v11 in testnet-addresses.json.
 *
 * Usage:
 *   node scripts/revoke-kyc.mjs                 # uses alice / sending edge
 *   WALLET=bob SIDE=receive node scripts/revoke-kyc.mjs
 */

import { spawnSync } from "node:child_process";
import fs   from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const ROOT       = path.resolve(__dirname, "..");
const ADDRS_FILE = path.join(ROOT, "testnet-addresses.json");
const ISSUER_URL = process.env.ISSUER_URL ?? "http://localhost:3001";
const NETWORK    = "testnet";
const AMOUNT     = process.env.AMOUNT ?? "5";
const WALLET     = process.env.WALLET ?? "alice";
const SIDE       = process.env.SIDE ?? "send";

function log(msg = "") { console.log(msg); }
function section(title) {
  log();
  log("─".repeat(60));
  log(`  ${title}`);
  log("─".repeat(60));
}

function loadAddresses() { return JSON.parse(fs.readFileSync(ADDRS_FILE, "utf8")); }

function stellar(args, { allowFail = false } = {}) {
  const envPath = `${ROOT}/.tools:${process.env.HOME}/.cargo/bin:${process.env.PATH}`;
  const result = spawnSync("stellar", args, {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    env: { ...process.env, PATH: envPath },
  });
  const combined = (result.stdout ?? "") + (result.stderr ?? "");
  if (result.status !== 0 && !allowFail) {
    const err = new Error(`stellar failed (exit ${result.status})`);
    err.output = combined;
    throw err;
  }
  return { status: result.status, output: combined };
}

function extractTx(output) {
  const clean = output.replace(/\x1b\[[0-9;]*m/g, "");
  const m = clean.match(/testnet\/tx\/([a-f0-9]{64})/i);
  return m ? m[1] : null;
}
function fieldToHex(field) {
  const s = String(field).trim();
  const stripped = (s.startsWith("0x") || s.startsWith("0X")) ? s.slice(2) : s;
  if (/[a-fA-F]/.test(stripped)) return stripped.toLowerCase().padStart(64, "0");
  return BigInt(s).toString(16).padStart(64, "0");
}
function bytesToHex(arr) { return arr.map(b => b.toString(16).padStart(2, "0")).join(""); }
function randField() { return String(1 + Math.floor(Math.random() * 1_000_000_000)); }

async function api(endpoint, body) {
  const res = await fetch(`${ISSUER_URL}${endpoint}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
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

async function waitFor(predicate, { maxSecs = 120, everyMs = 4000, label = "condition" } = {}) {
  const deadline = Date.now() + maxSecs * 1000;
  while (Date.now() < deadline) {
    try { if (await predicate()) return; } catch {}
    await new Promise(r => setTimeout(r, everyMs));
  }
  throw new Error(`Timed out waiting for ${label} (${maxSecs}s)`);
}

/** Build a deposit invocation argv (simulation-only via --send=no). */
async function buildDepositArgs(pool, depositor, uid) {
  const owner = randField();
  const note = await api("/api/prove/deposit", {
    ownerField: owner, value: AMOUNT, assetId: "3", blinding: randField(), secretKey: randField(),
  });
  const comp = await api("/api/prove/compliance", { amount: AMOUNT, ownerField: owner });
  if (!note.rootSignature) throw new Error("issuer did not return rootSignature");
  return [
    "contract", "invoke", "--id", pool, "--network", NETWORK,
    "--source-account", WALLET, "--send=no", "--",
    "deposit",
    "--depositor",              depositor,
    "--amount",                 AMOUNT,
    "--note_commitment",        note.commitment.replace(/^0x/, ""),
    "--new_root",               note.newRoot.replace(/^0x/, ""),
    "--root_signature",         note.rootSignature.replace(/^0x/, ""),
    "--compliance_nullifier",   fieldToHex(comp.complianceNullifier),
    "--compliance_proof",       bytesToHex(comp.proof),
    "--compliance_pub_signals", bytesToHex(comp.pubSignals),
    "--kyc_attestation_uid",    uid,
  ];
}

function hasRevokedError(output) {
  // Pool error #12 = KycAttestationRevoked.
  return /Error\(Contract,\s*#12\)/.test(output) || /#12/.test(output);
}

async function main() {
  log("╔═══════════════════════════════════════════════════════════╗");
  log("║  ShadowWire — KYC revocation demo (gate closes on revoke)  ║");
  log("╚═══════════════════════════════════════════════════════════╝");

  const addrs = loadAddresses();
  const POOL  = addrs.contracts.shielded_pool;
  if (!POOL) throw new Error("No active shielded_pool in testnet-addresses.json");
  const WALLET_G = stellar(["keys", "public-key", WALLET]).output.trim();
  log(`  Pool:    ${POOL}`);
  log(`  Wallet:  ${WALLET} (${WALLET_G})  edge: ${SIDE}`);

  section("Step 1 — Ensure wallet holds a valid KYC attestation");
  let status = await apiGet(`/api/kyc/status?address=${encodeURIComponent(WALLET_G)}`);
  if (!status.configured) throw new Error("Issuer reports AttestProtocol not configured.");
  if (!(status.verified && status.onChain) || status.revoked) {
    log("  Enrolling (issuing delegated attestation)…");
    const r = await api("/api/kyc/enroll", { address: WALLET_G, side: SIDE });
    log(`  Attestation UID: ${r.attestationUid}${r.txHash ? `  tx ${r.txHash}` : ""}`);
    await waitFor(async () => {
      const s = await apiGet(`/api/kyc/status?address=${encodeURIComponent(WALLET_G)}`);
      return s.verified && s.onChain && !s.revoked;
    }, { label: "attestation visible on-chain" });
    status = await apiGet(`/api/kyc/status?address=${encodeURIComponent(WALLET_G)}`);
  }
  const UID = String(status.attestationUid).replace(/^0x/, "");
  log(`  ✓ Attested. UID: ${UID}`);

  section("Step 2 — Deposit BEFORE revocation (simulation): gate must PASS");
  const beforeArgs = await buildDepositArgs(POOL, WALLET_G, UID);
  const before = stellar(beforeArgs, { allowFail: true });
  if (hasRevokedError(before.output)) {
    throw new Error("Unexpected: gate already reports revoked before revocation.\n" + before.output);
  }
  if (before.status === 0) {
    log("  ✓ Gate passed — deposit simulation succeeded end-to-end.");
  } else {
    log("  ✓ Gate passed — simulation proceeded past the KYC gate and failed later");
    log("    (e.g. SAC transfer/trustline), NOT with #12. That is expected here.");
  }

  section("Step 3 — Authority revokes the attestation");
  const rev = await api("/api/kyc/revoke", { address: WALLET_G });
  log(`  Revoked UID ${rev.attestationUid}${rev.txHash ? `  tx ${rev.txHash}` : ""}`);
  log("  Waiting for revocation to be readable on-chain…");
  await waitFor(async () => {
    const s = await apiGet(`/api/kyc/status?address=${encodeURIComponent(WALLET_G)}`);
    return s.revoked === true;
  }, { label: "revocation visible on-chain" });
  log("  ✓ Revocation confirmed on-chain.");

  section("Step 4 — Deposit AFTER revocation (simulation): gate must FAIL #12");
  const afterArgs = await buildDepositArgs(POOL, WALLET_G, UID);
  const after = stellar(afterArgs, { allowFail: true });
  if (!hasRevokedError(after.output)) {
    throw new Error(
      "Expected deposit to fail with KycAttestationRevoked (#12) after revocation, " +
      "but #12 was not found in the output:\n" + after.output
    );
  }
  log("  ✓ Deposit rejected with Error(Contract, #12) = KycAttestationRevoked.");

  // Persist evidence.
  const out = loadAddresses();
  out.txs = out.txs ?? {};
  if (rev.txHash) out.txs[`kyc_revoke_${WALLET}`] = rev.txHash;
  fs.writeFileSync(ADDRS_FILE, JSON.stringify(out, null, 2));

  log();
  log("╔═══════════════════════════════════════════════════════════╗");
  log("║  Revocation demo complete ✅  Gate open → revoke → closed  ║");
  log("╚═══════════════════════════════════════════════════════════╝");
  log();
  log("  Note: this wallet's KYC is now revoked. Re-run scripts (or the");
  log("  frontend KYC badge) to re-enroll a fresh attestation if needed.");
}

main().catch(err => {
  console.error("\n❌  revoke-kyc failed:", err.message ?? err);
  if (err.output) console.error(err.output);
  process.exit(1);
});
