import * as StellarSdk from "@stellar/stellar-sdk";
import { config } from "@/lib/stellar";
import { loadTestnetAddresses } from "@/lib/addresses";

export const TEST_ANCHOR_DOMAIN = "testanchor.stellar.org";

export interface AnchorConfig {
  webAuthEndpoint: string;
  transferServer: string;
  assetCode: string;
  assetIssuer: string;
}

export interface Sep24Transaction {
  id: string;
  status: string;
  url?: string;
  amount_in?: string;
  amount_out?: string;
  amount_fee?: string;
  stellar_transaction_id?: string;
  external_transaction_id?: string;
}

async function fetchToml(domain: string): Promise<Record<string, string>> {
  const res = await fetch(`https://${domain}/.well-known/stellar.toml`);
  if (!res.ok) {
    throw new Error(`Failed to load stellar.toml from ${domain}`);
  }
  const text = await res.text();
  const toml: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("[")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^"|"$/g, "");
    toml[key] = value;
  }
  return toml;
}

export async function getAnchorConfig(
  domain = TEST_ANCHOR_DOMAIN
): Promise<AnchorConfig> {
  const addresses = await loadTestnetAddresses();
  const toml = await fetchToml(domain);

  const webAuthEndpoint = toml.WEB_AUTH_ENDPOINT;
  const transferServer =
    toml.TRANSFER_SERVER_SEP0024 || toml.TRANSFER_SERVER;

  if (!webAuthEndpoint || !transferServer) {
    throw new Error("Anchor TOML missing WEB_AUTH_ENDPOINT or TRANSFER_SERVER_SEP0024");
  }

  return {
    webAuthEndpoint,
    transferServer: transferServer.replace(/\/$/, ""),
    assetCode: addresses.anchor.asset_code,
    assetIssuer: addresses.anchor.asset_issuer,
  };
}

export async function sep10Auth(
  account: string,
  signXdr: (xdr: string) => Promise<string>,
  domain = TEST_ANCHOR_DOMAIN
): Promise<string> {
  const anchor = await getAnchorConfig(domain);
  const challengeUrl = `${anchor.webAuthEndpoint}?account=${encodeURIComponent(account)}`;
  const challengeRes = await fetch(challengeUrl);
  if (!challengeRes.ok) {
    throw new Error(`SEP-10 challenge failed: ${challengeRes.statusText}`);
  }
  const { transaction: challengeXdr } = (await challengeRes.json()) as {
    transaction: string;
  };

  const signedXdr = await signXdr(challengeXdr);

  const tokenRes = await fetch(anchor.webAuthEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ transaction: signedXdr }),
  });

  if (!tokenRes.ok) {
    const body = await tokenRes.text();
    throw new Error(`SEP-10 token exchange failed: ${body}`);
  }

  const { token } = (await tokenRes.json()) as { token: string };
  return token;
}

function authHeaders(token: string): HeadersInit {
  return { Authorization: `Bearer ${token}` };
}

async function startInteractiveTransaction(
  anchor: AnchorConfig,
  token: string,
  kind: "deposit" | "withdraw",
  account: string,
  amount?: string
): Promise<Sep24Transaction> {
  const params = new URLSearchParams({
    asset_code: anchor.assetCode,
    asset_issuer: anchor.assetIssuer,
    account,
  });
  if (amount) params.set("amount", amount);

  const path =
    kind === "deposit"
      ? `${anchor.transferServer}/transactions/deposit/interactive`
      : `${anchor.transferServer}/transactions/withdraw/interactive`;

  const res = await fetch(`${path}?${params}`, {
    headers: authHeaders(token),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`SEP-24 ${kind} init failed: ${body}`);
  }

  return (await res.json()) as Sep24Transaction;
}

export async function pollSep24Transaction(
  anchor: AnchorConfig,
  token: string,
  transactionId: string,
  onStatus?: (tx: Sep24Transaction) => void,
  maxAttempts = 120
): Promise<Sep24Transaction> {
  const url = `${anchor.transferServer}/transactions/${transactionId}`;

  for (let i = 0; i < maxAttempts; i++) {
    const res = await fetch(url, { headers: authHeaders(token) });
    if (!res.ok) {
      throw new Error(`SEP-24 poll failed: ${res.statusText}`);
    }
    const tx = (await res.json()) as Sep24Transaction;
    onStatus?.(tx);

    if (
      tx.status === "completed" ||
      tx.status === "error" ||
      tx.status === "refunded"
    ) {
      return tx;
    }

    await new Promise((r) => setTimeout(r, 2000));
  }

  throw new Error("SEP-24 transaction polling timed out");
}

