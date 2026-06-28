/**
 * KYC on-chain attestations via AttestProtocol (Stellar's EAS-equivalent).
 *
 * This module turns the issuer into a real KYC *authority*: it issues
 * **delegated** attestations on the AttestProtocol "protocol" contract that say
 * "this wallet (subject) has passed KYC", signed by the authority's BLS key.
 * The ShieldedPool later verifies these attestations on-chain via a
 * cross-contract get_attestation() call (subject == caller, attester ==
 * authority, schema == KYC schema, not revoked, not expired).
 *
 * Why we re-implement the message / UID instead of using the SDK's builders:
 * the deployed contract (commit b242b5b) is NEWER than the published
 * @attestprotocol/stellar-sdk v2.0.2 — it binds the contract id + network +
 * subject/value hashes into the BLS preimage (HAL-06), whereas the published
 * SDK builds an older, simpler preimage. So we construct the preimage to match
 * the contract's `create_attestation_message` / `generate_attestation_uid`
 * byte-for-byte, and reuse @noble only for the curve operations (which DO match:
 * BLS min-sig, G1 hash-to-curve DST "BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_").
 *
 * Trust model: a single KYC authority (the `kyc_authority` address in
 * testnet-addresses.json). Honest and explicit — same as a real regulated
 * issuer, but now the credential is on-chain, queryable, and revocable.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

import {
  Address,
  Keypair,
  Networks,
  TransactionBuilder,
  hash as sha256,
  nativeToScVal,
} from "@stellar/stellar-sdk";
import { bls12_381 } from "@noble/curves/bls12-381.js";
import sha3 from "js-sha3";

// The @attestprotocol/stellar-sdk ESM build has a broken `import { keccak256 }
// from 'js-sha3'` that Node's ESM loader rejects (js-sha3 is CJS). Load the
// SDK's CommonJS build instead, which uses require() internally and works.
const require = createRequire(import.meta.url);
const {
  StellarAttestationClient,
  generateBlsKeys,
  getAttesterNonce,
} = require("@attestprotocol/stellar-sdk") as typeof import("@attestprotocol/stellar-sdk");

const { keccak_256 } = sha3 as unknown as { keccak_256: (msg: Uint8Array) => string };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, "../..");
const ADDRS     = path.join(ROOT, "testnet-addresses.json");

const RPC_URL    = process.env.SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org";
const NETWORK_PASSPHRASE = Networks.TESTNET;
const FRIENDBOT  = "https://friendbot.stellar.org";

// Must byte-match contracts/external delegation.rs ATTEST_DOMAIN_SEPARATOR.
const ATTEST_DOMAIN_SEPARATOR = Buffer.from("ATTEST_PROTOCOL_V1_DELEGATED", "utf8");
// Versioned UID prefix — must match utils.rs generate_attestation_uid.
const ATTEST_UID_PREFIX = Buffer.from("ATTEST_UID_V1", "utf8");

const BLS_KEY_FILE       = path.join(__dirname, "..", ".kyc-bls-key.json");
const SUBMITTER_KEY_FILE = path.join(__dirname, "..", ".kyc-submitter-key.json");
const ATTEST_DB_FILE     = path.join(__dirname, "..", ".kyc-attestations.json");

// ---------------------------------------------------------------------------
// Config (from testnet-addresses.json, written by deploy-attest-protocol.mjs)
// ---------------------------------------------------------------------------

export interface AttestConfig {
  protocol:     string; // AttestProtocol contract id
  authority:    string; // KYC authority (attester) G-address
  schemaUid:    Buffer; // 32-byte KYC schema UID
  schemaDef:    string;
}

export function loadAttestConfig(): AttestConfig | null {
  const a = JSON.parse(fs.readFileSync(ADDRS, "utf8"));
  const at = a.attestation;
  const protocol = a?.contracts?.attest_protocol ?? at?.protocol;
  if (!at || !protocol || !at.kyc_authority || !at.kyc_schema_uid) return null;
  return {
    protocol,
    authority: at.kyc_authority,
    schemaUid: Buffer.from(String(at.kyc_schema_uid).replace(/^0x/, ""), "hex"),
    schemaDef: at.kyc_schema_def ?? "",
  };
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

/** Issuer-owned BLS keypair (the authority's signing key). Persisted, gitignored. */
export function loadBlsKeypair(): { privateKey: Buffer; publicKey: Buffer } {
  if (fs.existsSync(BLS_KEY_FILE)) {
    const j = JSON.parse(fs.readFileSync(BLS_KEY_FILE, "utf8"));
    return {
      privateKey: Buffer.from(j.privateKey, "base64"),
      publicKey:  Buffer.from(j.publicKey, "base64"),
    };
  }
  const k = generateBlsKeys();
  const priv = Buffer.from(k.privateKey);
  const pub  = Buffer.from(k.publicKey);
  fs.writeFileSync(
    BLS_KEY_FILE,
    JSON.stringify({ privateKey: priv.toString("base64"), publicKey: pub.toString("base64") }, null, 2),
  );
  return { privateKey: priv, publicKey: pub };
}

