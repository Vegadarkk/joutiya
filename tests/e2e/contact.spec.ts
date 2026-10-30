import { expect, test } from "@playwright/test";

// The users' point of contact (DSA art. 12) and the notice by address (art. 16(1)): the page needs
// no account, names the e-mail read by a person and the accepted languages, leads to each case,
// and opens the usual notice form from a pasted address.

test.describe("contact page", () => {
  test("names the e-mail, the languages and where to go for each case", async ({ page }) => {
    await page.goto("/fr/aide/contact");
    // The footer repeats some of these links: the page's own are the ones under test.
    const main = page.locator("#main");
    await expect(main.getByRole("heading", { level: 1 })).toHaveText("Nous contacter");
    await expect(main.getByRole("link", { name: /@/ }).first()).toHaveAttribute("href", /^mailto:/);
    await expect(main.getByText("Langues acceptées")).toBeVisible();
    await expect(main.getByRole("link", { name: "Signaler un contenu illicite" })).toHaveAttribute("href", "#signaler");
    await expect(main.getByRole("link", { name: "Décisions et recours" })).toHaveAttribute("href", "/fr/recours");
    await expect(main.getByRole("link", { name: "Vos droits sur vos données" })).toHaveAttribute("href", "/fr/legal/confidentialite#droits");
    await expect(main.getByRole("link", { name: "Contact autorités (DSA)" })).toHaveAttribute("href", "/fr/legal/contact-autorites");
    await expect(main.getByRole("link", { name: "Ce que nous ne traitons pas" })).toHaveAttribute("href", "/fr/legal/contact-autorites#limites");
    // One click away from every page: the footer's "Mentions et autorités" column.
    await expect(page.getByRole("contentinfo").getByRole("link", { name: "Nous contacter" })).toHaveAttribute("href", "/fr/aide/contact");
  });

  test("opens the notice form from a pasted listing address and refuses an unknown one", async ({ page }) => {
    await page.goto("/fr/aide/contact");
    const field = page.getByLabel("Adresse ou référence du contenu");
    const submit = page.getByRole("button", { name: "Signaler", exact: true });
    await field.fill("https://example.test/pas-une-annonce");
    await submit.click();
    // Next's route announcer is an alert too: the form's own carries the message.
    await expect(page.getByRole("alert").filter({ hasText: "Adresse non reconnue" })).toBeVisible();
    await field.fill("https://aalan.ma/fr/annonce/velo-cargo-casablanca-abcd2345?from=mail");
    await submit.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("heading", { name: "Signaler cette annonce" })).toBeVisible();
    await expect(dialog).toContainText("velo-cargo-casablanca-abcd2345");
  });

  test("is served in Arabic", async ({ page }) => {
    await page.goto("/ar/aide/contact");
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("اتصل بنا");
    await expect(page.getByRole("link", { name: /@/ }).first()).toHaveAttribute("href", /^mailto:/);
  });
});
