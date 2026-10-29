import { expect, test, type Page } from "@playwright/test";

// Help centre (design phase-5 D25): /aide and an article under the hash CSP of public pages, the
// in-page search, Arabic in RTL, and the Assistant Joutiya widget with its AI disclosure. The e2e
// server has no Claude key: the assistant answers in its degraded mode (help articles only).

async function watchCsp(page: Page): Promise<string[]> {
  const violations: string[] = [];
  await page.exposeFunction("__cspViolation", (detail: string) => violations.push(detail));
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      (window as unknown as { __cspViolation: (detail: string) => void }).__cspViolation(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });
  return violations;
}

test.describe("help centre", () => {
  test("/fr/aide lists the themes, searches in place and opens an article, under a hash CSP", async ({ page }) => {
    const violations = await watchCsp(page);
    const response = await page.goto("/fr/aide");
    expect(response?.status()).toBe(200);
    const scriptSrc = (response!.headers()["content-security-policy"] ?? "").split(";").find((directive) => directive.trim().startsWith("script-src")) ?? "";
    expect(scriptSrc).toContain("'sha256-");
    expect(scriptSrc).not.toContain("'nonce-");
    expect(response!.headers()["set-cookie"]).toBeUndefined();

    await expect(page.getByRole("heading", { level: 1, name: "Centre d'aide" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 3, name: "Sécurité" })).toBeVisible();

    await page.getByRole("searchbox", { name: "Rechercher dans le centre d'aide" }).fill("acompte virement");
    await expect(page.getByText(/articles? correspond/)).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Parcourir par thème" })).toBeHidden();
    await page.getByRole("link", { name: /Éviter les arnaques/ }).first().click();

    await expect(page).toHaveURL(/\/fr\/aide\/eviter-les-arnaques$/);
    await expect(page.getByRole("heading", { level: 1, name: "Éviter les arnaques" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Fil d'Ariane" }).getByRole("link", { name: "Centre d'aide" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Pour aller plus loin" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Signaler un contenu" })).toBeVisible();
    await page.waitForLoadState("networkidle");
    expect(violations).toEqual([]);
  });

  test("an Arabic article renders right to left", async ({ page }) => {
    const response = await page.goto("/ar/aide/eviter-les-arnaques");
    expect(response?.status()).toBe(200);
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(page.getByRole("heading", { level: 1, name: "تجنب الاحتيال" })).toBeVisible();
  });

  test("the assistant discloses that it is an AI and falls back to help articles", async ({ page }) => {
    const violations = await watchCsp(page);
    await page.goto("/fr/aide/deposer-une-annonce");
    await page.getByRole("button", { name: "Poser une question à l'Assistant" }).click();

    const dialog = page.getByRole("dialog", { name: /Assistant Aalan/ });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId("assistant-disclosure")).toContainText("intelligence artificielle");
    await expect(dialog.getByTestId("assistant-disclosure")).toContainText("Ne donnez aucune donnée personnelle");

    await dialog.getByRole("textbox", { name: "Votre question" }).fill("Comment renouveler mon annonce expirée ?");
    await dialog.getByRole("button", { name: "Envoyer" }).click();
    const degraded = dialog.getByTestId("assistant-degraded");
    await expect(degraded).toContainText("L'assistant n'est pas disponible pour le moment");
    await degraded.getByRole("link", { name: "Gérer mes annonces" }).click();
    await expect(page).toHaveURL(/\/fr\/aide\/gerer-mes-annonces$/);
    await expect(dialog).toBeHidden();
    expect(violations).toEqual([]);
  });

  test("/aide#assistant opens the assistant (the account menu's help entry)", async ({ page }) => {
    await page.goto("/fr/aide#assistant");
    await expect(page.getByRole("dialog", { name: /Assistant Aalan/ })).toBeVisible();
    await page.getByRole("button", { name: "Fermer l'assistant" }).click();
    await expect(page).toHaveURL(/\/fr\/aide$/);
  });
});
