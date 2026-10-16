// Rate limits (architecture §6, "Limitation de débit"). Keys are HMACs of the IP bucket (IPv4 or
// IPv6 /64), the device cookie, the uid or the normalized e-mail: nothing in clear in Valkey.
// `policy` says what happens when valkey-ratelimit is down: "closed" refuses (what costs money or
// exposes data), "open" lets the request through.

export type FailPolicy = "open" | "closed";

export interface RateLimitDefinition {
  /** Allowed consumptions per `duration`. */
  points: number;
  /** Window, seconds. */
  duration: number;
  /** Extra block once the window is exceeded, seconds (0 = until the window ends). */
  blockDuration?: number;
  policy: FailPolicy;
  /** What the key is made of, for the audit of this table. */
  key: "device" | "ip" | "ip48" | "uid" | "email" | "account+ip" | "account" | "phone";
}

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const RATE_LIMITS = {
  // /api/auth/signup: 3 per day per device; one account per normalized e-mail (users repository);
  // IP: 30 per hour, Turnstile always required.
  "signup.device": { points: 3, duration: DAY, policy: "closed", key: "device" },
  "signup.ip": { points: 30, duration: HOUR, policy: "closed", key: "ip" },
  // Sign-up attempt on an e-mail that already has an account: the warning mail to its owner is
  // sent 3 times per hour at most per normalized e-mail (mail bombing); the answer never changes.
  "signup.existing.email": { points: 3, duration: HOUR, policy: "closed", key: "email" },
  // Google sign-in (/api/auth/google and /api/auth/session): 10 per hour per device, 60 per hour per IP.
  "google.device": { points: 10, duration: HOUR, policy: "closed", key: "device" },
  "google.ip": { points: 60, duration: HOUR, policy: "closed", key: "ip" },
  // /api/auth/login: 5 failures in 15 min then a 15 min lock for this account + IP /64;
  // 20 failures per hour on an account: Turnstile mandatory for that account.
  "login.fail.accountIp": { points: 5, duration: 15 * MINUTE, blockDuration: 15 * MINUTE, policy: "closed", key: "account+ip" },
  "login.fail.account": { points: 20, duration: HOUR, policy: "closed", key: "account" },
  // Login attempts per IP (CGNAT: high, escalates to Turnstile, never a hard block).
  "login.ip": { points: 300, duration: HOUR, policy: "closed", key: "ip" },
  // Password reset: 3 per hour per normalized e-mail, IP in escalation.
  "reset.email": { points: 3, duration: HOUR, policy: "closed", key: "email" },
  "reset.ip": { points: 30, duration: HOUR, policy: "closed", key: "ip" },
  // Verification e-mail resend.
  "verify.resend.uid": { points: 3, duration: HOUR, policy: "closed", key: "uid" },
  // Action codes (verification and reset links): per IP, brute force on oobCode.
  "action.ip": { points: 60, duration: HOUR, policy: "closed", key: "ip" },
  // /api/auth/client-token: 120 per hour per uid.
  "clientToken.uid": { points: 120, duration: HOUR, policy: "open", key: "uid" },
  // WhatsApp verification: 3 per day per account, 5 per day per IP /64, 1 per minute per number and account.
  "phone.uid": { points: 3, duration: DAY, policy: "closed", key: "uid" },
  "phone.ip": { points: 5, duration: DAY, policy: "closed", key: "ip" },
  "phone.number": { points: 1, duration: MINUTE, policy: "closed", key: "phone" },
  "phone.status.uid": { points: 400, duration: HOUR, policy: "open", key: "uid" },
  // Staff login on the admin host (Access already in front): tight.
  "staff.login.accountIp": { points: 5, duration: 15 * MINUTE, blockDuration: 15 * MINUTE, policy: "closed", key: "account+ip" },
  // Account settings mutations (display name, password change, account closure).
  "account.mutation.uid": { points: 60, duration: HOUR, policy: "closed", key: "uid" },
} as const satisfies Record<string, RateLimitDefinition>;

export type RateLimitId = keyof typeof RATE_LIMITS;
