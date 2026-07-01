// ZK proof generation -- delegates to the ShadowWire mock-issuer proving server.
//
// Public signal layouts (keep in sync with circuit main.nr files):
//
// compliance (6 signals):
//   [0] merkle_root        -- KYC registry tree root
//   [1] corridor_id
//   [2] min_kyc_tier
//   [3] max_amount
//   [4] amount
//   [5] compliance_nullifier
//
// shielded_transfer (7 signals):
//   [0] merkle_root        -- pool note-commitment tree root
//   [1] nullifier_hash     -- spend nullifier
//   [2] new_commitment_1   -- recipient note commitment
//   [3] new_commitment_2   -- change note commitment
//   [4] fee
//   [5] pub_asset_id
//   [6] pub_withdraw_amount -- 0 = transfer mode (hidden); > 0 = withdraw mode (revealed)

const ISSUER_URL =
  process.env.NEXT_PUBLIC_MOCK_ISSUER_URL ?? "http://localhost:3001";

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface ComplianceProofBundle {
  proof:               Uint8Array;
  pubSignals:          Uint8Array;
  complianceNullifier: Uint8Array;
  merkleRoot:          Uint8Array;
}

export interface ShieldedProofBundle {
  proof:          Uint8Array;
  pubSignals:     Uint8Array;
  spendNullifier: Uint8Array;
  newCommitment1: Uint8Array;
  newCommitment2: Uint8Array;
  merkleRoot:     Uint8Array;
  newRoot:        Uint8Array;
  /** Operator ed25519 signature over newRoot (present when the issuer signs roots). */
  rootSignature?: Uint8Array;
}

/**
 * Withdraw proof bundle = shielded spend proof + off-ramp compliance proof.
 * Both are verified on-chain inside ShieldedPool.withdraw() (PRD §6.2).
 */
export interface WithdrawProofBundle extends ShieldedProofBundle {
  /** Groth16 compliance proof bytes (BN254, Soroban-encoded) */
  complianceProof:      Uint8Array;
  /** Compliance public signals bytes (Soroban-encoded) */
  compliancePubSignals: Uint8Array;
  /** Anti-replay nullifier for the off-ramp compliance attestation */
  complianceNullifier:  Uint8Array;
}

/** Everything Bob needs to spend his output note. */
export interface NoteReceipt {
  owner:      string;
  value:      string;
  assetId:    string;
  blinding:   string;
  secretKey:  string;
  commitment: string;
}

export interface DepositProofInput {
  amount:      bigint;
  corridorId?: number;
}

export interface DepositNoteInput {
  ownerField: string;  // BN254 Field derived from Stellar address
  value:      string;  // deposit amount as decimal string
  assetId?:   string;
  blinding:   string;  // random Field
  secretKey:  string;  // random Field
}

export interface TransferProofInput {
  ownerField:   string;
  value:        string;
  assetId?:     string;
  blinding:     string;
  secretKey:    string;
  recipient:    string;
  outputValue:  string;
  fee?:         string;
}

