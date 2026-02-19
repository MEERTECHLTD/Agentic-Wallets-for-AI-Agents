/**
 * crypto.js
 * Lightweight AES-256-GCM helpers for encrypting private key material at rest.
 * The encryption key is derived from a passphrase using PBKDF2 so brute-force
 * attacks on stored wallet files are expensive.
 *
 * Security note: this is intentionally simple for a devnet prototype.
 * Production usage would leverage hardware-backed secure enclaves (e.g., SGX,
 * AWS KMS, or a hardware wallet).
 */

import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const PBKDF2_ITERATIONS = 210_000; // OWASP 2023 recommended minimum
const KEY_LENGTH = 32; // 256-bit AES key
const SALT_LENGTH = 32;
const IV_LENGTH = 12; // 96-bit IV for GCM
const TAG_LENGTH = 16;
const ENCODING = "hex";

/**
 * Derive a 256-bit AES key from a passphrase + salt using PBKDF2-SHA-512.
 */
function deriveKey(passphrase, salt) {
  return crypto.pbkdf2Sync(
    passphrase,
    salt,
    PBKDF2_ITERATIONS,
    KEY_LENGTH,
    "sha512"
  );
}

/**
 * Encrypt plaintext with AES-256-GCM.
 * Returns a hex string: salt || iv || authTag || ciphertext
 */
export function encrypt(plaintext, passphrase) {
  const salt = crypto.randomBytes(SALT_LENGTH);
  const iv = crypto.randomBytes(IV_LENGTH);
  const key = deriveKey(passphrase, salt);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, {
    authTagLength: TAG_LENGTH,
  });

  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return Buffer.concat([salt, iv, authTag, encrypted]).toString(ENCODING);
}

/**
 * Decrypt a hex string produced by encrypt().
 */
export function decrypt(ciphertextHex, passphrase) {
  const buf = Buffer.from(ciphertextHex, ENCODING);
  let offset = 0;

  const salt = buf.subarray(offset, (offset += SALT_LENGTH));
  const iv = buf.subarray(offset, (offset += IV_LENGTH));
  const authTag = buf.subarray(offset, (offset += TAG_LENGTH));
  const encrypted = buf.subarray(offset);

  const key = deriveKey(passphrase, salt);

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, {
    authTagLength: TAG_LENGTH,
  });
  decipher.setAuthTag(authTag);

  return Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]).toString("utf8");
}
