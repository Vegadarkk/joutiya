import { expect, test } from "@playwright/test";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { firebase, randomId, signUpAndIn } from "./helpers";

// CGU change notice (phase 6, D11): a member whose recorded CGU version is older than the current
// text sees the band under the header on public and private pages until they acknowledge it; the
// acknowledgement records the current version.
process.env.FIREBASE_AUTH_EMULATOR_HOST ??= "127.0.0.1:9099";

test("a member who accepted older CGU sees the notice until they acknowledge it", async ({ page, request }) => {
  const email = `cgu-${randomId(10)}@joutiya.test`;
  await signUpAndIn(page, request, email);
  const { uid } = await getAuth(firebase()).getUserByEmail(email);
  const account = getFirestore(firebase()).collection("users").doc(uid).collection("private").doc("account");
  await expect(page.getByTestId("cgu-notice")).toHaveCount(0);
  await account.update({ "consents.cgu": { version: "0.9", at: new Date("2026-01-01T00:00:00Z") } });

  // Public page (static): the session, and with it the notice, comes from /api/auth/me.
  await page.goto("/fr/legal/objets-interdits");
  const notice = page.getByTestId("cgu-notice");
  await expect(notice).toBeVisible();
  await expect(notice.getByRole("heading")).toContainText("conditions générales d'utilisation");
  await expect(notice.getByRole("link", { name: "Lire les CGU" })).toHaveAttribute("href", "/fr/legal/cgu");

  await page.goto("/fr/mes-annonces");
  await expect(notice).toBeVisible();
  await notice.getByRole("button", { name: "J'ai compris" }).click();
  await expect(notice).toHaveCount(0);
  const stored = (await account.get()).get("consents.cgu") as { version: string };
  expect(stored.version).not.toBe("0.9");
  await page.reload();
  await expect(page.locator("#main")).toBeVisible();
  await expect(notice).toHaveCount(0);
});