export function getBlsPublicKeyHex(): string {
  return loadBlsKeypair().publicKey.toString("hex");
}

/** Dedicated Stellar account that submits delegated attestations (pays gas only). */
export function loadSubmitterKeypair(): Keypair {
  if (fs.existsSync(SUBMITTER_KEY_FILE)) {
    const { secret } = JSON.parse(fs.readFileSync(SUBMITTER_KEY_FILE, "utf8"));
    return Keypair.fromSecret(secret);
  }
  const kp = Keypair.random();
  fs.writeFileSync(SUBMITTER_KEY_FILE, JSON.stringify({ secret: kp.secret(), public: kp.publicKey() }, null, 2));
  return kp;
}

export async function ensureSubmitterFunded(): Promise<string> {
  const kp = loadSubmitterKeypair();
  try {
    const res = await fetch(`${FRIENDBOT}?addr=${encodeURIComponent(kp.publicKey())}`);
    // 400 = already funded; ignore.
    void res;
  } catch { /* best-effort */ }
  return kp.publicKey();
}

// ---------------------------------------------------------------------------
// Message / UID construction (must match the deployed contract byte-for-byte)
// ---------------------------------------------------------------------------

function u64be(n: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(n);
  return b;
}

/** XDR of an Address ScVal (matches Address.to_xdr() in the contract). */
function addrXdr(g: string): Buffer {
  return Buffer.from(new Address(g).toScVal().toXDR());
}

/**
 * Build the 32-byte attestation message hash, matching delegation.rs
 * create_attestation_message:
 *   DST || sha256(contract_xdr) || network_id || schema_uid ||
 *   sha256(subject_xdr) || nonce_be || deadline_be || [exp_be] || sha256(value_xdr)
 * then sha256 of the whole thing.
 */
export function buildAttestMessageHash(p: {
  contractId: string;
  schemaUid: Buffer;
  subject: string;
  nonce: bigint;
  deadline: bigint;
  expirationTime?: bigint;
  value: string;
}): Buffer {
  const networkId = sha256(Buffer.from(NETWORK_PASSPHRASE, "utf8")); // env.ledger().network_id()
  const valueXdr  = Buffer.from(nativeToScVal(p.value, { type: "string" }).toXDR());

  const parts: Buffer[] = [
    ATTEST_DOMAIN_SEPARATOR,
    sha256(addrXdr(p.contractId)),
    networkId,
    p.schemaUid,
    sha256(addrXdr(p.subject)),
    u64be(p.nonce),
    u64be(p.deadline),
  ];
  if (p.expirationTime !== undefined) parts.push(u64be(p.expirationTime));
  parts.push(sha256(valueXdr));

  return sha256(Buffer.concat(parts));
}

/**
 * Deterministic attestation UID, matching utils.rs generate_attestation_uid:
 *   keccak256("ATTEST_UID_V1" || contract_xdr || schema_uid_xdr ||
 *             subject_xdr || attester_xdr || nonce_be)
 * Note: schema_uid is XDR-encoded here (scvBytes), unlike in the message above.
 */
export function computeAttestationUid(p: {
  contractId: string;
  schemaUid: Buffer;
  subject: string;
  attester: string;
  nonce: bigint;
}): Buffer {
  const preimage = Buffer.concat([
    ATTEST_UID_PREFIX,
    addrXdr(p.contractId),
    Buffer.from(nativeToScVal(p.schemaUid).toXDR()),
    addrXdr(p.subject),
    addrXdr(p.attester),
    u64be(p.nonce),
  ]);
  return Buffer.from(keccak_256(preimage), "hex");
}

/** Sign the message hash → 96-byte uncompressed G1 signature (contract format).
 *
 * Both hash and sign use the SAME bls12_381 instance so the curve Point class
 * matches (mixing two @noble/curves copies throws "expected valid message
 * hashed to G1 curve"). hash-to-G1 uses DST
 * BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_, which equals the contract's
 * ATTEST_PROTOCOL_BLS_G1_DST. */
export function signAttestationMessage(messageHash: Buffer, blsPrivateKey: Buffer): Buffer {
  const point = bls12_381.shortSignatures.hash(messageHash);
  const sig = bls12_381.shortSignatures.sign(point, Uint8Array.from(blsPrivateKey));
  return Buffer.from(sig.toBytes(false));
}

// ---------------------------------------------------------------------------
// Attestation store (wallet -> uid), so status survives issuer restarts
// ---------------------------------------------------------------------------

interface AttestRecord {
  subject: string;
  side?: string;
  uid: string;       // hex
  txHash?: string;
  tier: number;
  country: number;
  issuedAt: number;
}

