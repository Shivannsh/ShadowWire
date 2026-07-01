/**
 * Note Wallet, browser-side note storage for the ShadowWire shielded pool.
 *
 * A "note" is a private UTXO in the shielded pool:
 *   { owner, value, assetId, blinding, secretKey, commitment }
 *
 * Notes are stored in localStorage keyed by the pool contract address.
 * They are NOT stored on-chain. Privacy depends on keeping blinding+secretKey local.
 *
 * The ownerField is a deterministic BN254 Field element derived from the user's
 * Stellar address. This links the circuit's "owner_pubkey" to a real identity
 * WITHOUT revealing the Stellar address on-chain.
 */

const STORAGE_KEY_PREFIX = "shadowwire_notes_";

// BN254 field order (used for address -> Field reduction)
const BN254_ORDER = BigInt(
  "21888242871839275222246405745257275088548364400416034343698204186575808495617"
);

export interface ShieldedNote {
  owner:      string;    // ownerField (BN254 Field element as decimal string)
  value:      string;    // amount as decimal string
  assetId:    string;    // "3" for SRT in demo
  blinding:   string;    // random Field (decimal) -- KEEP PRIVATE
  secretKey:  string;    // random Field (decimal) -- KEEP PRIVATE
  commitment: string;    // hex Field -- the on-chain commitment
  depositedAt?: number;  // UNIX timestamp
  spent?: boolean;
}

// ---------------------------------------------------------------------------
// Address -> Field conversion
// Deterministic: same Stellar address always produces the same Field element.
// Uses SHA-256 of the address bytes, reduced mod BN254 field order.
// ---------------------------------------------------------------------------

export async function addressToField(stellarAddress: string): Promise<string> {
  const encoder = new TextEncoder();
  const data    = encoder.encode(stellarAddress);
  const hashBuf = await crypto.subtle.digest("SHA-256", data);
  const hashHex = Array.from(new Uint8Array(hashBuf))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
  const reduced = BigInt("0x" + hashHex) % BN254_ORDER;
  return reduced.toString(10);
}

// ---------------------------------------------------------------------------
// Random note parameters (32 bytes of entropy reduced mod BN254)
// ---------------------------------------------------------------------------

export function generateRandomField(): string {
  const bytes = new Uint8Array(31);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
  return BigInt("0x" + hex).toString(10);
}

export function generateNoteRandomness(): { blinding: string; secretKey: string } {
  return {
    blinding:  generateRandomField(),
    secretKey: generateRandomField(),
  };
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

function storageKey(poolAddress: string): string {
  return `${STORAGE_KEY_PREFIX}${poolAddress}`;
}

export function loadNotes(poolAddress: string): ShieldedNote[] {
  if (typeof window === "undefined") return [];
  const raw = localStorage.getItem(storageKey(poolAddress));
  if (!raw) return [];
  try {
    return JSON.parse(raw) as ShieldedNote[];
  } catch {
    return [];
  }
}

export function saveNote(poolAddress: string, note: ShieldedNote): void {
  const notes = loadNotes(poolAddress);
  // Deduplicate by commitment
  const existing = notes.findIndex(n => n.commitment === note.commitment);
  if (existing >= 0) {
    notes[existing] = { ...notes[existing], ...note };
  } else {
    notes.push({ ...note, depositedAt: Date.now() });
  }
  localStorage.setItem(storageKey(poolAddress), JSON.stringify(notes));
}

export function markNoteSpent(poolAddress: string, commitment: string): void {
  const notes = loadNotes(poolAddress);
  const idx   = notes.findIndex(n => n.commitment === commitment);
  if (idx >= 0) {
    notes[idx].spent = true;
    localStorage.setItem(storageKey(poolAddress), JSON.stringify(notes));
  }
}

export function getSpendableNotes(poolAddress: string): ShieldedNote[] {
  return loadNotes(poolAddress).filter(n => !n.spent);
}

export function getNoteByCommitment(
  poolAddress: string,
  commitment: string
): ShieldedNote | null {
  return loadNotes(poolAddress).find(n =>
    n.commitment.toLowerCase() === commitment.toLowerCase()
  ) ?? null;
}

// ---------------------------------------------------------------------------
// Create a new note object (call before proving deposit)
// ---------------------------------------------------------------------------

export async function createNote(
  stellarAddress:  string,
  value:           string,
  assetId:         string,
  poolAddress:     string,
  commitment:      string,  // computed by /api/prove/deposit
): Promise<ShieldedNote> {
  const ownerField              = await addressToField(stellarAddress);
  const { blinding, secretKey } = generateNoteRandomness();

  const note: ShieldedNote = {
    owner:      ownerField,
    value,
    assetId,
    blinding,
    secretKey,
    commitment,
  };

  saveNote(poolAddress, note);
  return note;
}

// ---------------------------------------------------------------------------
// Note receipt encode/decode (off-chain transfer Alice -> Bob)
// ---------------------------------------------------------------------------

export interface NoteReceipt {
  owner:      string;
  value:      string;
  assetId:    string;
  blinding:   string;
  secretKey:  string;
  commitment: string;
}

export function encodeNoteReceipt(note: NoteReceipt): string {
  return btoa(JSON.stringify(note));
}

export function decodeNoteReceipt(encoded: string): NoteReceipt {
  try {
    return JSON.parse(atob(encoded)) as NoteReceipt;
  } catch {
    throw new Error(
      "Invalid note receipt. Paste the full base64 string Alice provided."
    );
  }
}

export function noteReceiptToLocalNote(receipt: NoteReceipt): ShieldedNote {
  return {
    owner:      receipt.owner,
    value:      receipt.value,
    assetId:    receipt.assetId,
    blinding:   receipt.blinding,
    secretKey:  receipt.secretKey,
    commitment: receipt.commitment,
  };
}
