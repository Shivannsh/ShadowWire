/**
 * Read the on-chain ComplianceRegistry Merkle root so the issuer can auto-select
 * KYC mode (demo vs registry) and stay in sync with what deposit/withdraw verify.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as StellarSdk from "@stellar/stellar-sdk";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const ADDRESSES_FILE = path.join(ROOT, "testnet-addresses.json");
const TESTNET_RPC = process.env.SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org";

const rpc = new StellarSdk.rpc.Server(TESTNET_RPC);

function getRegistryContractId(): string {
  const addresses = JSON.parse(fs.readFileSync(ADDRESSES_FILE, "utf8"));
  return addresses.contracts.compliance_registry;
}

/** Normalize a root to lowercase hex without 0x prefix. */
export function normalizeRoot(hex: string): string {
  return String(hex).trim().toLowerCase().replace(/^0x/, "");
}

/** Read the live KYC registry root from Soroban (same value the pool checks). */
export async function readRegistryRoot(): Promise<string> {
  const contractId = getRegistryContractId();
  const contract = new StellarSdk.Contract(contractId);
  const tx = new StellarSdk.TransactionBuilder(
    new StellarSdk.Account("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF", "0"),
    { fee: "100", networkPassphrase: StellarSdk.Networks.TESTNET }
  )
    .addOperation(contract.call("get_root"))
    .setTimeout(30)
    .build();

  const sim = await rpc.simulateTransaction(tx);
  if (StellarSdk.rpc.Api.isSimulationError(sim)) {
    throw new Error("registry get_root simulation failed: " + sim.error);
  }
  const native = StellarSdk.scValToNative(sim.result!.retval!);
  return "0x" + Buffer.from(native as Buffer).toString("hex");
}

export type KycMode = "demo" | "registry";

/**
 * Pick KYC mode from env or by comparing the on-chain registry root to the
 * locally-known demo and multi-user registry roots.
 */
export async function resolveKycMode(
  explicit: string | undefined,
  demoRootHex: string,
  registryRootHex: string,
): Promise<KycMode> {
  if (explicit === "demo" || explicit === "registry") return explicit;

  const onChain = normalizeRoot(await readRegistryRoot());
  const demo = normalizeRoot(demoRootHex);
  const registry = normalizeRoot(registryRootHex);

  if (onChain === registry) return "registry";
  if (onChain === demo) return "demo";

  console.warn(
    `[kyc] On-chain registry root 0x${onChain.slice(0, 16)}… matches neither ` +
    `demo (0x${demo.slice(0, 16)}…) nor registry (0x${registry.slice(0, 16)}…). ` +
    `Defaulting to registry mode.`
  );
  return "registry";
}
