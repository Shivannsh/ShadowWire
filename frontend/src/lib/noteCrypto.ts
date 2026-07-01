/**
 * Note Crypto, authenticated, confidential note delivery (Buyer → Seller).
 *
 * The previous channel was plaintext base64: anyone who intercepted the string
 * could read the note's `secretKey` and spend the note. Spend authority lives in
 * the note secrets, so an unencrypted receipt is a bearer instrument in the clear.
 *
 * This module replaces that with a NaCl "box" (X25519 key agreement +
 * XSalsa20-Poly1305 AEAD):
 *
 *   - The Seller holds a long-lived X25519 "receiving key" in localStorage and
 *     publishes only the PUBLIC half (out-of-band, or via QR / deep link).
 *   - The Buyer seals the note to that public key using a fresh EPHEMERAL keypair,
 *     so each package is forward-secret w.r.t. the Buyer and authenticated to the
 *     ephemeral sender. Only the holder of the receiving secret key can open it.
 *
 * Why not encrypt directly to the Stellar (ed25519) key? Freighter never exposes
 * the account secret key, it only signs, so the recipient could never derive the
 * decryption key. A dedicated receiving key sidesteps that and is the same pattern
 * used by viewing/incoming-viewing keys in Zcash, Railgun, and Tornado Nova.
 */

import nacl from "tweetnacl";
import { encodeBase64, decodeBase64, encodeUTF8, decodeUTF8 } from "tweetnacl-util";
import type { NoteReceipt } from "./proofs";

const RECEIVING_KEY_STORAGE = "shadowwire_receiving_key_v1";
/** Versioned, self-describing prefix so the Seller can tell sealed vs legacy. */
export const SEALED_NOTE_PREFIX = "SWNOTE1.";

export interface ReceivingKeypair {
  /** base64 X25519 public key, safe to share publicly. */
  publicKey: string;
  /** base64 X25519 secret key, NEVER leaves the device. */
  secretKey: string;
}

// ---------------------------------------------------------------------------
// Receiving key lifecycle (Seller side)
// ---------------------------------------------------------------------------

/**
 * Returns the device's persistent receiving keypair, creating one on first use.
 * The keypair lives in localStorage; clearing storage rotates it (any notes not
 * yet claimed against the old key would need to be re-sealed, see exportReceivingKey).
 */
export function getOrCreateReceivingKeypair(): ReceivingKeypair {
  if (typeof window === "undefined") {
    // SSR guard: ephemeral, never persisted. Real keys are created in the browser.
    const kp = nacl.box.keyPair();
    return { publicKey: encodeBase64(kp.publicKey), secretKey: encodeBase64(kp.secretKey) };
  }
  const existing = localStorage.getItem(RECEIVING_KEY_STORAGE);
  if (existing) {
    try {
      const parsed = JSON.parse(existing) as ReceivingKeypair;
      if (parsed.publicKey && parsed.secretKey) return parsed;
    } catch {
      /* fall through and regenerate */
    }
  }
  const kp = nacl.box.keyPair();
  const fresh: ReceivingKeypair = {
    publicKey: encodeBase64(kp.publicKey),
    secretKey: encodeBase64(kp.secretKey),
  };
  localStorage.setItem(RECEIVING_KEY_STORAGE, JSON.stringify(fresh));
  return fresh;
}

/** Public receiving key the Seller shares with the Buyer. */
export function getReceivingPublicKey(): string {
  return getOrCreateReceivingKeypair().publicKey;
}

/** Allow the Seller to back up / restore their receiving key across devices. */
export function exportReceivingKey(): string {
  return JSON.stringify(getOrCreateReceivingKeypair());
}

export function importReceivingKey(serialized: string): ReceivingKeypair {
  const parsed = JSON.parse(serialized) as ReceivingKeypair;
  if (!parsed.publicKey || !parsed.secretKey) {
    throw new Error("Invalid receiving key backup");
  }
  // Validate the keys are well-formed before persisting.
  decodeBase64(parsed.publicKey);
  decodeBase64(parsed.secretKey);
  if (typeof window !== "undefined") {
    localStorage.setItem(RECEIVING_KEY_STORAGE, JSON.stringify(parsed));
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Seal / open
// ---------------------------------------------------------------------------

/**
 * Seal a note to the Seller's public receiving key.
 * Output: "SWNOTE1." + base64( ephemeralPub(32) || nonce(24) || ciphertext ).
 */
export function sealNoteToRecipient(note: NoteReceipt, recipientPublicKeyB64: string): string {
  const recipientPub = decodeBase64(recipientPublicKeyB64.trim());
  if (recipientPub.length !== nacl.box.publicKeyLength) {
    throw new Error("Invalid receiving key, expected a 32-byte X25519 public key");
  }
  const ephemeral = nacl.box.keyPair();
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const message = decodeUTF8(JSON.stringify(note));
  const box = nacl.box(message, nonce, recipientPub, ephemeral.secretKey);

  const packed = new Uint8Array(ephemeral.publicKey.length + nonce.length + box.length);
  packed.set(ephemeral.publicKey, 0);
  packed.set(nonce, ephemeral.publicKey.length);
  packed.set(box, ephemeral.publicKey.length + nonce.length);

  return SEALED_NOTE_PREFIX + encodeBase64(packed);
}

export function isSealedNote(value: string): boolean {
  return value.trim().startsWith(SEALED_NOTE_PREFIX);
}

/** Open a sealed note package using this device's receiving secret key. */
export function openSealedNote(packageStr: string): NoteReceipt {
  const trimmed = packageStr.trim();
  if (!trimmed.startsWith(SEALED_NOTE_PREFIX)) {
    throw new Error("Not a sealed note package");
  }
  const packed = decodeBase64(trimmed.slice(SEALED_NOTE_PREFIX.length));
  const pubLen = nacl.box.publicKeyLength;
  const nonceLen = nacl.box.nonceLength;
  if (packed.length < pubLen + nonceLen) {
    throw new Error("Sealed note package is malformed");
  }
  const ephemeralPub = packed.slice(0, pubLen);
  const nonce = packed.slice(pubLen, pubLen + nonceLen);
  const ciphertext = packed.slice(pubLen + nonceLen);

  const { secretKey } = getOrCreateReceivingKeypair();
  const opened = nacl.box.open(ciphertext, nonce, ephemeralPub, decodeBase64(secretKey));
  if (!opened) {
    throw new Error(
      "Could not decrypt, this note was sealed to a different receiving key. " +
        "Make sure the sender used the receiving key shown on this device."
    );
  }
  return JSON.parse(encodeUTF8(opened)) as NoteReceipt;
}
