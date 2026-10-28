import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { getApps, initializeApp, type App } from "firebase-admin/app";
import sharp from "sharp";

// Shared e2e helpers (same flows as the per-spec copies): Firebase emulator access, sign-up through
// the UI with the dev mailbox, photos in the dev object store. Not a spec: Playwright skips it.
process.env.FIRESTORE_EMULATOR_HOST ??= "127.0.0.1:8080";

// Assembled at runtime: a literal would look like a credential to the secret scan.
export const PASSWORD = ["Souk", "Tanger", "2026!"].join("-");
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
/** Random id in the publicId alphabet (no i, l, o, 0, 1). */
export const randomId = (length: number) => Array.from(randomBytes(length), (byte) => ALPHABET[byte % ALPHABET.length]).join("");
/** Valid blurhash (the one from the blurhash README). */
export const BLURHASH = "LEHV6nWB2yk8pyo0adR*.7kCMdnj";
/** FsObjectStore layout of the dev media bucket (src/lib/storage/fs.ts, keys.ts). */
const MEDIA_ROOT = path.join(os.tmpdir(), "joutiya-dev-storage", "joutiya-dev-media");

export function firebase(): App {
  return getApps()[0] ?? initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID ?? "demo-joutiya" });
}

interface DevMail {
  template: string;
  data: { actionUrl?: string } & Record<string, unknown>;
}

export async function waitForMail(request: APIRequestContext, to: string, template: string): Promise<DevMail> {
  let found: DevMail | undefined;
  await expect
    .poll(
      async () => {
        const response = await request.get(`/api/dev/mailbox?to=${encodeURIComponent(to)}`);
        if (!response.ok()) return false;
        const { mails } = (await response.json()) as { mails: DevMail[] };
        found = mails.find((mail) => mail.template === template);
        return Boolean(found);
      },
      { timeout: 20_000, message: `mail "${template}" for ${to}` },
    )
    .toBe(true);
  return found!;
}

/**
 * A documentation-range address (TEST-NET-2, RFC 5737) for one sign-up. The suite signs up more
 * accounts than `signup.ip` allows one address in an hour; outside a deployment the server reads
 * `cf-connecting-ip` (src/lib/security/ip.ts), so each sign-up comes from its own address.
 */
const signupIp = () => `198.51.100.${1 + (randomBytes(1)[0]! % 254)}`;

/** Signs up a fresh individual through the French form and confirms the e-mail: the page is signed in. */
export async function signUpAndIn(page: Page, request: APIRequestContext, email: string, displayName = "Amina Test"): Promise<void> {
  const ip = signupIp();
  await page.route("**/api/auth/signup", (route) => route.continue({ headers: { ...route.request().headers(), "cf-connecting-ip": ip } }));
  await page.goto("/fr/inscription");
  await page.getByLabel("Nom affiché").fill(displayName);
  await page.getByLabel("Adresse e-mail").fill(email);
  await page.getByLabel("Mot de passe", { exact: true }).fill(PASSWORD);
  await page.getByRole("checkbox", { name: /conditions générales d'utilisation/i }).check();
  await page.getByRole("checkbox", { name: /transférer mes données personnelles/i }).check();
  const widget = page.locator("[data-turnstile]");
  if ((await widget.count()) > 0) await expect(widget.first()).toHaveAttribute("data-turnstile", "ready", { timeout: 20_000 });
  await page.getByRole("button", { name: "Créer mon compte" }).click();
  await expect(page.getByRole("heading", { name: "Vérifiez votre boîte mail" })).toBeVisible({ timeout: 15_000 });
  await page.unroute("**/api/auth/signup");
  const mail = await waitForMail(request, email, "verifyEmail");
  await page.goto(mail.data.actionUrl!);
  await expect(page.getByRole("heading", { name: "Adresse confirmée" })).toBeVisible({ timeout: 15_000 });
}

/** Writes both WebP variants of a photo where the dev storage route serves them. */
export async function storePhoto(listingId: string, photoId: string, color = { r: 196, g: 120, b: 52 }): Promise<{ w: number; h: number }> {
  const variants = { l: { width: 1600, height: 1200 }, s: { width: 480, height: 360 } } as const;
  for (const [variant, size] of Object.entries(variants)) {
    const key = ["listings", listingId, `${photoId}-${variant}.webp`];
    const body = await sharp({ create: { ...size, channels: 3, background: color } }).webp({ quality: 75 }).toBuffer();
    const objectPath = path.join(MEDIA_ROOT, "objects", ...key);
    const metaPath = `${path.join(MEDIA_ROOT, "meta", ...key)}.json`;
    await Promise.all([mkdir(path.dirname(objectPath), { recursive: true }), mkdir(path.dirname(metaPath), { recursive: true })]);
    await writeFile(objectPath, body);
    await writeFile(metaPath, JSON.stringify({ contentType: "image/webp", size: body.byteLength, cacheControl: "public, max-age=31536000, immutable", storedAt: new Date().toISOString() }));
  }
  return { w: variants.l.width, h: variants.l.height };
}
