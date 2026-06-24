import * as StellarSdk from "@stellar/stellar-sdk";
import { invokeContract, readContract } from "@/lib/transactions";
import { getShieldedPoolContractId } from "@/lib/addresses";
import { toStroops } from "@/lib/stellar";
import type { ComplianceProofBundle, ShieldedProofBundle } from "@/lib/proofs";

function addressScVal(addr: string): StellarSdk.xdr.ScVal {
  return StellarSdk.Address.fromString(addr).toScVal();
}

function bytesN32ScVal(bytes: Uint8Array): StellarSdk.xdr.ScVal {
  if (bytes.length !== 32) {
    throw new Error(`Expected 32-byte value, got ${bytes.length}`);
  }
  return StellarSdk.xdr.ScVal.scvBytes(Buffer.from(bytes));
}

function bytesScVal(bytes: Uint8Array): StellarSdk.xdr.ScVal {
  return StellarSdk.xdr.ScVal.scvBytes(Buffer.from(bytes));
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
}

/**
 * Build a deposit() transaction.
 *
 * New interface (matches updated ShieldedPool.deposit):
 *   deposit(depositor, amount, note_commitment, new_root,
 *           compliance_nullifier, compliance_proof, compliance_pub_signals)
 */
export async function buildDepositTx(params: DepositParams): Promise<string> {
  const contractId = await requirePoolContract();
  const amount = toStroops(params.amount);

  return invokeContract(params.depositor, contractId, "deposit", [
    addressScVal(params.depositor),
    i128ScVal(amount),
    bytesN32ScVal(params.commitment),
    bytesN32ScVal(params.newRoot),
    bytesN32ScVal(params.complianceNullifier),
    bytesScVal(params.complianceProof.proof),
    bytesScVal(params.complianceProof.pubSignals),
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
    bytesScVal(params.shieldedProof.proof),
    bytesScVal(params.shieldedProof.pubSignals),
  ]);
}

export interface WithdrawParams {
  recipient: string;
  amount: string;
  nullifier: Uint8Array;
  newRoot: Uint8Array;
  shieldedProof: ShieldedProofBundle;
}

export async function buildWithdrawTx(params: WithdrawParams): Promise<string> {
  const contractId = await requirePoolContract();
  const amount = toStroops(params.amount);

  return invokeContract(params.recipient, contractId, "withdraw", [
    addressScVal(params.recipient),
    i128ScVal(amount),
    bytesN32ScVal(params.nullifier),
    bytesN32ScVal(params.newRoot),
    bytesScVal(params.shieldedProof.proof),
    bytesScVal(params.shieldedProof.pubSignals),
  ]);
}

export function rootToHex(root: Uint8Array): string {
  return Buffer.from(root).toString("hex");
}
