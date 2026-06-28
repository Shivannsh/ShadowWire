/**
 * KYC registry — per-user, cross-border attestations.
 *
 * The original demo used a single hard-coded KYC leaf (country 91, India) for
 * everyone, so the "cross-border corridor" was never actually demonstrated: both
 * sides of every transfer carried the same jurisdiction. This module registers
 * DISTINCT per-side KYC leaves in one ComplianceRegistry tree:
 *
 *     index 0 = sending-side profile   (e.g. US, ISO-3166 numeric 840)
 *     index 1 = receiving-side profile (e.g. NG, 566)
 *
 * Each leaf = poseidon2(secret_salt, kyc_tier, sanctioned_flag, country_code),
 * exactly as compliance.nr computes it. The tree root + authentication paths are
 * derived with the compliance_tree_util Noir helper (nargo execute), so they are
 * guaranteed to verify inside the proving circuit. depositor_pubkey only feeds the
 * nullifier (not the leaf), so many wallets can share one KYC attestation while
 * still producing unique nullifiers.
 *
 * Enable with KYC_MODE=registry. In the default (demo) mode the issuer keeps the
 * legacy single-leaf behaviour so the currently-deployed on-chain registry root
 * stays valid. Switching to registry mode requires pushing the new root on-chain:
 *     node scripts/set-registry-root.mjs
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, "../..");
const NARGO     = process.env.NARGO ?? path.join(ROOT, ".tools/nargo");
const TREE_DIR  = path.join(ROOT, "circuits/compliance_tree_util");

export type KycSide = "send" | "receive";

export interface KycProfile {
  side:        KycSide;
  label:       string;   // human-readable jurisdiction, e.g. "United States"
  countryName: string;
  secretSalt:  string;
  kycTier:     string;
  sanctioned:  string;
  countryCode: string;   // ISO-3166 numeric as a Field
}

export interface KycAttestation {
  secret_salt:     string;
  kyc_tier:        string;
  sanctioned_flag: string;
  country_code:    string;
  merkle_siblings: string[];  // [Field; 10]
  merkle_index:    string;
  merkle_root:     string;    // 0x-hex
  profile:         KycProfile;
}

// Registered KYC leaves, in tree order. Index = leaf position in the tree.
export const KYC_PROFILES: KycProfile[] = [
  {
    side: "send", label: "United States", countryName: "US",
    secretSalt: "42", kycTier: "2", sanctioned: "0", countryCode: "840",
  },
  {
    side: "receive", label: "Nigeria", countryName: "NG",
    secretSalt: "99", kycTier: "2", sanctioned: "0", countryCode: "566",
  },
];

interface TreeResult { root: string; siblings: string[]; }

function runTreeUtil(targetIdx: number): TreeResult {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shadowwire-kyc-"));
  try {
    execSync(`cp -r "${TREE_DIR}/Nargo.toml" "${TREE_DIR}/src" "${tmpDir}/"`, { stdio: "pipe" });

    const pad = (vals: string[]) => {
      const out = [...vals];
      while (out.length < 8) out.push("0");
      return out.map(v => `"${v}"`).join(", ");
    };
    const salts      = pad(KYC_PROFILES.map(p => p.secretSalt));
    const tiers      = pad(KYC_PROFILES.map(p => p.kycTier));
    const sanctioned = pad(KYC_PROFILES.map(p => p.sanctioned));
    const countries  = pad(KYC_PROFILES.map(p => p.countryCode));

    const toml =
      `salts = [${salts}]\n` +
      `tiers = [${tiers}]\n` +
      `sanctioned = [${sanctioned}]\n` +
      `countries = [${countries}]\n` +
      `n_active = "${KYC_PROFILES.length}"\n` +
      `target_idx = "${targetIdx}"\n`;
    fs.writeFileSync(path.join(tmpDir, "Prover.toml"), toml);

    const stdout = execSync(`"${NARGO}" execute`, { cwd: tmpDir, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    const line = stdout.split("\n").find(l => l.includes("Circuit output:"));
    if (!line) throw new Error(`compliance_tree_util: no Circuit output:\n${stdout}`);

    const rootMatch = line.match(/Circuit output:\s*\(\s*(0x[0-9a-fA-F]+)/);
    if (!rootMatch) throw new Error(`compliance_tree_util: could not parse root from: ${line}`);
    const sibsMatch = line.match(/,\s*\[([^\]]+)\]/);
    if (!sibsMatch) throw new Error(`compliance_tree_util: could not parse siblings from: ${line}`);
    const siblings = sibsMatch[1].split(",").map(s => s.trim());
    if (siblings.length !== 10) throw new Error(`expected 10 siblings, got ${siblings.length}`);

    return { root: rootMatch[1], siblings };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// Cache the computed tree (root + each leaf's path). Recomputed lazily once.
let cache: { root: string; paths: TreeResult[] } | null = null;

function ensureTree(): { root: string; paths: TreeResult[] } {
  if (cache) return cache;
  const paths = KYC_PROFILES.map((_, i) => runTreeUtil(i));
  const root = paths[0].root;
  for (const p of paths) {
    if (p.root !== root) throw new Error("KYC tree roots inconsistent across leaves");
  }
  cache = { root, paths };
  return cache;
}

export function getRegistryRoot(): string {
  return ensureTree().root;
}

/** Resolve the KYC attestation for a given corridor side (send / receive). */
export function getAttestationForSide(side: KycSide): KycAttestation {
  const idx = KYC_PROFILES.findIndex(p => p.side === side);
  if (idx < 0) throw new Error(`No KYC profile registered for side "${side}"`);
  const { root, paths } = ensureTree();
  const profile = KYC_PROFILES[idx];
  return {
    secret_salt:     profile.secretSalt,
    kyc_tier:        profile.kycTier,
    sanctioned_flag: profile.sanctioned,
    country_code:    profile.countryCode,
    merkle_siblings: paths[idx].siblings,
    merkle_index:    String(idx),
    merkle_root:     root,
    profile,
  };
}
