#!/usr/bin/env node
/**
 * bind-check.mjs — proves the compliance proof ↔ KYC attestation binding (v12).
 *
 * The compliance circuit publishes the attestation UID (two 16-byte halves,
 * slots [6]/[7]). deposit()/withdraw() reconstruct those halves from the
 * kyc_attestation_uid they verify on-chain and require a match. This script
 * demonstrates both directions in simulation (--send=no, no SRT funding needed):
 *
 *   - BOUND proof   (compliance proof generated for the real UID): passes the
 *     gate AND the binding; the simulation only fails later (e.g. SAC transfer),
 *     never with ComplianceAttestationUnbound (#15).
 *   - UNBOUND proof (compliance proof generated for a DIFFERENT UID, while the
 *     pool arg is the real UID so the gate itself still passes): rejected with
 *     Error(Contract, #15).
 *
 * Prereqs: AttestProtocol deployed, mock-issuer running (8-signal build), BLS key
 *          registered, and an active pool v12 in testnet-addresses.json.
 *
 * Usage:
 *   node scripts/bind-check.mjs
 *   WALLET=bob SIDE=receive node scripts/bind-check.mjs
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

function fieldToHex(field) {
  const s = String(field).trim();
  const stripped = (s.startsWith("0x") || s.startsWith("0X")) ? s.slice(2) : s;
  if (/[a-fA-F]/.test(stripped)) return stripped.toLowerCase().padStart(64, "0");
  return BigInt(s).toString(16).padStart(64, "0");
}
function bytesToHex(arr) { return arr.map(b => b.toString(16).padStart(2, "0")).join(""); }
function randField() { return String(1 + Math.floor(Math.random() * 1_000_000_000)); }
function randUid() {
  let h = "";
  for (let i = 0; i < 32; i++) h += Math.floor(Math.random() * 256).toString(16).padStart(2, "0");
  return h;
}

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

/**
 * Build a deposit invocation argv (simulation-only via --send=no).
 *   poolUid  — the kyc_attestation_uid argument passed to the pool (drives the gate).
 *   proofUid — the UID the compliance proof is generated against (drives the binding).
 * When proofUid !== poolUid the binding must fail with #15.
 */
async function buildDepositArgs(pool, depositor, poolUid, proofUid) {
  const owner = randField();
  const note = await api("/api/prove/deposit", {
    ownerField: owner, value: AMOUNT, assetId: "3", blinding: randField(), secretKey: randField(),
  });
  const comp = await api("/api/prove/compliance", {
    amount: AMOUNT, ownerField: owner, attestationUid: proofUid,
  });
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
    "--kyc_attestation_uid",    poolUid,
  ];
}

function hasUnboundError(output) {
  // Pool error #15 = ComplianceAttestationUnbound.
  return /Error\(Contract,\s*#15\)/.test(output) || /#15/.test(output);
}

// Transient RPC state-availability errors right after a fresh deploy.
function isTransientRpc(output) {
  return /Contract not found|MissingValue|non-existing value for contract instance/i.test(output)
    && !hasUnboundError(output);
}

/** Run a deposit simulation, retrying through transient post-deploy RPC errors. */
async function simulateDeposit(buildArgs, { maxAttempts = 6 } = {}) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const args = await buildArgs();
    const res = stellar(args, { allowFail: true });
    if (attempt < maxAttempts && isTransientRpc(res.output)) {
      log(`  ⚠ transient RPC error (attempt ${attempt}/${maxAttempts}) — waiting 12s…`);
      await new Promise(r => setTimeout(r, 12000));
      continue;
    }
    return res;
  }
  throw new Error("exhausted retries on transient RPC errors");
}

async function main() {
  log("╔═══════════════════════════════════════════════════════════╗");
  log("║  ShadowWire — compliance ↔ attestation binding check (v12) ║");
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

  section("Step 2 — BOUND proof (proof UID == on-chain UID): binding must PASS");
  const bound = await simulateDeposit(() => buildDepositArgs(POOL, WALLET_G, UID, UID));
  if (hasUnboundError(bound.output)) {
    throw new Error("Unexpected: bound proof reported #15.\n" + bound.output);
  }
  if (bound.status === 0) {
    log("  ✓ Binding passed — deposit simulation succeeded end-to-end.");
  } else {
    log("  ✓ Binding passed — simulation proceeded past the gate + binding and");
    log("    failed later (e.g. SAC transfer/trustline), NOT with #15. Expected.");
  }

  section("Step 3 — UNBOUND proof (proof UID != on-chain UID): must FAIL #15");
  const bogus = randUid();
  log(`  Generating a compliance proof bound to a DIFFERENT UID: ${bogus.slice(0, 16)}…`);
  const unbound = await simulateDeposit(() => buildDepositArgs(POOL, WALLET_G, UID, bogus));
  if (!hasUnboundError(unbound.output)) {
    throw new Error(
      "Expected deposit to fail with ComplianceAttestationUnbound (#15) when the " +
      "compliance proof is bound to a different UID, but #15 was not found:\n" + unbound.output
    );
  }
  log("  ✓ Deposit rejected with Error(Contract, #15) = ComplianceAttestationUnbound.");

  log();
  log("╔═══════════════════════════════════════════════════════════╗");
  log("║  Binding check complete ✅  proof is tied to the KYC UID   ║");
  log("╚═══════════════════════════════════════════════════════════╝");
}

main().catch(err => {
  console.error("\n❌  bind-check failed:", err.message ?? err);
  if (err.output) console.error(err.output);
  process.exit(1);
});
