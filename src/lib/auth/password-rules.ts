import { PASSWORD_MAX, PASSWORD_MIN } from "@/lib/contracts/auth";

// Password rules (§6, PLAN "Validate passwords ourselves"): length, a built-in list of the most
// common passwords, nothing taken from the person's own identifiers, no trivial pattern. Pure
// module, shared by the server policy (password-policy.ts) and the live hints of the password field,
// so the browser ticks exactly what the server refuses. No server-only import here.

export type PasswordIssue = "too_short" | "too_long" | "common" | "personal" | "repeated" | "sequence";

export interface PasswordContext {
  /** The account's e-mail: its local part (and the parts of it) must not appear in the password. */
  email?: string | null;
  displayName?: string | null;
}

/** Lower-case; variants with capitals or trailing punctuation are compared after folding. */
export const COMMON_PASSWORDS: ReadonlySet<string> = new Set<string>([
  "123456", "password", "12345678", "qwerty", "123456789", "12345", "1234", "111111", "1234567", "dragon",
  "123123", "baseball", "abc123", "football", "monkey", "letmein", "shadow", "master", "666666", "qwertyuiop",
  "123321", "mustang", "1234567890", "michael", "654321", "superman", "1qaz2wsx", "7777777", "121212", "000000",
  "qazwsx", "123qwe", "killer", "trustno1", "jordan", "jennifer", "zxcvbnm", "asdfgh", "hunter", "buster",
  "soccer", "harley", "batman", "andrew", "tigger", "sunshine", "iloveyou", "charlie", "robert", "thomas",
  "hockey", "ranger", "daniel", "starwars", "klaster", "112233", "george", "computer", "michelle", "jessica",
  "pepper", "zxcvbn", "555555", "11111111", "131313", "freedom", "777777", "maggie", "159753", "aaaaaa",
  "ginger", "princess", "joshua", "cheese", "amanda", "summer", "ashley", "nicole", "chelsea", "biteme",
  "matthew", "access", "yankees", "987654321", "dallas", "austin", "thunder", "taylor", "matrix", "william",
  "corvette", "hello", "martin", "heather", "secret", "merlin", "diamond", "hammer", "silver", "internet",
  "password1", "password12", "password123", "password1234", "passw0rd", "p@ssw0rd", "p@ssword", "pa55word", "passwort", "passwd",
  "welcome", "welcome1", "welcome123", "admin", "admin123", "administrator", "root", "toor", "letmein1", "letmein123",
  "qwerty1", "qwerty12", "qwerty123", "qwerty1234", "qwertyui", "qwertyuiop1", "1q2w3e4r", "1q2w3e4r5t", "1q2w3e", "zaq12wsx",
  "zaq1xsw2", "1qazxsw2", "abcd1234", "abc12345", "abcdef", "abcdefg", "abcdefgh", "a123456", "a12345678", "123456a",
  "1234qwer", "qwer1234", "iloveyou1", "iloveyou2", "football1", "baseball1", "soccer1", "hello123", "hello1234", "whatever",
  "nothing", "changeme", "test123", "test1234", "testing", "testtest", "demo1234", "guest", "default", "temp1234",
  "azerty", "azerty1", "azerty12", "azerty123", "azertyuiop", "motdepasse", "motdepasse1", "bonjour", "bonjour1", "soleil",
  "chocolat", "marseille", "doudou", "loulou", "123soleil", "salut", "coucou", "camille", "nicolas", "olivier",
  "maroc", "maroc123", "maroc2024", "maroc2025", "maroc2026", "casablanca", "rabat", "marrakech", "tanger", "agadir",
  "raja", "wydad", "bismillah", "inchallah", "hamdoulah", "mohamed", "mohammed", "ahmed", "fatima", "youssef",
  "amine", "mehdi", "hassan", "hamza", "karim", "said", "rachid", "omar", "khadija", "yassine",
  "0123456789", "1234567891", "123456789a", "12345678a", "123456aa", "12341234", "12121212", "11223344", "10203040", "147258369",
  "159357", "741852963", "963852741", "1029384756", "0987654321", "9876543210", "87654321", "123654789", "321654987", "123123123",
  "asdfghjkl", "asdf1234", "asdasd", "asdasdasd", "zxczxc", "qweqwe", "qweasd", "qweasdzxc", "qwe123", "qwerty!",
  "joutiya", "joutiya123", "joutiya2026", "annonce", "annonces", "vendre", "acheter", "bienvenue", "bienvenue1", "client123",
]);