function loadDb(): Record<string, AttestRecord> {
  if (!fs.existsSync(ATTEST_DB_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(ATTEST_DB_FILE, "utf8")); } catch { return {}; }
}
function saveDb(db: Record<string, AttestRecord>) {
  fs.writeFileSync(ATTEST_DB_FILE, JSON.stringify(db, null, 2));
}

// ---------------------------------------------------------------------------
// Client + signer
// ---------------------------------------------------------------------------

function makeClient(callerPublicKey: string): InstanceType<typeof StellarAttestationClient> {
  const cfg = loadAttestConfig();
  if (!cfg) throw new Error("AttestProtocol not configured (run deploy-attest-protocol.mjs)");
  return new StellarAttestationClient({
    rpcUrl: RPC_URL,
    network: "testnet",
    publicKey: callerPublicKey,
    contractId: cfg.protocol,
  });
}

function submitterSigner(kp: Keypair) {
  return {
    signTransaction: async (xdr: string) => {
      const tx = TransactionBuilder.fromXDR(xdr, NETWORK_PASSPHRASE);
      tx.sign(kp);
      return tx.toXDR();
    },
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface EnrollResult {
  attestationUid: string; // hex
  txHash?: string;
  subject: string;
  attester: string;
  schemaUid: string;
  tier: number;
  country: number;
}

/**
 * Issue a delegated KYC attestation about `subject`, signed by the authority's
 * BLS key, submitted (gas paid) by the dedicated submitter account.
 */
export async function enrollKyc(subject: string, opts: { tier: number; country: number; side?: string; expiresDays?: number }): Promise<EnrollResult> {
  const cfg = loadAttestConfig();
  if (!cfg) throw new Error("AttestProtocol not configured");

  const bls       = loadBlsKeypair();
  const submitter = loadSubmitterKeypair();
  await ensureSubmitterFunded();

  const client = makeClient(submitter.publicKey());
  const proto  = client.getClientInstance();

  const nonce      = await getAttesterNonce(proto as any, cfg.authority);
  const nowSec     = Math.floor(Date.now() / 1000);
  const deadline   = BigInt(nowSec + 600);                                   // sig submission window
  const expiresSec = BigInt(nowSec + (opts.expiresDays ?? 365) * 86400);     // attestation validity
  const value      = JSON.stringify({ verified: true, tier: opts.tier, country: opts.country });

  const messageHash = buildAttestMessageHash({
    contractId: cfg.protocol,
    schemaUid:  cfg.schemaUid,
    subject,
    nonce,
    deadline,
    expirationTime: expiresSec,
    value,
  });
  const signature = signAttestationMessage(messageHash, bls.privateKey);

  const request = {
    schema_uid:      cfg.schemaUid,
    subject,
    attester:        cfg.authority,
    value,
    nonce,
    deadline,
    expiration_time: expiresSec,
    signature,
    type:            "attest" as const,
  };

  const result = await client.attestByDelegation(request as any, { signer: submitterSigner(submitter) });
  const txHash = result?.hash ?? result?.txHash ?? undefined;

  const uid = computeAttestationUid({
    contractId: cfg.protocol,
    schemaUid:  cfg.schemaUid,
    subject,
    attester:   cfg.authority,
    nonce,
  });

  const db = loadDb();
  db[subject] = {
    subject, side: opts.side, uid: uid.toString("hex"), txHash,
    tier: opts.tier, country: opts.country, issuedAt: nowSec,
  };
  saveDb(db);

  return {
    attestationUid: uid.toString("hex"),
    txHash,
    subject,
    attester: cfg.authority,
    schemaUid: cfg.schemaUid.toString("hex"),
    tier: opts.tier,
    country: opts.country,
  };
}

export interface KycStatus {
  configured: boolean;
  address: string;
  verified: boolean;
  attestationUid?: string;
  attester?: string;
  schemaUid?: string;
  tier?: number;
  country?: number;
  revoked?: boolean;
  onChain?: boolean;
}

/** Look up KYC status for a wallet: local record + live get_attestation read. */
export async function getKycStatus(address: string): Promise<KycStatus> {
  const cfg = loadAttestConfig();
  if (!cfg) return { configured: false, address, verified: false };

  const db  = loadDb();
  const rec = db[address];
  if (!rec) {
    return { configured: true, address, verified: false, attester: cfg.authority, schemaUid: cfg.schemaUid.toString("hex") };
  }

  // Verify it still exists + isn't revoked on-chain.
  let onChain = false, revoked = false;
  try {
    const client = makeClient(loadSubmitterKeypair().publicKey());
    const att = await client.getAttestation(Buffer.from(rec.uid, "hex"));
    const decoded = att?.result ?? att?.returnValue ?? att;
    onChain = !!decoded;
    revoked = !!(decoded?.revoked);
  } catch { onChain = false; }

  return {
    configured: true,
    address,
    verified: onChain && !revoked,
    attestationUid: rec.uid,
    attester: cfg.authority,
    schemaUid: cfg.schemaUid.toString("hex"),
    tier: rec.tier,
    country: rec.country,
    revoked,
    onChain,
  };
}
