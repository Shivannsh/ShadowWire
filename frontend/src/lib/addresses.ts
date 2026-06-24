export interface TestnetAddresses {
  network: string;
  anchor: {
    domain: string;
    asset_code: string;
    asset_issuer: string;
  };
  contracts: {
    shielded_pool: string;
    compliance_verifier: string;
    shielded_transfer_verifier: string;
    compliance_registry: string;
    pool_asset: string;
  };
  pipeline_test?: {
    contract_id: string;
    deploy_tx: string;
    verify_result: boolean;
  };
  accounts: {
    deployer: string;
    alice: string;
    bob: string;
  };
}

let cached: TestnetAddresses | null = null;

export async function loadTestnetAddresses(): Promise<TestnetAddresses> {
  if (cached) return cached;
  const res = await fetch("/testnet-addresses.json", { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`Failed to load testnet-addresses.json: ${res.statusText}`);
  }
  cached = (await res.json()) as TestnetAddresses;
  return cached;
}

export function resolveContractAddress(
  envValue: string | undefined,
  placeholder: string | undefined
): string | null {
  if (envValue && envValue.trim()) return envValue.trim();
  if (placeholder && placeholder !== "pending") return placeholder;
  return null;
}

export async function getShieldedPoolContractId(): Promise<string | null> {
  const addresses = await loadTestnetAddresses();
  return resolveContractAddress(
    process.env.NEXT_PUBLIC_SHIELDED_POOL_CONTRACT,
    addresses.contracts.shielded_pool
  );
}

export async function getPoolAssetContractId(): Promise<string | null> {
  const addresses = await loadTestnetAddresses();
  return resolveContractAddress(
    process.env.NEXT_PUBLIC_POOL_ASSET_CONTRACT,
    addresses.contracts.pool_asset
  );
}