function fold(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}

function isRepeatedCharacter(value: string): boolean {
  const chars = Array.from(value);
  return chars.length > 1 && chars.every((char) => char === chars[0]);
}

/** "abcdefgh", "12345678", "zyxwvuts": every code point is the previous one plus or minus one. */
function isPlainSequence(value: string): boolean {
  const codes = Array.from(value).map((char) => char.codePointAt(0) ?? 0);
  if (codes.length < 3) return false;
  const step = (codes[1] ?? 0) - (codes[0] ?? 0);
  if (step !== 1 && step !== -1) return false;
  return codes.every((code, index) => index === 0 || code - (codes[index - 1] ?? 0) === step);
}

/** Folded tokens of the person's identifiers worth refusing: the e-mail local part and its pieces, the display name and its words, 4+ characters each. */
export function personalTokens(context: PasswordContext): string[] {
  const tokens: string[] = [];
  const email = context.email?.trim();
  if (email) {
    const at = email.indexOf("@");
    const local = at > 0 ? email.slice(0, at) : email;
    tokens.push(local, ...local.split(/[._+-]+/));
  }
  const name = context.displayName?.trim();
  if (name) tokens.push(name, ...name.split(/\s+/));
  return tokens.map(fold).filter((token) => token.length >= 4);
}

function isCommon(folded: string): boolean {
  const trimmed = folded.replace(/[^\p{L}\p{N}]+$/u, "");
  return COMMON_PASSWORDS.has(folded) || COMMON_PASSWORDS.has(trimmed);
}

/** Every issue of `password`, in the order the policy reports them (empty when it is acceptable). */
export function passwordIssues(password: string, context: PasswordContext = {}): PasswordIssue[] {
  const issues: PasswordIssue[] = [];
  const length = Array.from(password).length;
  if (length < PASSWORD_MIN) issues.push("too_short");
  if (length > PASSWORD_MAX) issues.push("too_long");
  const folded = fold(password);
  if (isCommon(folded)) issues.push("common");
  if (personalTokens(context).some((token) => folded.includes(token))) issues.push("personal");
  if (isRepeatedCharacter(folded)) issues.push("repeated");
  if (isPlainSequence(folded)) issues.push("sequence");
  return issues;
}

/** The first policy issue of `password`, or null when it is acceptable. */
export function checkPassword(password: string, context: PasswordContext = {}): PasswordIssue | null {
  return passwordIssues(password, context)[0] ?? null;
}

/** The rules of the live hints under a new password field, each true once satisfied. */
export interface PasswordRules {
  /** Between PASSWORD_MIN and PASSWORD_MAX characters. */
  length: boolean;
  /** Not a common password, a repeated character or a plain sequence. */
  common: boolean;
  /** Contains neither the e-mail local part nor the display name. */
  personal: boolean;
}

/** The same rules as `checkPassword`, evaluated independently; everything is false while the field is empty. */
export function passwordRules(password: string, context: PasswordContext = {}): PasswordRules {
  if (password.length === 0) return { length: false, common: false, personal: false };
  const issues = new Set(passwordIssues(password, context));
  return {
    length: !issues.has("too_short") && !issues.has("too_long"),
    common: !issues.has("common") && !issues.has("repeated") && !issues.has("sequence"),
    personal: !issues.has("personal"),
  };
}
