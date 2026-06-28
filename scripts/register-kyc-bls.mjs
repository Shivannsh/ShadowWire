#!/usr/bin/env node
/**
 * register-kyc-bls.mjs
 *
 * One-time setup: registers the issuer's BLS public key on the AttestProtocol
 * contract for the KYC authority (deployer) address. This is the ONLY action
 * that requires the authority's Stellar signature, so we do it via the CLI
 * (`--source-account deployer`). After this, the issuer can autonomously issue
 * delegated KYC attestations (it signs with the matching BLS secret; a separate
 * funded submitter account pays gas).
 *
 * Prereqs:
 *   - AttestProtocol deployed (scripts/deploy-attest-protocol.mjs).
 *   - mock-issuer running (npm start) so we can read its BLS public key.
 *
 * Usage:
 *   node scripts/register-kyc-bls.mjs
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const ROOT       = path.resolve(__dirname, "..");
const ADDRS_FILE = path.join(ROOT, "testnet-addresses.json");
const ISSUER_URL = process.env.ISSUER_URL ?? "http://localhost:3001";
const NETWORK    = "testnet";

function log(m) { console.log(m); }
function stellar(...args) {
  const envPath = `${ROOT}/.tools:${process.env.HOME}/.cargo/bin:${process.env.PATH}`;
  log(`  $ stellar ${args.join(" ")}`);
  const r = spawnSync("stellar", args, { encoding: "utf8", maxBuffer: 10 * 1024 * 1024, env: { ...process.env, PATH: envPath } });
  if (r.stderr) process.stdout.write(r.stderr);
  if (r.stdout) process.stdout.write(r.stdout);
  const combined = (r.stdout ?? "") + (r.stderr ?? "");
  if (r.status !== 0) { const e = new Error(`stellar failed (exit ${r.status})`); e.output = combined; throw e; }
  return combined;
}

async function waitForIssuer(maxSecs = 60) {
  for (let i = 0; i < maxSecs; i++) {
    try {
      const r = await fetch(`${ISSUER_URL}/api/kyc/config`);
      if (r.ok) return r.json();
    } catch {}
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error(`Issuer not reachable at ${ISSUER_URL} after ${maxSecs}s`);
}

async function main() {
  log("╔═══════════════════════════════════════════════════════════╗");
  log("║  ShadowWire — Register KYC authority BLS key              ║");
  log("╚═══════════════════════════════════════════════════════════╝");

  const cfg = await waitForIssuer();
  if (!cfg.configured) throw new Error("Issuer reports AttestProtocol not configured (run deploy-attest-protocol.mjs first)");
  const { protocol, authority, blsPublicKey } = cfg;
  if (!blsPublicKey || blsPublicKey.length !== 384) {
    throw new Error(`Bad BLS public key from issuer (expected 384 hex chars / 192 bytes): ${blsPublicKey}`);
  }

  const DEPLOYER = stellar("keys", "public-key", "deployer").trim();
  if (DEPLOYER !== authority) {
    throw new Error(`KYC authority (${authority}) != deployer key (${DEPLOYER}). The authority must sign register_bls_key.`);
  }
  log(`  Protocol : ${protocol}`);
  log(`  Authority: ${authority}`);
  log(`  BLS pubkey (192B): ${blsPublicKey.slice(0, 24)}…`);

  // Skip if already registered (register_bls_key is one-shot / immutable).
  let already = false;
  try {
    const out = stellar("contract", "invoke", "--id", protocol, "--network", NETWORK,
      "--source-account", "deployer", "--", "get_bls_key", "--attester", authority);
    if (/key/i.test(out)) already = true;
  } catch { /* not registered yet */ }

  if (already) {
    log("\n  ✓ BLS key already registered for the authority — nothing to do.");
    return;
  }

  log("\n  Registering BLS key (deployer signs)…");
  const out = stellar("contract", "invoke", "--id", protocol, "--network", NETWORK,
    "--source-account", "deployer", "--send=yes", "--",
    "register_bls_key", "--attester", authority, "--public_key", blsPublicKey);

  const addrs = JSON.parse(fs.readFileSync(ADDRS_FILE, "utf8"));
  addrs.attestation = addrs.attestation ?? {};
  addrs.attestation.bls_public_key = blsPublicKey;
  addrs.txs = addrs.txs ?? {};
  const tx = (out.replace(/\x1b\[[0-9;]*m/g, "").match(/testnet\/tx\/([a-f0-9]{64})/i) || [])[1];
  if (tx) addrs.txs.attest_bls_register = tx;
  fs.writeFileSync(ADDRS_FILE, JSON.stringify(addrs, null, 2));
  fs.mkdirSync(path.join(ROOT, "frontend/public"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "frontend/public/testnet-addresses.json"), JSON.stringify(addrs, null, 2));

  log("\n╔═══════════════════════════════════════════════════════════╗");
  log("║  KYC authority BLS key registered ✅                       ║");
  log("╚═══════════════════════════════════════════════════════════╝");
  log("  The issuer can now issue delegated KYC attestations.");
}

main().catch(err => {
  console.error("\n❌  register-kyc-bls failed:", err.message ?? err);
  if (err.output) console.error(err.output);
  process.exit(1);
});
