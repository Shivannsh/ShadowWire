import * as StellarSdk from "@stellar/stellar-sdk";
import { invokeContract, readContract } from "@/lib/transactions";
import { getShieldedPoolContractId } from "@/lib/addresses";
import type { ComplianceProofBundle, ShieldedProofBundle, WithdrawProofBundle } from "@/lib/proofs";

function addressScVal(addr: string): StellarSdk.xdr.ScVal {
  return StellarSdk.Address.fromString(addr).toScVal();
}

function bytesN32ScVal(bytes: Uint8Array): StellarSdk.xdr.ScVal {
  if (bytes.length !== 32) {
    throw new Error(`Expected 32-byte value, got ${bytes.length}`);
  }
  return StellarSdk.xdr.ScVal.scvBytes(Buffer.from(bytes));
}

function bytesN64ScVal(bytes: Uint8Array): StellarSdk.xdr.ScVal {
  if (bytes.length !== 64) {
    throw new Error(`Expected 64-byte signature, got ${bytes.length}`);
  }
  return StellarSdk.xdr.ScVal.scvBytes(Buffer.from(bytes));
}

function bytesScVal(bytes: Uint8Array): StellarSdk.xdr.ScVal {
  return StellarSdk.xdr.ScVal.scvBytes(Buffer.from(bytes));
}

/**
 * Whether the deployed pool expects an operator-signed root (v9+). When enabled,
 * each state-changing call carries a 64-byte ed25519 signature over the new root
 * right after the `new_root` argument. Defaults off so the original v8 pool (no
 * signature parameter) keeps working without changes.
 */
const POOL_SIGNED_ROOT =
  process.env.NEXT_PUBLIC_POOL_SIGNED_ROOT === "true";

function rootSigArgs(signature?: Uint8Array): StellarSdk.xdr.ScVal[] {
  if (!POOL_SIGNED_ROOT) return [];
  if (!signature) {
    throw new Error(
      "NEXT_PUBLIC_POOL_SIGNED_ROOT is enabled but no root signature was provided " +
        "by the proving server. Update the mock-issuer to return rootSignature."
    );
  }
  return [bytesN64ScVal(signature)];
}

/**
 * Whether the deployed pool enforces an on-chain AttestProtocol KYC attestation
 * (v10+). When enabled, deposit()/withdraw() take a trailing 32-byte attestation
 * UID that the pool verifies via a cross-contract get_attestation() call.
 * Defaults off so v9 pools keep working unchanged.
 */
const POOL_KYC_ATTEST =
  process.env.NEXT_PUBLIC_POOL_KYC_ATTEST === "true";

function kycAttestArgs(attestationUid?: Uint8Array): StellarSdk.xdr.ScVal[] {
  if (!POOL_KYC_ATTEST) return [];
  if (!attestationUid) {
    throw new Error(
      "NEXT_PUBLIC_POOL_KYC_ATTEST is enabled but no KYC attestation UID was provided. " +
        "Enroll the wallet via the issuer (POST /api/kyc/enroll) first."
    );
  }
  return [bytesN32ScVal(attestationUid)];
}

function i128ScVal(value: bigint): StellarSdk.xdr.ScVal {
  return StellarSdk.nativeToScVal(value, { type: "i128" });
}

async function requirePoolContract(): Promise<string> {
  const id = await getShieldedPoolContractId();
  if (!id) {
    throw new Error(
      "ShieldedPool contract not configured. Set NEXT_PUBLIC_SHIELDED_POOL_CONTRACT or update testnet-addresses.json"
    );
  }
  return id;
}

export async function getPoolRoot(): Promise<Uint8Array> {
  const contractId = await requirePoolContract();
  const root = await readContract<Buffer>(contractId, "get_root");
  return new Uint8Array(root);
}

export async function getPoolCommitmentCount(): Promise<number> {
  const contractId = await requirePoolContract();
  return readContract<number>(contractId, "commitment_count");
}

/** Human-readable pool root, all-zero is the empty-tree initial state, not an error. */
export function formatPoolRoot(hex: string | null, noteCount?: number | null): string {
  if (!hex) return "...";
  const notes = noteCount ?? 0;
  if (/^0+$/.test(hex)) {
    return notes === 0 ? "Empty pool · 0 notes" : `Initial · ${notes} notes`;
  }
  return `${hex.slice(0, 14)}… · ${notes} notes`;
}

export async function isNullifierSpent(nullifier: Uint8Array): Promise<boolean> {
  const contractId = await requirePoolContract();
  return readContract<boolean>(contractId, "is_nullifier_spent", [
    bytesN32ScVal(nullifier),
  ]);
}

