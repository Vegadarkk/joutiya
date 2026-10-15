// Normalized e-mail (§6): one account per person, whatever the Gmail dots or +tag variants.
// Used for rate-limit keys and duplicate checks (emailNormHash), never as the login e-mail.

const GMAIL = new Set(["gmail.com", "googlemail.com"]);

export function normalizeEmail(email: string): string {
  const value = email.trim().toLowerCase();
  const at = value.lastIndexOf("@");
  if (at <= 0) return value;
  let local = value.slice(0, at);
  let domain = value.slice(at + 1).replace(/\.$/, "");
  const plus = local.indexOf("+");
  if (plus > 0) local = local.slice(0, plus);
  if (GMAIL.has(domain)) {
    local = local.replaceAll(".", "");
    domain = "gmail.com";
  }
  return `${local}@${domain}`;
}

export function emailDomain(email: string): string {
  const value = email.trim().toLowerCase();
  return value.slice(value.lastIndexOf("@") + 1).replace(/\.$/, "");
}
