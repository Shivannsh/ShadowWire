import * as StellarSdk from "@stellar/stellar-sdk";
import { config, horizon } from "@/lib/stellar";
import { loadTestnetAddresses } from "@/lib/addresses";
import { submitTransaction } from "@/lib/transactions";

export const TEST_ANCHOR_DOMAIN = "testanchor.stellar.org";

/**
 * All anchor HTTP calls are routed through this Next.js server-side proxy.
 * This avoids CORS preflight failures when the browser calls testanchor.stellar.org
 * directly from localhost (or any origin not whitelisted by the anchor).
 */
const ANCHOR_PROXY_BASE = "/api/anchor";

function proxyUrl(absoluteUrl: string): string {
  // Replace https://testanchor.stellar.org with /api/anchor
  return absoluteUrl.replace(
    /^https?:\/\/testanchor\.stellar\.org/,
    ANCHOR_PROXY_BASE
  );
}

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
  message?: string;
  /** Withdrawal: Stellar account that receives the user's SRT payment. */
  withdraw_anchor_account?: string;
  /** Withdrawal: memo attached to the payment (type given by withdraw_memo_type). */
  withdraw_memo?: string;
  withdraw_memo_type?: "id" | "text" | "hash" | "return";
}

/** testanchor sometimes marks deposits "error" while the SAC payment already landed. */
const ANCHOR_TX_LOOKUP_ERROR = "Failed to retrieve Stellar transaction";

function extractStellarTxHash(message: string | undefined): string | null {
  if (!message) return null;
  const bracketed = message.match(/\[([a-f0-9]{64})\]/i);
  if (bracketed) return bracketed[1].toLowerCase();
  const bare = message.match(/\b([a-f0-9]{64})\b/i);
  return bare ? bare[1].toLowerCase() : null;
}

async function verifyAnchorDepositOnChain(
  account: string,
  txHash: string,
  assetCode: string,
  assetIssuer: string
): Promise<{ verified: boolean; amount?: string; txHash: string }> {
  const { horizon } = await import("@/lib/stellar");
  try {
    const tx = await horizon.transactions().transaction(txHash).call();
    if (!tx.successful) return { verified: false, txHash };

    const ops = await horizon.operations().forTransaction(txHash).call();
    for (const op of ops.records) {
      const changes = (op as { asset_balance_changes?: Array<{
        type: string;
        to?: string;
        asset_code?: string;
        asset_issuer?: string;
        amount?: string;
      }> }).asset_balance_changes;
      if (!changes) continue;
      for (const change of changes) {
        if (
          change.type === "transfer" &&
          change.to === account &&
          change.asset_code === assetCode &&
          change.asset_issuer === assetIssuer
        ) {
          return { verified: true, amount: change.amount, txHash };
        }
      }
    }
    return { verified: false, txHash };
  } catch {
    return { verified: false, txHash };
  }
}

async function tryRecoverFromAnchorLookupError(params: {
  anchor: AnchorConfig;
  token: string;
  transactionId: string;
  account: string;
  onStatus?: (message: string) => void;
}): Promise<Sep24Transaction | null> {
  const { anchor, token, transactionId, account, onStatus } = params;
  onStatus?.("Anchor reported a tx lookup error — rechecking status…");

  // Give testanchor a moment to reconcile Soroban SAC transfers.
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const url = `${proxyUrl(anchor.transferServer)}/transaction?id=${transactionId}`;
    const res = await fetch(url, { headers: authHeaders(token) });
    if (!res.ok) continue;
    const json = (await res.json()) as { transaction: Sep24Transaction };
    const tx = json.transaction ?? (json as unknown as Sep24Transaction);
    if (tx.status === "completed") return tx;
    if (tx.status !== "error") continue;

    const hash =
      tx.stellar_transaction_id ??
      extractStellarTxHash(tx.message) ??
      extractStellarTxHash(JSON.stringify(tx));
    if (!hash) continue;

    onStatus?.("Verifying on-chain payment…");
    const check = await verifyAnchorDepositOnChain(
      account,
      hash,
      anchor.assetCode,
      anchor.assetIssuer
    );
    if (check.verified) {
      return {
        ...tx,
        status: "completed",
        stellar_transaction_id: check.txHash,
        amount_out: tx.amount_out ?? check.amount,
        message: undefined,
      };
    }
  }

  return null;
}

