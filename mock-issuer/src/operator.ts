/**
 * Operator root-attestation key.
 *
 * The ShieldedPool (v9+) cannot recompute the commitment-tree root on-chain —
 * Soroban has no Poseidon host function (CAP-0075 is still a draft) — so it
 * instead requires every new root to be signed by a registered operator ed25519
 * key. The operator is THIS proving server, which already derives the new root
 * from the real on-chain commitments (see pool-state.ts), so it is the natural
 * authority to attest it.
 *
 * Signed message (must byte-match contracts/shielded_pool assert_root_signed):
 *
 *     message = corridor_id (4 bytes, big-endian) || new_root (32 bytes)
 *
 * Key material:
 *   - OPERATOR_SECRET_B64 env (base64 of the 64-byte nacl secret key), or
 *   - persisted to mock-issuer/.operator-key.json on first run (gitignored).
 */

import nacl from "tweetnacl";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KEY_FILE = path.join(__dirname, "..", ".operator-key.json");

function loadKeypair(): nacl.SignKeyPair {
  const fromEnv = process.env.OPERATOR_SECRET_B64;
  if (fromEnv) {
    const secretKey = Uint8Array.from(Buffer.from(fromEnv, "base64"));
    return nacl.sign.keyPair.fromSecretKey(secretKey);
  }
  if (fs.existsSync(KEY_FILE)) {
    const { secretKey } = JSON.parse(fs.readFileSync(KEY_FILE, "utf8")) as {
      secretKey: string;
    };
    return nacl.sign.keyPair.fromSecretKey(Uint8Array.from(Buffer.from(secretKey, "base64")));
  }
  const kp = nacl.sign.keyPair();
  fs.writeFileSync(
    KEY_FILE,
    JSON.stringify(
      {
        publicKey: Buffer.from(kp.publicKey).toString("base64"),
        secretKey: Buffer.from(kp.secretKey).toString("base64"),
      },
      null,
      2
    )
  );
  return kp;
}

const keypair = loadKeypair();

/** 32-byte ed25519 public key as hex — pass this to the pool constructor. */
export function getOperatorPublicKeyHex(): string {
  return Buffer.from(keypair.publicKey).toString("hex");
}

function rootToBytes32(rootHex: string): Buffer {
  let clean = String(rootHex).trim();
  while (clean.startsWith("0x") || clean.startsWith("0X")) clean = clean.slice(2);
  return Buffer.from(clean.padStart(64, "0"), "hex");
}

/**
 * Sign `corridor_id || new_root` so the pool will accept the root.
 * Returns a 64-byte ed25519 signature as hex.
 */
export function signRoot(corridorId: number, newRootHex: string): string {
  const cid = Buffer.alloc(4);
  cid.writeUInt32BE(corridorId >>> 0, 0);
  const message = Buffer.concat([cid, rootToBytes32(newRootHex)]);
  const sig = nacl.sign.detached(Uint8Array.from(message), keypair.secretKey);
  return Buffer.from(sig).toString("hex");
}
