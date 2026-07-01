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
  onStatus?.("Anchor reported a tx lookup error, rechecking status…");

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

export interface Sep24CustomerInfo {
  firstName?: string;
  lastName?: string;
  email?: string;
}

function appendInteractiveUrlParams(
  url: string,
  params: Record<string, string | undefined>
): string {
  try {
    const u = new URL(url);
    for (const [key, value] of Object.entries(params)) {
      if (value && !u.searchParams.has(key)) u.searchParams.set(key, value);
    }
    return u.toString();
  } catch {
    return url;
  }
}

async function startInteractiveTransaction(
  anchor: AnchorConfig,
  token: string,
  kind: "deposit" | "withdraw",
  account: string,
  opts?: { amount?: string; customer?: Sep24CustomerInfo }
): Promise<Sep24Transaction> {
  // SEP-24: POST with multipart/form-data (testanchor rejects url-encoded).
  //
  // IMPORTANT: do NOT include `amount` in the POST body. Testanchor validates
  // amounts upfront against its per-asset limits and returns a 400 if the value
  // exceeds them - even when the user hasn't confirmed anything yet. Instead we
  // only append `amount` to the returned interactive URL as a query param so the
  // anchor's own form pre-fills it without triggering the server-side guard.
  //
  // SEP-9 identity fields (first_name, last_name, email_address) are safe in the
  // POST body and are used to pre-fill the anchor's KYC form.
  const body = new FormData();
  body.append("asset_code", anchor.assetCode);
  body.append("asset_issuer", anchor.assetIssuer);
  body.append("account", account);
  if (opts?.customer?.firstName) body.append("first_name", opts.customer.firstName);
  if (opts?.customer?.lastName) body.append("last_name", opts.customer.lastName);
  if (opts?.customer?.email) body.append("email_address", opts.customer.email);

  const path =
    kind === "deposit"
      ? `${proxyUrl(anchor.transferServer)}/transactions/deposit/interactive`
      : `${proxyUrl(anchor.transferServer)}/transactions/withdraw/interactive`;

  const res = await fetch(path, {
    method: "POST",
    // Do NOT set Content-Type - the browser sets it automatically with the
    // correct multipart boundary when the body is a FormData instance.
    headers: authHeaders(token),
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`SEP-24 ${kind} init failed (${res.status}): ${text}`);
  }

  const tx = (await res.json()) as Sep24Transaction;
  if (tx.url) {
    tx.url = appendInteractiveUrlParams(tx.url, {
      amount: opts?.amount,
      first_name: opts?.customer?.firstName,
      last_name: opts?.customer?.lastName,
      email_address: opts?.customer?.email,
    });
  }
  return tx;
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
 * anchor, this step was previously missing, leaving the flow stuck forever.
 */
interface Sep24WithdrawPollResult {
  transaction: Sep24Transaction;
  paymentHash?: string;
  /** SRT was sent on-chain; anchor hasn't flipped to completed yet */
  anchorPending?: boolean;
}

async function pollSep24Withdraw(
  anchor: AnchorConfig,
  token: string,
  transactionId: string,
  account: string,
  signXdr: (xdr: string) => Promise<string>,
  onStatus?: (message: string) => void,
  opts?: {
    /** Called as soon as the on-chain anchor payment is submitted. */
    onPaymentSubmitted?: (hash: string) => void;
    maxAttempts?: number;
    /** After payment lands on-chain, only poll the anchor this many times (~2s each). */
    postPaymentAttempts?: number;
  }
): Promise<Sep24WithdrawPollResult> {
  const maxAttempts = opts?.maxAttempts ?? 240;
  const postPaymentAttempts = opts?.postPaymentAttempts ?? 15;
  const url = `${proxyUrl(anchor.transferServer)}/transaction?id=${transactionId}`;
  let paymentSubmitted = false;
  let paymentHash = "";
  let lastTx: Sep24Transaction | null = null;
  let postPaymentPolls = 0;

  for (let i = 0; i < maxAttempts; i++) {
    const res = await fetch(url, { headers: authHeaders(token) });
    if (!res.ok) {
      throw new Error(`SEP-24 poll failed (${res.status}): ${res.statusText}`);
    }
    const json = (await res.json()) as { transaction: Sep24Transaction };
    const tx = normalizeWithdrawTx(
      json.transaction ?? (json as unknown as Sep24Transaction)
    );
    lastTx = tx;
    // Once we've paid the anchor on-chain, the anchor still reports
    // `pending_user_transfer_start` until its payment observer credits the
    // incoming SRT. Don't revert the status to the pre-payment message - that
    // makes a successful, paid withdrawal look frozen. Show that we're waiting
    // on the anchor (a third-party testnet service) instead.
    if (paymentSubmitted) {
      onStatus?.(
        paymentHash
          ? `Off-ramp payment confirmed on-chain (${paymentHash.slice(0, 12)}…). ` +
            `You can close the anchor popup, the testnet bank UI does not auto-refresh. ` +
            `Simulated fiat credit may take a while on SDF's reference server.`
          : `Off-ramp payment confirmed on-chain. You can close the anchor popup.`
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
        `Send ${tx.amount_in ?? "?"} ${anchor.assetCode} to anchor, approve in Freighter…`
      );
      try {
        const xdr = await buildWithdrawPaymentXdr(account, anchor, tx);
        const signed = await signXdr(xdr);
        const result = await submitTransaction(signed);
        paymentHash = result.hash;
        opts?.onPaymentSubmitted?.(result.hash);
        onStatus?.(
          `Payment submitted (${result.hash.slice(0, 12)}…), confirming on-chain…`
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
      return { transaction: tx, paymentHash: paymentHash || undefined };
    }

    // Once we've paid on-chain, don't block the UI for the slow testnet observer.
    if (paymentSubmitted) {
      postPaymentPolls++;
      if (postPaymentPolls >= postPaymentAttempts) {
        onStatus?.(
          `Off-ramp complete on your side${paymentHash ? ` (${paymentHash.slice(0, 12)}…)` : ""}. ` +
          `The SDF testnet anchor has not marked this "completed" yet, that is normal. ` +
          `Close the anchor popup; no further wallet action needed.`
        );
        return {
          transaction: lastTx!,
          paymentHash: paymentHash || undefined,
          anchorPending: true,
        };
      }
    }

    await new Promise((r) => setTimeout(r, 2000));
  }

  if (paymentSubmitted && lastTx) {
    onStatus?.(
      `Off-ramp payment sent on-chain${paymentHash ? ` (${paymentHash.slice(0, 12)}…)` : ""}. ` +
      `The testnet anchor is still crediting fiat, your wallet work is done.`
    );
    return {
      transaction: lastTx,
      paymentHash: paymentHash || undefined,
      anchorPending: true,
    };
  }
  throw new Error(
    "SEP-24 withdrawal timed out before any payment was sent. If the status was " +
    "pending_user_transfer_start, ensure the SRT payment to the anchor was signed in Freighter."
  );
}

/**
 * Headless SEP-24 form submission: calls anchor-reference-server directly
 * so the user never sees the popup.
 *
 * Flow:
 *   1. Extract `?token=<SEP-10 JWT>` from the interactive URL.
 *   2. POST /start with that token → get a `sessionId`.
 *   3. POST /submit with the sessionId + form fields.
 *
 * Field names used by the testanchor reference UI: name, surname, email, amount.
 *
 * Returns true if the submission succeeded; callers fall back to popup on failure.
 */
async function tryHeadlessSubmit(
  interactiveUrl: string,
  fields: {
    amount?: string;
    name?: string;
    surname?: string;
    email?: string;
    bank?: string;
    account?: string;
  }
): Promise<boolean> {
  try {
    const u = new URL(interactiveUrl);

    // The interactive URL carries the raw SEP-10 JWT as ?token=...
    // If it already has a session_token we can use that directly.
    const rawToken =
      u.searchParams.get("token") ||
      u.searchParams.get("session_token") ||
      u.searchParams.get("session_");
    if (!rawToken) return false;

    // Exchange the SEP-10 JWT for a reference-server session ID.
    let sessionToken = rawToken;
    if (u.searchParams.has("token") && !u.searchParams.has("session_token")) {
      const startRes = await fetch("/api/anchor-ref/start", {
        method: "POST",
        headers: { Authorization: `Bearer ${rawToken}` },
      });
      if (!startRes.ok) return false;
      const { sessionId } = await startRes.json() as { sessionId?: string };
      if (!sessionId) return false;
      sessionToken = sessionId;
    }

    const body = JSON.stringify({
      amount:  fields.amount  ?? "",
      name:    fields.name    ?? "",
      surname: fields.surname ?? "",
      email:   fields.email   ?? "",
      ...(fields.bank    ? { bank: fields.bank }       : {}),
      ...(fields.account ? { account: fields.account } : {}),
    });

    const res = await fetch("/api/anchor-ref/submit", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${sessionToken}`,
      },
      body,
    });

    return res.ok;
  } catch {
    return false;
  }
}

/** @deprecated Use tryHeadlessSubmit */
async function tryHeadlessDeposit(
  interactiveUrl: string,
  opts: { amount?: string; customer?: Sep24CustomerInfo }
): Promise<boolean> {
  return tryHeadlessSubmit(interactiveUrl, {
    amount:  opts.amount,
    name:    opts.customer?.firstName,
    surname: opts.customer?.lastName,
    email:   opts.customer?.email,
  });
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

/**
 * Opens a 1×1 off-screen placeholder popup synchronously (during a user-gesture
 * handler) to reserve the popup slot and avoid popup blockers. After async work
 * finishes, call revealSep24Popup to resize and navigate it to the real URL.
 */
export function reserveSep24Popup(name = "sep24"): Window | null {
  return window.open("about:blank", name, "width=1,height=1,left=-200,top=-200");
}

export function revealSep24Popup(popup: Window | null, url: string): void {
  if (!popup || popup.closed) return;
  const width = 500;
  const height = 700;
  const left = window.screenX + (window.outerWidth - width) / 2;
  const top  = window.screenY + (window.outerHeight - height) / 2;
  try {
    popup.resizeTo(width, height);
    popup.moveTo(left, top);
    popup.location.href = url;
    popup.focus();
  } catch {
    // ignore cross-origin errors
  }
}

export interface Sep24FlowResult {
  transaction: Sep24Transaction;
  popupClosed: boolean;
  /** SRT sent to anchor; third-party anchor hasn't marked completed yet */
  anchorPending?: boolean;
  paymentHash?: string;
}

export async function runSep24Deposit(params: {
  account: string;
  signXdr: (xdr: string) => Promise<string>;
  amount?: string;
  customer?: Sep24CustomerInfo;
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
    { amount: params.amount, customer: params.customer }
  );

  if (!initiated.url) {
    throw new Error("SEP-24 deposit did not return an interactive URL");
  }

  // Try headless submission first: call anchor-reference-server /submit directly
  // so the user never sees the anchor popup. Falls back to popup if it fails.
  params.onStatus?.("Submitting deposit details to anchor…");
  const headless = await tryHeadlessDeposit(initiated.url, {
    amount: params.amount,
    customer: params.customer,
  });

  let popup: Window | null = null;

  if (!headless) {
    // Headless failed - fall back to the popup.
    params.onStatus?.("Opening anchor for manual KYC…");
    if (params.popup && !params.popup.closed) {
      params.popup.location.href = initiated.url;
      popup = params.popup;
    } else {
      popup = openSep24Popup(initiated.url);
    }
  } else {
    // Close the pre-opened blank tab - we won't need it.
    try { params.popup?.close(); } catch { /* ignore */ }
    params.onStatus?.("Deposit details submitted, waiting for anchor to confirm…");
  }

  // Poll immediately - do not wait for the popup to close. Users often leave the
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
          `Deposit confirmed on-chain (${recovered.amount_out ?? "?"} ${anchor.assetCode}), anchor UI showed a lookup error`
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
  customer?: Sep24CustomerInfo;
  domain?: string;
  onStatus?: (message: string) => void;
  /**
   * A 1×1 placeholder popup opened synchronously on the button click.
   * Pass this so the browser does not block the popup. It will be resized
   * and navigated to the anchor URL after Freighter signing completes.
   */
  reservedPopup?: Window | null;
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
    { amount: params.amount, customer: params.customer }
  );

  if (!initiated.url) {
    throw new Error("SEP-24 withdrawal did not return an interactive URL");
  }

  // Freighter has signed - now reveal the anchor popup with the real URL.
  params.onStatus?.("Opening bank anchor for withdrawal details…");
  let popup: Window | null;
  if (params.reservedPopup && !params.reservedPopup.closed) {
    revealSep24Popup(params.reservedPopup, initiated.url);
    popup = params.reservedPopup;
  } else {
    popup = openSep24Popup(initiated.url);
  }

  params.onStatus?.("Waiting for anchor to complete withdrawal…");
  const polled = await pollSep24Withdraw(
    anchor,
    token,
    initiated.id,
    params.account,
    params.signXdr,
    params.onStatus,
    {
      onPaymentSubmitted: () => {
        // The reference UI status page does not refresh - close it so the user
        // is not stuck staring at "waiting on the user to transfer funds".
        if (popup && !popup.closed) {
          try { popup.close(); } catch { /* ignore */ }
        }
      },
    }
  );

  if (polled.transaction.status === "error") {
    throw new Error(formatSep24Error("withdraw", polled.transaction));
  }

  const popupClosed = popup?.closed ?? false;
  if (popup && !popup.closed) {
    try {
      popup.close();
    } catch {
      // ignore
    }
  }

  return {
    transaction: polled.transaction,
    popupClosed,
    anchorPending: polled.anchorPending,
    paymentHash: polled.paymentHash,
  };
}

export async function getSrtAsset(): Promise<StellarSdk.Asset> {
  const anchor = await getAnchorConfig();
  return new StellarSdk.Asset(anchor.assetCode, anchor.assetIssuer);
}

export function isTestnetNetwork(): boolean {
  return config.networkPassphrase === StellarSdk.Networks.TESTNET;
}
