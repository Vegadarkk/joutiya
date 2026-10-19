import type { Page } from "@playwright/test";

// Stand-in for Google Identity Services. The e2e server names a stub OAuth client id
// (playwright.config.ts), so the Google button renders on /connexion and /inscription: every spec
// that opens them serves this stub in place of the real script (nothing leaves the machine in CI).
// It records the `initialize` configuration and renders a button that fires the callback with a
// fake credential, which the server rejects (no Google signature).

export const GSI_SRC = "https://accounts.google.com/gsi/client";

export const GSI_STUB = `
window.google = { accounts: { id: {
  initialize(config) { window.__gsi = config; },
  renderButton(parent) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Continuer avec Google (stub)";
    button.addEventListener("click", () => window.__gsi.callback({ credential: "stub-credential-" + "x".repeat(40), select_by: "btn" }));
    parent.appendChild(button);
  },
} } };
`;

/** Serves the stub for every load of the GIS script on `page`; register it before the first `goto`. */
export async function stubGoogleScript(page: Page): Promise<void> {
  await page.route(GSI_SRC, (route) => route.fulfill({ status: 200, contentType: "application/javascript", body: GSI_STUB }));
}