export interface WithdrawProofInput {
  ownerField:  string;
  value:       string;
  assetId?:    string;
  blinding:    string;
  secretKey:   string;
  recipient:   string;
  /** The exact on-chain commitment for this note (from the note receipt).
   *  Prevents input/output commitment formula mismatch. */
  commitment?: string;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function hexToBytes32(hex: string): Uint8Array {
  // Strip any number of leading 0x/0X prefixes (server can return "0x0xABCD...")
  let clean = String(hex).trim();
  while (clean.startsWith("0x") || clean.startsWith("0X")) clean = clean.slice(2);
  return new Uint8Array(Buffer.from(clean.padStart(64, "0"), "hex"));
}

/** Decode an arbitrary-length hex string (e.g. a 64-byte ed25519 signature). */
function hexToBytes(hex: string): Uint8Array {
  let clean = String(hex).trim();
  while (clean.startsWith("0x") || clean.startsWith("0X")) clean = clean.slice(2);
  if (clean.length % 2 !== 0) clean = "0" + clean;
  return new Uint8Array(Buffer.from(clean, "hex"));
}

function fieldToBytes32(field: string): Uint8Array {
  const s = String(field).trim();
  const stripped = s.startsWith("0x") || s.startsWith("0X") ? s.slice(2) : s;
  // If the string contains a–f it is already hex - no BigInt conversion needed
  if (/[a-fA-F]/.test(stripped)) {
    return hexToBytes32(stripped.padStart(64, "0"));
  }
  // Pure decimal field element - convert via BigInt
  return hexToBytes32(BigInt(s).toString(16).padStart(64, "0"));
}

function bytesFromArray(arr: number[]): Uint8Array {
  return new Uint8Array(arr);
}

async function post<T>(endpoint: string, body: unknown): Promise<T> {
  const res = await fetch(`${ISSUER_URL}${endpoint}`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify(body),
    cache:   "no-store",
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Proving server error (${res.status}): ${text}`);
  }
  return res.json() as Promise<T>;
}

async function get<T>(endpoint: string): Promise<T> {
  const res = await fetch(`${ISSUER_URL}${endpoint}`, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(
      `Issuer unavailable (${res.status}). Is mock-issuer running? npm run issuer`
    );
  }
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Compliance proof (dynamic amount, real Groth16)
// ---------------------------------------------------------------------------

interface ComplianceProveResponse {
  proof:               number[];
  pubSignals:          number[];
  publicSignals:       string[];
  complianceNullifier: string;
  merkleRoot:          string;
}

export async function generateComplianceProof(
  input: DepositProofInput & { ownerField?: string; attestationUid?: string }
): Promise<ComplianceProofBundle> {
  const data = await post<ComplianceProveResponse>("/api/prove/compliance", {
    amount:         input.amount.toString(),
    ownerField:     input.ownerField,
    attestationUid: input.attestationUid,
  });

  return {
    proof:               bytesFromArray(data.proof),
    pubSignals:          bytesFromArray(data.pubSignals),
    complianceNullifier: fieldToBytes32(data.complianceNullifier),
    merkleRoot:          fieldToBytes32(data.merkleRoot),
  };
}

// ---------------------------------------------------------------------------
// Deposit note pre-computation (commitment + new pool root)
// Must be called BEFORE buildDepositTx so the client has real values.
// ---------------------------------------------------------------------------

interface DepositNoteResponse {
  commitment:     string;
  newRoot:        string;
  rootSignature?: string;
}

export async function proveDeposit(
  input: DepositNoteInput
): Promise<{ commitment: Uint8Array; newRoot: Uint8Array; rootSignature?: Uint8Array }> {
  const data = await post<DepositNoteResponse>("/api/prove/deposit", {
    ownerField: input.ownerField,
    value:      input.value,
    assetId:    input.assetId ?? "3",
    blinding:   input.blinding,
    secretKey:  input.secretKey,
  });

  return {
    commitment:    hexToBytes32(data.commitment),
    newRoot:       hexToBytes32(data.newRoot),
    rootSignature: data.rootSignature ? hexToBytes(data.rootSignature) : undefined,
  };
}

// ---------------------------------------------------------------------------
// Shielded transfer proof (real Merkle path, fresh randomness)
// ---------------------------------------------------------------------------

interface TransferProveResponse {
  proof:          number[];
  pubSignals:     number[];
  publicSignals:  string[];
  spendNullifier: string;
  newCommitment1: string;
  newCommitment2: string;
  merkleRoot:     string;
  newRoot:        string;
  rootSignature?: string;
  bobNote:        NoteReceipt;
}

export async function generateShieldedTransferProof(
  input: TransferProofInput
): Promise<ShieldedProofBundle & { bobNote: NoteReceipt }> {
  const data = await post<TransferProveResponse>("/api/prove/transfer", {
    ownerField:   input.ownerField,
    value:        input.value,
    assetId:      input.assetId ?? "3",
    blinding:     input.blinding,
    secretKey:    input.secretKey,
    recipient:    input.recipient,
    outputValue1: input.outputValue,
    fee:          input.fee ?? "0",
  });

  return {
    proof:          bytesFromArray(data.proof),
    pubSignals:     bytesFromArray(data.pubSignals),
    spendNullifier: fieldToBytes32(data.spendNullifier),
    newCommitment1: fieldToBytes32(data.newCommitment1),
    newCommitment2: fieldToBytes32(data.newCommitment2),
    merkleRoot:     fieldToBytes32(data.merkleRoot),
    newRoot:        hexToBytes32(data.newRoot),
    rootSignature:  data.rootSignature ? hexToBytes(data.rootSignature) : undefined,
    bobNote:        data.bobNote,
  };
}

// ---------------------------------------------------------------------------
// Withdrawal proof (full-value, no change)
// ---------------------------------------------------------------------------

interface WithdrawProveResponse {
  // Shielded spend proof
  proof:          number[];
  pubSignals:     number[];
  publicSignals:  string[];
  spendNullifier: string;
  newCommitment1: string;
  newCommitment2: string;
  merkleRoot:     string;
  newRoot:        string;
  rootSignature?: string;
  // Compliance proof for the off-ramp edge (PRD §6.2)
  complianceProof:         number[];
  compliancePubSignals:    number[];
  compliancePublicSignals: string[];
  complianceNullifier:     string;
}

export async function generateWithdrawProof(
  input: WithdrawProofInput & { attestationUid?: string }
): Promise<WithdrawProofBundle> {
  const data = await post<WithdrawProveResponse>("/api/prove/withdraw", {
    ownerField:     input.ownerField,
    value:          input.value,
    assetId:        input.assetId ?? "3",
    blinding:       input.blinding,
    secretKey:      input.secretKey,
    recipient:      input.recipient,
    commitment:     input.commitment,
    attestationUid: input.attestationUid,
  });

  return {
    // Shielded spend proof
    proof:          bytesFromArray(data.proof),
    pubSignals:     bytesFromArray(data.pubSignals),
    spendNullifier: fieldToBytes32(data.spendNullifier),
    newCommitment1: fieldToBytes32(data.newCommitment1),
    newCommitment2: fieldToBytes32(data.newCommitment2),
    merkleRoot:     fieldToBytes32(data.merkleRoot),
    newRoot:        hexToBytes32(data.newRoot),
    rootSignature:  data.rootSignature ? hexToBytes(data.rootSignature) : undefined,
    // Compliance proof for off-ramp KYC gate
    complianceProof:      bytesFromArray(data.complianceProof),
    compliancePubSignals: bytesFromArray(data.compliancePubSignals),
    complianceNullifier:  fieldToBytes32(data.complianceNullifier),
  };
}

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

export interface CorridorInfo {
  id:         number;
  sending:    { country: string; countryCode: string };
  receiving:  { country: string; countryCode: string };
  minKycTier: number;
  maxAmount:  string;
  /** "registry" = per-user cross-border KYC active; "demo" = legacy single leaf. */
  kycMode:    string;
}

export async function loadCorridor(): Promise<CorridorInfo> {
  return get<CorridorInfo>("/api/corridor");
}

export async function loadAttestationMetadata(): Promise<{
  corridorId: number; minKycTier: number; maxAmount: bigint;
}> {
  const att = await get<{
    corridorId: string; minKycTier: number; maxAmount: string;
  }>("/api/attestation");
  return {
    corridorId: Number(att.corridorId),
    minKycTier: att.minKycTier,
    maxAmount:  BigInt(att.maxAmount),
  };
}

// ---------------------------------------------------------------------------
// Encode / decode note receipts (off-chain Buyer -> Seller channel)
//
// Notes carry spend authority (the note secretKey), so the receipt is a bearer
// instrument. The preferred channel is `sealNoteReceipt`, which encrypts the note
// to the Seller's receiving key (see lib/noteCrypto). `decodeNoteReceipt` accepts
// both the sealed format and the legacy plaintext base64 for backward compat.
// ---------------------------------------------------------------------------

import { isSealedNote, openSealedNote, sealNoteToRecipient } from "./noteCrypto";

/** Legacy plaintext encoding, kept only for backward compatibility. */
export function encodeNoteReceipt(note: NoteReceipt): string {
  return btoa(JSON.stringify(note));
}

/** Preferred: encrypt+authenticate the note to the Seller's receiving key. */
export function sealNoteReceipt(note: NoteReceipt, recipientReceivingKey: string): string {
  return sealNoteToRecipient(note, recipientReceivingKey);
}

export function decodeNoteReceipt(encoded: string): NoteReceipt {
  const trimmed = encoded.trim();
  if (isSealedNote(trimmed)) {
    return openSealedNote(trimmed);
  }
  try {
    return JSON.parse(atob(trimmed)) as NoteReceipt;
  } catch {
    throw new Error(
      "Invalid note receipt, paste the sealed package (SWNOTE1.…) the sender sent you"
    );
  }
}
