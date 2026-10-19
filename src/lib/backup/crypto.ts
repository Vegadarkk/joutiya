import { Decrypter, Encrypter, generateIdentity, identityToRecipient } from "age-encryption";

// age encryption of the backup objects (D17): the public key (recipient) lives on the VM as
// BACKUP_AGE_RECIPIENT, the identity (secret key) stays offline with the owner. Only X25519
// recipients are accepted: 62 chars, short enough for an env var and readable by every age
// version (phase-3/research/libs-map-backup.md B1). Pure module (no server-only, no "@/" alias): the
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

const SECRET_KEY = /age-secret-key-1[0-9a-z]*/gi;

/** Masks anything shaped like an age secret key: the library's checksum errors echo the invalid key. */
export function redactSecrets(message: string): string {
  return message.replace(SECRET_KEY, "AGE-SECRET-KEY-1<redacted>");
}

/** Decrypts an age file with one identity. Rejects when no recipient of the file matches; the message never carries the identity. */
export async function decryptAge(bytes: Uint8Array, identity: string): Promise<Uint8Array> {
  try {
    const decrypter = new Decrypter();
    decrypter.addIdentity(identity.trim());
    return await decrypter.decrypt(bytes, "uint8array");
  } catch (error) {
    throw new Error(redactSecrets((error as Error).message));
  }
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

/** parseAgeIdentityFile plus the checksum: the identity and its public key. Errors never carry the key. */
export async function loadAgeIdentity(text: string): Promise<{ identity: string; recipient: string }> {
  const identity = parseAgeIdentityFile(text);
  try {
    return { identity, recipient: await identityToRecipient(identity) };
  } catch {
    throw new Error("age identity file: the key is damaged (checksum)");
  }
}

/** Test key pairs (nothing committed): `const identity = await generateIdentity(); const recipient = await identityToRecipient(identity);`. */
export { generateIdentity, identityToRecipient };
