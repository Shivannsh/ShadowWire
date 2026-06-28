#!/usr/bin/env node
/**
 * set-registry-root.mjs
 *
 * Pushes the multi-user KYC tree root (US sender + NG receiver, computed by the
 * mock-issuer's compliance_tree_util helper) into the on-chain ComplianceRegistry.
 *
 * This is the on-chain half of enabling cross-border per-user KYC (KYC_MODE=registry):
 *   1. Run the issuer with KYC_MODE=registry.
 *   2. Run this script (admin-signed) to update the registry root so compliance
 *      proofs built against the new tree verify on-chain.
 *
 * The root is read from the running issuer (GET /api/corridor + /api/attestation)
 * so it always matches what the prover signs into proofs.
 *
 * Usage:
 *   ISSUER_URL=http://localhost:3001 node scripts/set-registry-root.mjs
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const ADDRS_FILE = path.join(ROOT, "testnet-addresses.json");
const ISSUER_URL = process.env.ISSUER_URL ?? "http://localhost:3001";
const NETWORK = "testnet";

function stellar(...args) {
  const envPath = `${ROOT}/.tools:${process.env.HOME}/.cargo/bin:${process.env.PATH}`;
  console.log(`  $ stellar ${args.join(" ")}`);
  const result = spawnSync("stellar", args, {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    env: { ...process.env, PATH: envPath },
  });
  if (result.stderr) process.stdout.write(result.stderr);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.status !== 0) throw new Error(`stellar failed (exit ${result.status})`);
  return (result.stdout ?? "") + (result.stderr ?? "");
}

async function main() {
  const addrs = JSON.parse(fs.readFileSync(ADDRS_FILE, "utf8"));
  const REGISTRY = addrs.contracts.compliance_registry;
  if (!REGISTRY) throw new Error("compliance_registry missing in testnet-addresses.json");

  const att = await (await fetch(`${ISSUER_URL}/api/attestation`)).json();
  if (att.mode !== "registry") {
    throw new Error(
      `Issuer is in '${att.mode}' mode. Start it with KYC_MODE=registry before setting the root.`
    );
  }
  const newRoot = String(att.merkleRoot).replace(/^0x/, "");
  console.log(`  Registry:  ${REGISTRY}`);
  console.log(`  New root:  ${newRoot}`);
  console.log(`  Corridor:  ${att.sending?.country} (${att.sending?.countryCode}) -> ${att.receiving?.country} (${att.receiving?.countryCode})`);

  const out = stellar(
    "contract", "invoke",
    "--id", REGISTRY,
    "--network", NETWORK,
    "--source-account", "deployer",
    "--send=yes",
    "--",
    "update_root",
    "--new_root", newRoot,
  );
  const txMatch = out.replace(/\x1b\[[0-9;]*m/g, "").match(/testnet\/tx\/([a-f0-9]{64})/i);
  console.log(`  ✅ Registry root updated${txMatch ? `: ${txMatch[1]}` : ""}`);

  addrs.txs = addrs.txs ?? {};
  addrs.txs.registry_root_update = txMatch ? txMatch[1] : "";
  fs.writeFileSync(ADDRS_FILE, JSON.stringify(addrs, null, 2));
}

main().catch(err => {
  console.error("\n❌  set-registry-root failed:", err.message ?? err);
  process.exit(1);
});
