/**
 * ZK proof bundles — fetched from mock-issuer (pre-generated Groth16 artifacts).
 * Stretch: client-side snarkjs in browser via /api/proofs/generate.
 */

const ISSUER_URL =
  process.env.NEXT_PUBLIC_MOCK_ISSUER_URL ?? "http://localhost:3001";

export interface ComplianceProofBundle {
  proof: Uint8Array;
  pubSignals: Uint8Array;
}

export interface ShieldedProofBundle {
  proof: Uint8Array;
  pubSignals: Uint8Array;
}

export interface Note {
  ownerPubkey: Uint8Array;
  value: bigint;
  assetId: Uint8Array;
  blindingFactor: Uint8Array;
  secretKey: Uint8Array;
}

export interface DepositProofInput {
  amount: bigint;
  merkleRoot: Uint8Array;
  corridorId: number;
  minKycTier: number;
  maxAmount: bigint;
}

export interface TransferProofInput {
  inputNote: Note;
  merklePath: Uint8Array[];
  merkleRoot: Uint8Array;
  recipientPubkey: Uint8Array;
  outputValue: bigint;
  fee?: bigint;
}

export interface WithdrawProofInput {
  inputNote: Note;
  merklePath: Uint8Array[];
  merkleRoot: Uint8Array;
  amount: bigint;
}

interface ProofApiResponse {
  proof: number[];
  pubSignals: number[];
  inputs?: Record<string, string>;
}

interface DemoNoteResponse {
  inputCommitment: string;
  merkleRoot: string;
  nullifierHash: string;
  newCommitment: string;
  fee: string;
  inputCommitmentNote: {
    owner: string;
    value: string;
    assetId: string;
    blinding: string;
    secretKey: string;
  };
}

function bytesFromApi(arr: number[]): Uint8Array {
  return new Uint8Array(arr);
}

function hexToBytes32(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/i, "");
  const buf = Buffer.from(clean.padStart(64, "0"), "hex");
  if (buf.length !== 32) {
    throw new Error(`Expected 32 bytes, got ${buf.length}`);
  }
  return new Uint8Array(buf);
}

async function fetchProof(circuit: "compliance" | "shielded_transfer"): Promise<ProofApiResponse> {
  const res = await fetch(`${ISSUER_URL}/api/proofs/${circuit}`, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(
      `Proof service unavailable (${res.status}). Start mock-issuer: npm run issuer`
    );
  }
  return res.json() as Promise<ProofApiResponse>;
}

async function fetchDemoNote(): Promise<DemoNoteResponse> {
  const res = await fetch(`${ISSUER_URL}/api/demo-note`, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`Demo note unavailable (${res.status})`);
  }
  return res.json() as Promise<DemoNoteResponse>;
}

export async function generateComplianceProof(
  _input: DepositProofInput
): Promise<ComplianceProofBundle> {
  const data = await fetchProof("compliance");
  return {
    proof: bytesFromApi(data.proof),
    pubSignals: bytesFromApi(data.pubSignals),
  };
}

export async function generateShieldedTransferProof(
  _input: TransferProofInput
): Promise<ShieldedProofBundle> {
  const data = await fetchProof("shielded_transfer");
  return {
    proof: bytesFromApi(data.proof),
    pubSignals: bytesFromApi(data.pubSignals),
  };
}

export async function generateWithdrawProof(
  _input: WithdrawProofInput
): Promise<ShieldedProofBundle> {
  // MVP: same circuit bundle as transfer (burn output note)
  return generateShieldedTransferProof({
    inputNote: _input.inputNote,
    merklePath: _input.merklePath,
    merkleRoot: _input.merkleRoot,
    recipientPubkey: new Uint8Array(32),
    outputValue: BigInt(0),
  });
}

export async function loadDemoNoteForAlice(ownerAddress: string): Promise<{
  note: Note;
  commitment: Uint8Array;
  merkleRoot: Uint8Array;
  nullifier: Uint8Array;
  newCommitment: Uint8Array;
}> {
  const demo = await fetchDemoNote();
  const n = demo.inputCommitmentNote;
  const note: Note = {
    ownerPubkey: new TextEncoder().encode(ownerAddress.slice(0, 32).padEnd(32, "0")),
    value: BigInt(n.value),
    assetId: hexToBytes32("0".repeat(64)),
    blindingFactor: hexToBytes32(n.blinding.padStart(64, "0")),
    secretKey: hexToBytes32(n.secretKey.padStart(64, "0")),
  };
  return {
    note,
    commitment: hexToBytes32(demo.inputCommitment),
    merkleRoot: hexToBytes32(demo.merkleRoot),
    nullifier: hexToBytes32(demo.nullifierHash),
    newCommitment: hexToBytes32(demo.newCommitment),
  };
}

export async function loadDemoTransferFields(): Promise<{
  nullifier: Uint8Array;
  newCommitment: Uint8Array;
  merkleRoot: Uint8Array;
}> {
  const demo = await fetchDemoNote();
  return {
    nullifier: hexToBytes32(demo.nullifierHash),
    newCommitment: hexToBytes32(demo.newCommitment),
    merkleRoot: hexToBytes32(demo.merkleRoot),
  };
}

export function computeNoteCommitment(_note: Note): Uint8Array {
  // Demo uses precomputed commitment from circuit witness (see mock-issuer /api/demo-note)
  throw new Error("Use loadDemoNoteForAlice() for demo commitments");
}

export function computeNullifier(note: Note, commitment: Uint8Array): Uint8Array {
  void note;
  return commitment;
}

export function randomNoteSecret(): Uint8Array {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  return buf;
}

export function encodeBytes(val: Uint8Array): Buffer {
  return Buffer.from(val);
}