function formatSep24Error(kind: "deposit" | "withdraw", tx: Sep24Transaction): string {
  const detail = tx.message?.trim();
  if (detail) {
    return `SEP-24 ${kind} failed at anchor: ${detail.slice(0, 240)}`;
  }
  return `SEP-24 ${kind} failed at anchor (status: ${tx.status})`;
}

async function fetchToml(domain: string): Promise<Record<string, string>> {
  const res = await fetch(`${ANCHOR_PROXY_BASE}/.well-known/stellar.toml`);
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
  const challengeUrl = `${proxyUrl(anchor.webAuthEndpoint)}?account=${encodeURIComponent(account)}`;
  const challengeRes = await fetch(challengeUrl);
  if (!challengeRes.ok) {
    throw new Error(`SEP-10 challenge failed: ${challengeRes.statusText}`);
  }
  const { transaction: challengeXdr } = (await challengeRes.json()) as {
    transaction: string;
  };

  const signedXdr = await signXdr(challengeXdr);

  const tokenRes = await fetch(proxyUrl(anchor.webAuthEndpoint), {
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
  // SEP-24: POST with multipart/form-data (testanchor rejects url-encoded).
  // We intentionally omit `amount` — the anchor's interactive popup collects it,
  // and we read the final amount back from the transaction response.
  const body = new FormData();
  body.append("asset_code", anchor.assetCode);
  body.append("asset_issuer", anchor.assetIssuer);
  body.append("account", account);
  void amount; // kept in signature for future anchors that accept it

  const path =
    kind === "deposit"
      ? `${proxyUrl(anchor.transferServer)}/transactions/deposit/interactive`
      : `${proxyUrl(anchor.transferServer)}/transactions/withdraw/interactive`;

  const res = await fetch(path, {
    method: "POST",
    // Do NOT set Content-Type — the browser sets it automatically with the
    // correct multipart boundary when the body is a FormData instance.
    headers: authHeaders(token),
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`SEP-24 ${kind} init failed (${res.status}): ${text}`);
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
  // SEP-24: GET /transaction?id=... returns { transaction: {...} }
  const url = `${proxyUrl(anchor.transferServer)}/transaction?id=${transactionId}`;

  for (let i = 0; i < maxAttempts; i++) {
    const res = await fetch(url, { headers: authHeaders(token) });
    if (!res.ok) {
      throw new Error(`SEP-24 poll failed (${res.status}): ${res.statusText}`);
    }
    const json = (await res.json()) as { transaction: Sep24Transaction };
    const tx = json.transaction ?? (json as unknown as Sep24Transaction);
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

/** Map anchor-specific field names onto the SEP-24 standard shape. */
function normalizeWithdrawTx(tx: Sep24Transaction): Sep24Transaction {
  const extra = tx as Sep24Transaction & Record<string, string | undefined>;
  return {
    ...tx,
    amount_in: tx.amount_in ?? extra.amount,
    withdraw_anchor_account:
      tx.withdraw_anchor_account ?? extra.to ?? extra.destination_account,
    withdraw_memo: tx.withdraw_memo ?? extra.memo,
    withdraw_memo_type:
      (tx.withdraw_memo_type ?? extra.memo_type ?? "id") as Sep24Transaction["withdraw_memo_type"],
  };
}

function buildWithdrawMemo(tx: Sep24Transaction): StellarSdk.Memo {
  const raw = tx.withdraw_memo ?? "";
  switch (tx.withdraw_memo_type) {
    case "text":
      return StellarSdk.Memo.text(raw);
    case "hash":
      return StellarSdk.Memo.hash(Buffer.from(raw, "hex"));
    case "return":
      return StellarSdk.Memo.return(raw);
    case "id":
    default:
      return StellarSdk.Memo.id(raw);
  }
}

/** Build unsigned classic payment XDR for SEP-24 withdraw (pending_user_transfer_start). */
async function buildWithdrawPaymentXdr(
  sourceAccount: string,
  anchor: AnchorConfig,
  rawTx: Sep24Transaction
): Promise<string> {
  const tx = normalizeWithdrawTx(rawTx);
  const destination = tx.withdraw_anchor_account;
  const amount = tx.amount_in?.replace(/\.0+$/, "") || tx.amount_in;
  if (!destination) {
    throw new Error("Anchor did not provide withdraw_anchor_account");
  }
  if (!amount) {
    throw new Error("Anchor did not provide amount_in for withdrawal payment");
  }
  if (!tx.withdraw_memo) {
    throw new Error("Anchor did not provide withdraw_memo for withdrawal payment");
  }

  const account = await horizon.loadAccount(sourceAccount);
  const asset = new StellarSdk.Asset(anchor.assetCode, anchor.assetIssuer);
  const payment = new StellarSdk.TransactionBuilder(account, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: config.networkPassphrase,
  })
    .addOperation(
      StellarSdk.Operation.payment({
        destination,
        asset,
        amount,
      })
    )
    .addMemo(buildWithdrawMemo(tx))
    .setTimeout(180)
    .build();

  return payment.toXDR();
}

/**
 * Poll a SEP-24 withdrawal until terminal state. When the anchor reaches
 * `pending_user_transfer_start`, prompt the wallet to send SRT (+ memo) to the
 * anchor — this step was previously missing, leaving the flow stuck forever.
 */
async function pollSep24Withdraw(
  anchor: AnchorConfig,
  token: string,
  transactionId: string,
  account: string,
  signXdr: (xdr: string) => Promise<string>,
  onStatus?: (message: string) => void,
  maxAttempts = 240
): Promise<Sep24Transaction> {
  const url = `${proxyUrl(anchor.transferServer)}/transaction?id=${transactionId}`;
  let paymentSubmitted = false;
  let paymentHash = "";

  for (let i = 0; i < maxAttempts; i++) {
    const res = await fetch(url, { headers: authHeaders(token) });
    if (!res.ok) {
      throw new Error(`SEP-24 poll failed (${res.status}): ${res.statusText}`);
    }
    const json = (await res.json()) as { transaction: Sep24Transaction };
    const tx = normalizeWithdrawTx(
      json.transaction ?? (json as unknown as Sep24Transaction)
    );
    // Once we've paid the anchor on-chain, the anchor still reports
    // `pending_user_transfer_start` until its payment observer credits the
    // incoming SRT. Don't revert the status to the pre-payment message — that
    // makes a successful, paid withdrawal look frozen. Show that we're waiting
    // on the anchor (a third-party testnet service) instead.
    if (paymentSubmitted) {
      onStatus?.(
        `Payment sent to anchor${paymentHash ? ` (${paymentHash.slice(0, 12)}…)` : ""} — ` +
        `waiting for the testnet anchor to credit fiat (may take a few minutes)…`
      );
    } else {
      onStatus?.(`Anchor status: ${tx.status}`);
    }

    if (
      tx.status === "pending_user_transfer_start" &&
      !paymentSubmitted
    ) {
      paymentSubmitted = true; // only one Freighter prompt per withdrawal
      onStatus?.(
        `Send ${tx.amount_in ?? "?"} ${anchor.assetCode} to anchor — approve in Freighter…`
      );
      try {
        const xdr = await buildWithdrawPaymentXdr(account, anchor, tx);
        const signed = await signXdr(xdr);
        const result = await submitTransaction(signed);
        paymentHash = result.hash;
        onStatus?.(
          `Payment submitted (${result.hash.slice(0, 12)}…) — waiting for anchor…`
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
          `SEP-24 anchor payment failed: ${msg}. ` +
          `Ensure Bob has an SRT trustline and at least ${tx.amount_in ?? "?"} SRT ` +
          `(complete Step 2 pool withdraw first).`
        );
      }
    }

    if (
      tx.status === "completed" ||
      tx.status === "error" ||
      tx.status === "refunded"
    ) {
      return tx;
    }

    await new Promise((r) => setTimeout(r, 2000));
  }

  if (paymentSubmitted) {
    throw new Error(
      `SRT payment to the anchor succeeded on-chain` +
      `${paymentHash ? ` (${paymentHash})` : ""}, but the testnet anchor has not ` +
      `marked the withdrawal completed yet. This is the third-party anchor crediting ` +
      `fiat and is outside this app — the off-ramp payment itself is done. Check the ` +
      `anchor's status later; no further action is needed in the wallet.`
    );
  }
  throw new Error(
    "SEP-24 withdrawal timed out before any payment was sent. If the status was " +
    "pending_user_transfer_start, ensure the SRT payment to the anchor was signed in Freighter."
  );
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
  /** Pre-opened blank popup (opened synchronously on user click to avoid popup blockers). */
  popup?: Window | null;
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

  // Redirect the pre-opened popup (or open a new one if none was provided).
  params.onStatus?.("Complete KYC in the anchor popup…");
  let popup: Window | null;
  if (params.popup && !params.popup.closed) {
    params.popup.location.href = initiated.url;
    popup = params.popup;
  } else {
    popup = openSep24Popup(initiated.url);
  }

  // Poll immediately — do not wait for the popup to close. Users often leave the
  // anchor "completed" screen open, which previously blocked the main page forever.
  params.onStatus?.("Waiting for anchor to complete deposit…");
  let transaction = await pollSep24Transaction(
    anchor,
    token,
    initiated.id,
    (tx) => params.onStatus?.(`Anchor status: ${tx.status}`)
  );

  if (transaction.status === "error") {
    const isLookupError =
      transaction.message?.includes(ANCHOR_TX_LOOKUP_ERROR) ||
      JSON.stringify(transaction).includes(ANCHOR_TX_LOOKUP_ERROR);

    if (isLookupError) {
      const recovered = await tryRecoverFromAnchorLookupError({
        anchor,
        token,
        transactionId: initiated.id,
        account: params.account,
        onStatus: params.onStatus,
      });
      if (recovered) {
        params.onStatus?.(
          `Deposit confirmed on-chain (${recovered.amount_out ?? "?"} ${anchor.assetCode}) — anchor UI showed a lookup error`
        );
        transaction = recovered;
      }
    }

    if (transaction.status === "error") {
      throw new Error(formatSep24Error("deposit", transaction));
    }
  }

  const popupClosed = popup?.closed ?? false;
  if (popup && !popup.closed) {
    try {
      popup.close();
    } catch {
      // ignore cross-origin close failures
    }
  }

  return { transaction, popupClosed };
}

export async function runSep24Withdraw(params: {
  account: string;
  signXdr: (xdr: string) => Promise<string>;
  amount: string;
  domain?: string;
  onStatus?: (message: string) => void;
  /** Pre-opened blank popup (opened synchronously on user click to avoid popup blockers). */
  popup?: Window | null;
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
  let popup: Window | null;
  if (params.popup && !params.popup.closed) {
    params.popup.location.href = initiated.url;
    popup = params.popup;
  } else {
    popup = openSep24Popup(initiated.url);
  }

  params.onStatus?.("Waiting for anchor to complete withdrawal…");
  const transaction = await pollSep24Withdraw(
    anchor,
    token,
    initiated.id,
    params.account,
    params.signXdr,
    params.onStatus
  );

  if (transaction.status === "error") {
    throw new Error(formatSep24Error("withdraw", transaction));
  }

  const popupClosed = popup?.closed ?? false;
  if (popup && !popup.closed) {
    try {
      popup.close();
    } catch {
      // ignore
    }
  }

  return { transaction, popupClosed };
}

export async function getSrtAsset(): Promise<StellarSdk.Asset> {
  const anchor = await getAnchorConfig();
  return new StellarSdk.Asset(anchor.assetCode, anchor.assetIssuer);
}

export function isTestnetNetwork(): boolean {
  return config.networkPassphrase === StellarSdk.Networks.TESTNET;
}
