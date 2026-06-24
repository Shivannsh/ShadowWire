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
// shielded_transfer (6 signals):
//   [0] merkle_root        -- pool note-commitment tree root
//   [1] nullifier_hash     -- spend nullifier
//   [2] new_commitment_1   -- recipient note commitment
//   [3] new_commitment_2   -- change note commitment
//   [4] fee
//   [5] pub_asset_id

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
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function hexToBytes32(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/i, "").padStart(64, "0");
  return new Uint8Array(Buffer.from(clean, "hex"));
}

function fieldToBytes32(field: string): Uint8Array {
  const n = BigInt(field);
  return hexToBytes32(n.toString(16).padStart(64, "0"));
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
  input: DepositProofInput
): Promise<ComplianceProofBundle> {
  const data = await post<ComplianceProveResponse>("/api/prove/compliance", {
    amount: input.amount.toString(),
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
  commitment: string;
  newRoot:    string;
}

export async function proveDeposit(
  input: DepositNoteInput
): Promise<{ commitment: Uint8Array; newRoot: Uint8Array }> {
  const data = await post<DepositNoteResponse>("/api/prove/deposit", {
    ownerField: input.ownerField,
    value:      input.value,
    assetId:    input.assetId ?? "3",
    blinding:   input.blinding,
    secretKey:  input.secretKey,
  });

  return {
    commitment: hexToBytes32(data.commitment),
    newRoot:    hexToBytes32(data.newRoot),
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
    bobNote:        data.bobNote,
  };
}

// ---------------------------------------------------------------------------
// Withdrawal proof (full-value, no change)
// ---------------------------------------------------------------------------

interface WithdrawProveResponse {
  proof:          number[];
  pubSignals:     number[];
  publicSignals:  string[];
  spendNullifier: string;
  newCommitment1: string;
  newCommitment2: string;
  merkleRoot:     string;
  newRoot:        string;
}

export async function generateWithdrawProof(
  input: WithdrawProofInput
): Promise<ShieldedProofBundle> {
  const data = await post<WithdrawProveResponse>("/api/prove/withdraw", {
    ownerField: input.ownerField,
    value:      input.value,
    assetId:    input.assetId ?? "3",
    blinding:   input.blinding,
    secretKey:  input.secretKey,
    recipient:  input.recipient,
  });

  return {
    proof:          bytesFromArray(data.proof),
    pubSignals:     bytesFromArray(data.pubSignals),
    spendNullifier: fieldToBytes32(data.spendNullifier),
    newCommitment1: fieldToBytes32(data.newCommitment1),
    newCommitment2: fieldToBytes32(data.newCommitment2),
    merkleRoot:     fieldToBytes32(data.merkleRoot),
    newRoot:        hexToBytes32(data.newRoot),
  };
}

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

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
// Encode / decode note receipts (off-chain Alice -> Bob channel)
// ---------------------------------------------------------------------------

export function encodeNoteReceipt(note: NoteReceipt): string {
  return btoa(JSON.stringify(note));
}

export function decodeNoteReceipt(encoded: string): NoteReceipt {
  try {
    return JSON.parse(atob(encoded)) as NoteReceipt;
  } catch {
    throw new Error(
      "Invalid note receipt -- paste the full base64 string Alice provided"
    );
  }
}
