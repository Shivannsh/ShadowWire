// On-chain KYC attestations via AttestProtocol (Tier C).
//
// The mock-issuer acts as a real KYC authority: it issues *delegated*
// AttestProtocol attestations about a wallet, which the ShieldedPool then
// verifies on-chain (cross-contract get_attestation) during deposit/withdraw.
//
// This client talks to the issuer's KYC endpoints:
//   GET  /api/kyc/config            -> protocol id, authority, schema, bls pubkey
//   GET  /api/kyc/status?address=G  -> { verified, attestationUid, ... }
//   POST /api/kyc/enroll { address, side } -> issues the delegated attestation

const ISSUER_URL =
  process.env.NEXT_PUBLIC_MOCK_ISSUER_URL ?? "http://localhost:3001";

/** Whether the active pool enforces an on-chain KYC attestation (v10+). */
export const POOL_KYC_ATTEST =
  process.env.NEXT_PUBLIC_POOL_KYC_ATTEST === "true";

export type KycSide = "send" | "receive";

/** Off-chain identity collected before issuing an AttestProtocol credential. */
export interface KycProfile {
  firstName: string;
  lastName: string;
  email: string;
}

function profileKey(address: string): string {
  return `shadowwire-kyc-${address}`;
}

export function loadKycProfile(address: string): KycProfile | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(profileKey(address));
    if (!raw) return null;
    const p = JSON.parse(raw) as KycProfile;
    if (!p.firstName?.trim() || !p.lastName?.trim() || !p.email?.trim()) return null;
    return p;
  } catch {
    return null;
  }
}

export function saveKycProfile(address: string, profile: KycProfile): void {
  localStorage.setItem(profileKey(address), JSON.stringify(profile));
}

export interface KycConfig {
  configured: boolean;
  provider?: string;
  protocol?: string;
  authority?: string;
  schemaUid?: string;
  schemaDef?: string;
  blsPublicKey?: string;
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

export interface KycEnrollResult {
  ok: boolean;
  attestationUid: string;
  txHash?: string;
  subject: string;
  attester: string;
  schemaUid: string;
  tier: number;
  country: number;
}

export async function getKycConfig(): Promise<KycConfig> {
  const res = await fetch(`${ISSUER_URL}/api/kyc/config`);
  if (!res.ok) throw new Error(`GET /api/kyc/config failed (${res.status})`);
  return res.json();
}

export async function getKycStatus(address: string): Promise<KycStatus> {
  const res = await fetch(
    `${ISSUER_URL}/api/kyc/status?address=${encodeURIComponent(address)}`
  );
  const text = await res.text();
  if (!res.ok) throw new Error(`GET /api/kyc/status failed (${res.status}): ${text}`);
  return JSON.parse(text);
}

export async function enrollKyc(
  address: string,
  side: KycSide,
  profile: KycProfile
): Promise<KycEnrollResult> {
  saveKycProfile(address, profile);
  const res = await fetch(`${ISSUER_URL}/api/kyc/enroll`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      address,
      side,
      first_name: profile.firstName.trim(),
      last_name: profile.lastName.trim(),
      email_address: profile.email.trim(),
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`POST /api/kyc/enroll failed (${res.status}): ${text}`);
  return JSON.parse(text);
}

export async function revokeKyc(address: string): Promise<{ attestationUid: string; txHash?: string }> {
  const res = await fetch(`${ISSUER_URL}/api/kyc/revoke`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`POST /api/kyc/revoke failed (${res.status}): ${text}`);
  return JSON.parse(text);
}

export function clearKycProfile(address: string): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(profileKey(address));
}

/** Convert a 32-byte attestation UID to lowercase hex (no 0x prefix). The issuer
 *  needs the hex form to split the UID into the compliance proof's public inputs. */
export function uidBytesToHex(uid?: Uint8Array): string | undefined {
  if (!uid) return undefined;
  return Array.from(uid).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Convert a hex attestation UID (with/without 0x) to a 32-byte Uint8Array. */
export function uidToBytes(uidHex: string): Uint8Array {
  const clean = uidHex.replace(/^0x/, "");
  if (clean.length !== 64) {
    throw new Error(`Expected 32-byte (64 hex char) attestation UID, got ${clean.length} chars`);
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Ensure the wallet holds a valid on-chain KYC attestation for `side`, enrolling
 * it if necessary, and return the attestation UID as bytes for the pool call.
 * Returns undefined when the pool does not require KYC (so callers stay simple).
 */
export async function ensureKycAttestation(
  address: string,
  side: KycSide,
  onStatus?: (msg: string) => void
): Promise<Uint8Array | undefined> {
  if (!POOL_KYC_ATTEST) return undefined;

  const status = await getKycStatus(address);
  if (status.verified && status.attestationUid) {
    onStatus?.("KYC attestation verified on-chain (AttestProtocol)");
    return uidToBytes(status.attestationUid);
  }

  throw new Error(
    "Complete on-chain KYC first, fill in your identity details in the KYC panel above."
  );
}
