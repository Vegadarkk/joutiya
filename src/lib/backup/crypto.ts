import { Decrypter, Encrypter, generateIdentity, identityToRecipient } from "age-encryption";

// age encryption of the backup objects (D17): the public key (recipient) lives on the VM as
// BACKUP_AGE_RECIPIENT, the identity (secret key) stays offline with the owner. Only X25519
// recipients are accepted: 62 chars, short enough for an env var and readable by every age
// version (research/libs-map-backup.md B1). Pure module (no server-only, no "@/" alias): the
// restore script runs it under plain Node.

/** X25519 recipient: "age1" + 58 bech32 chars (MEASURED on a real key). */
export const AGE_RECIPIENT_PATTERN = /^age1[023456789acdefghjklmnpqrstuvwxyz]{58}$/;
/** X25519 identity as printed by age-keygen (74 chars). */
export const AGE_IDENTITY_PATTERN = /^AGE-SECRET-KEY-1[023456789ACDEFGHJKLMNPQRSTUVWXYZ]{58}$/;

export class AgeRecipientError extends Error {
  constructor() {
    super("invalid age recipient: an X25519 public key (age1..., 62 chars) is required");
    this.name = "AgeRecipientError";
  }
}

export function isAgeRecipient(value: unknown): value is string {
  return typeof value === "string" && AGE_RECIPIENT_PATTERN.test(value);
}

/** Encrypts `bytes` for one recipient. Throws AgeRecipientError before touching the data when the recipient is not valid. */
export async function encryptAge(bytes: Uint8Array, recipient: string): Promise<Uint8Array> {
  if (!isAgeRecipient(recipient)) throw new AgeRecipientError();
  const encrypter = new Encrypter();
  encrypter.addRecipient(recipient);
  return encrypter.encrypt(bytes);
}

/** Decrypts an age file with one identity. Rejects (age error) when no recipient of the file matches. */
export async function decryptAge(bytes: Uint8Array, identity: string): Promise<Uint8Array> {
  const decrypter = new Decrypter();
  decrypter.addIdentity(identity.trim());
  return decrypter.decrypt(bytes, "uint8array");
}

/**
 * The secret key of an `age-keygen -o` file: comment lines ("# created:", "# public key:") are
 * skipped, exactly one AGE-SECRET-KEY-1... line is expected. Callers never log the result.
 */
export function parseAgeIdentityFile(text: string): string {
  const keys = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  if (keys.length !== 1 || !AGE_IDENTITY_PATTERN.test(keys[0] as string)) throw new Error("age identity file: exactly one AGE-SECRET-KEY-1... line expected");
  return keys[0] as string;
}

/** Test key pairs (nothing committed): `const identity = await generateIdentity(); const recipient = await identityToRecipient(identity);`. */
export { generateIdentity, identityToRecipient };