export interface DepositParams {
  depositor: string;
  amount: string;
  commitment: Uint8Array;
  newRoot: Uint8Array;
  /** Anti-replay compliance nullifier (stored on-chain after use) */
  complianceNullifier: Uint8Array;
  complianceProof: ComplianceProofBundle;
  /** Operator ed25519 signature over the new root (required when POOL_SIGNED_ROOT). */
  rootSignature?: Uint8Array;
  /** AttestProtocol KYC attestation UID (required when POOL_KYC_ATTEST). */
  kycAttestationUid?: Uint8Array;
}

/**
 * Build a deposit() transaction.
 *
 * amount is a raw integer string, the same value used in the compliance proof
 * and the shielded note.  Do NOT convert to stroops here; the compliance circuit
 * uses this exact value for its amount signal, and the contract's AmountMismatch
 * check compares signal[4] against the i128 passed to deposit().  Both must be
 * in the same unit.
 */
export async function buildDepositTx(params: DepositParams): Promise<string> {
  const contractId = await requirePoolContract();
  // Use the raw numeric amount (same unit as the compliance proof signal[4])
  const amount = BigInt(params.amount);

  return invokeContract(params.depositor, contractId, "deposit", [
    addressScVal(params.depositor),
    i128ScVal(amount),
    bytesN32ScVal(params.commitment),
    bytesN32ScVal(params.newRoot),
    ...rootSigArgs(params.rootSignature),
    bytesN32ScVal(params.complianceNullifier),
    bytesScVal(params.complianceProof.proof),
    bytesScVal(params.complianceProof.pubSignals),
    ...kycAttestArgs(params.kycAttestationUid),
  ]);
}

export interface TransferParams {
  sender: string;
  nullifier: Uint8Array;
  /** Recipient's output note commitment */
  newCommitment1: Uint8Array;
  /** Sender's change note commitment */
  newCommitment2: Uint8Array;
  newRoot: Uint8Array;
  shieldedProof: ShieldedProofBundle;
  /** Operator ed25519 signature over the new root (required when POOL_SIGNED_ROOT). */
  rootSignature?: Uint8Array;
}

/**
 * Build a transfer() transaction.
 *
 * New interface (matches updated ShieldedPool.transfer):
 *   transfer(sender, spend_nullifier, new_commitment_1, new_commitment_2,
 *            new_root, shielded_proof, shielded_pub_signals)
 *
 * Two output commitments are now required -- recipient note + change note.
 */
export async function buildTransferTx(params: TransferParams): Promise<string> {
  const contractId = await requirePoolContract();

  return invokeContract(params.sender, contractId, "transfer", [
    addressScVal(params.sender),
    bytesN32ScVal(params.nullifier),
    bytesN32ScVal(params.newCommitment1),
    bytesN32ScVal(params.newCommitment2),
    bytesN32ScVal(params.newRoot),
    ...rootSigArgs(params.rootSignature),
    bytesScVal(params.shieldedProof.proof),
    bytesScVal(params.shieldedProof.pubSignals),
  ]);
}

export interface WithdrawParams {
  recipient:      string;
  /** Raw integer string, same unit as the compliance and shielded proofs */
  amount:         string;
  nullifier:      Uint8Array;
  newRoot:        Uint8Array;
  shieldedProof:  ShieldedProofBundle;
  /** Off-ramp compliance proof (PRD §6.2) */
  withdrawProof:  WithdrawProofBundle;
  /** Operator ed25519 signature over the new root (required when POOL_SIGNED_ROOT). */
  rootSignature?: Uint8Array;
  /** AttestProtocol KYC attestation UID (required when POOL_KYC_ATTEST). */
  kycAttestationUid?: Uint8Array;
}

/**
 * Build a withdraw() transaction.
 *
 * The updated contract now requires BOTH a shielded spend proof AND an
 * off-ramp compliance proof (mirroring the on-ramp compliance gate on deposit).
 *
 * amount is a raw integer string, the same unit used in both proofs and the
 * note value.  Do NOT convert to stroops; the compliance and shielded
 * signals must equal the i128 passed to the contract.
 */
export async function buildWithdrawTx(params: WithdrawParams): Promise<string> {
  const contractId = await requirePoolContract();
  // Raw amount - same unit as the proof signals
  const amount = BigInt(params.amount);

  return invokeContract(params.recipient, contractId, "withdraw", [
    addressScVal(params.recipient),
    i128ScVal(amount),
    bytesN32ScVal(params.nullifier),
    bytesN32ScVal(params.newRoot),
    ...rootSigArgs(params.rootSignature),
    bytesScVal(params.withdrawProof.proof),
    bytesScVal(params.withdrawProof.pubSignals),
    // Off-ramp compliance gate
    bytesN32ScVal(params.withdrawProof.complianceNullifier),
    bytesScVal(params.withdrawProof.complianceProof),
    bytesScVal(params.withdrawProof.compliancePubSignals),
    ...kycAttestArgs(params.kycAttestationUid),
  ]);
}

export function rootToHex(root: Uint8Array): string {
  return Buffer.from(root).toString("hex");
}
