import * as StellarSdk from "@stellar/stellar-sdk";

export type NetworkKey = "testnet" | "mainnet";

function resolveNetwork(): NetworkKey {
  const value = process.env.NEXT_PUBLIC_STELLAR_NETWORK;
  return value === "mainnet" ? "mainnet" : "testnet";
}

const NETWORK = resolveNetwork();

const requireEnv = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
};

function buildConfig() {
  if (NETWORK === "mainnet") {
    return {
      horizonUrl: "https://horizon.stellar.org",
      rpcUrl: requireEnv("NEXT_PUBLIC_STELLAR_MAINNET_RPC_URL"),
      networkPassphrase: StellarSdk.Networks.PUBLIC,
      friendbotUrl: null,
    };
  }
  return {
    horizonUrl: "https://horizon-testnet.stellar.org",
    rpcUrl: "https://soroban-testnet.stellar.org",
    networkPassphrase: StellarSdk.Networks.TESTNET,
    friendbotUrl: "https://friendbot.stellar.org",
  };
}

export const config = buildConfig();

export const horizon = new StellarSdk.Horizon.Server(config.horizonUrl);
export const rpc = new StellarSdk.rpc.Server(config.rpcUrl);

export const STROOPS_PER_UNIT = 10_000_000;

export function toStroops(amount: string): bigint {
  const [whole, frac = ""] = amount.split(".");
  const padded = (frac + "0000000").slice(0, 7);
  return BigInt(whole) * BigInt(STROOPS_PER_UNIT) + BigInt(padded);
}

export function fromStroops(stroops: bigint): string {
  const whole = stroops / BigInt(STROOPS_PER_UNIT);
  const frac = stroops % BigInt(STROOPS_PER_UNIT);
  const fracStr = frac.toString().padStart(7, "0").replace(/0+$/, "");
  return fracStr ? `${whole}.${fracStr}` : whole.toString();
}

export async function fundTestnetAccount(address: string): Promise<void> {
  if (!config.friendbotUrl) {
    throw new Error("Friendbot is only available on testnet");
  }
  const url = `${config.friendbotUrl}?addr=${encodeURIComponent(address)}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Friendbot funding failed: ${res.statusText}`);
  }
}

export async function getNativeBalance(address: string): Promise<string> {
  try {
    const account = await horizon.loadAccount(address);
    const native = account.balances.find((b) => b.asset_type === "native");
    return native?.balance ?? "0";
  } catch (err: unknown) {
    const status = (err as { response?: { status?: number } })?.response?.status;
    if (status === 404) return "0";
    throw err;
  }
}

export async function getClassicAssetBalance(
  address: string,
  assetCode: string,
  assetIssuer: string
): Promise<string> {
  try {
    const account = await horizon.loadAccount(address);
    const balance = account.balances.find(
      (b) =>
        b.asset_type !== "native" &&
        "asset_code" in b &&
        b.asset_code === assetCode &&
        b.asset_issuer === assetIssuer
    );
    return balance && "balance" in balance ? balance.balance : "0";
  } catch (err: unknown) {
    const status = (err as { response?: { status?: number } })?.response?.status;
    if (status === 404) return "0";
    throw err;
  }
}

export function truncateAddress(address: string, chars = 4): string {
  if (address.length <= chars * 2 + 3) return address;
  return `${address.slice(0, chars)}…${address.slice(-chars)}`;
}

/**
 * Build an unsigned ChangeTrust transaction XDR that establishes a trustline
 * for the given asset on the account. Returns the XDR for signing by Freighter.
 */
export async function buildAddTrustlineTx(
  account: string,
  assetCode: string,
  assetIssuer: string
): Promise<string> {
  const accountRecord = await horizon.loadAccount(account);
  const asset = new StellarSdk.Asset(assetCode, assetIssuer);
  const tx = new StellarSdk.TransactionBuilder(accountRecord, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: config.networkPassphrase,
  })
    .addOperation(StellarSdk.Operation.changeTrust({ asset }))
    .setTimeout(180)
    .build();
  return tx.toXDR();
}

/**
 * Check whether an account already has a trustline for the given asset.
 */
export async function hasTrustline(
  address: string,
  assetCode: string,
  assetIssuer: string
): Promise<boolean> {
  try {
    const account = await horizon.loadAccount(address);
    return account.balances.some(
      (b) =>
        b.asset_type !== "native" &&
        "asset_code" in b &&
        b.asset_code === assetCode &&
        b.asset_issuer === assetIssuer
    );
  } catch {
    return false;
  }
}