export function openSep24Popup(url: string, name = "sep24"): Window | null {
  const width = 500;
  const height = 700;
  const left = window.screenX + (window.outerWidth - width) / 2;
  const top = window.screenY + (window.outerHeight - height) / 2;
  return window.open(
    url,
    name,
    `width=${width},height=${height},left=${left},top=${top},resizable=yes,scrollbars=yes`
  );
}

export interface Sep24FlowResult {
  transaction: Sep24Transaction;
  popupClosed: boolean;
}

export async function runSep24Deposit(params: {
  account: string;
  signXdr: (xdr: string) => Promise<string>;
  amount?: string;
  domain?: string;
  onStatus?: (message: string) => void;
}): Promise<Sep24FlowResult> {
  const domain = params.domain ?? TEST_ANCHOR_DOMAIN;
  params.onStatus?.("Authenticating with anchor (SEP-10)…");
  const token = await sep10Auth(params.account, params.signXdr, domain);
  const anchor = await getAnchorConfig(domain);

  params.onStatus?.("Starting SEP-24 deposit…");
  const initiated = await startInteractiveTransaction(
    anchor,
    token,
    "deposit",
    params.account,
    params.amount
  );

  if (!initiated.url) {
    throw new Error("SEP-24 deposit did not return an interactive URL");
  }

  params.onStatus?.("Complete KYC in the anchor popup…");
  const popup = openSep24Popup(initiated.url);
  let popupClosed = false;

  if (popup) {
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (popup.closed) {
          clearInterval(timer);
          popupClosed = true;
          resolve();
        }
      }, 500);
    });
  }

  params.onStatus?.("Waiting for anchor to complete deposit…");
  const transaction = await pollSep24Transaction(
    anchor,
    token,
    initiated.id,
    (tx) => params.onStatus?.(`Anchor status: ${tx.status}`)
  );

  if (transaction.status === "error") {
    throw new Error("SEP-24 deposit failed at anchor");
  }

  return { transaction, popupClosed };
}

export async function runSep24Withdraw(params: {
  account: string;
  signXdr: (xdr: string) => Promise<string>;
  amount: string;
  domain?: string;
  onStatus?: (message: string) => void;
}): Promise<Sep24FlowResult> {
  const domain = params.domain ?? TEST_ANCHOR_DOMAIN;
  params.onStatus?.("Authenticating with anchor (SEP-10)…");
  const token = await sep10Auth(params.account, params.signXdr, domain);
  const anchor = await getAnchorConfig(domain);

  params.onStatus?.("Starting SEP-24 withdrawal…");
  const initiated = await startInteractiveTransaction(
    anchor,
    token,
    "withdraw",
    params.account,
    params.amount
  );

  if (!initiated.url) {
    throw new Error("SEP-24 withdrawal did not return an interactive URL");
  }

  params.onStatus?.("Complete withdrawal in the anchor popup…");
  const popup = openSep24Popup(initiated.url);
  let popupClosed = false;

  if (popup) {
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (popup.closed) {
          clearInterval(timer);
          popupClosed = true;
          resolve();
        }
      }, 500);
    });
  }

  params.onStatus?.("Waiting for anchor to complete withdrawal…");
  const transaction = await pollSep24Transaction(
    anchor,
    token,
    initiated.id,
    (tx) => params.onStatus?.(`Anchor status: ${tx.status}`)
  );

  if (transaction.status === "error") {
    throw new Error("SEP-24 withdrawal failed at anchor");
  }

  return { transaction, popupClosed };
}

export function getSrtAsset(): StellarSdk.Asset {
  return new StellarSdk.Asset("SRT", "GCKFBEIYTLPDA6XIZXHILFFJ6JVWGUUYLPT66RXYFDT3DD45QTWDCMG");
}

export function isTestnetNetwork(): boolean {
  return config.networkPassphrase === StellarSdk.Networks.TESTNET;
}
