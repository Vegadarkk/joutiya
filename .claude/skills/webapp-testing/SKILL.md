---
name: webapp-testing
description: Check the Joutiya UI in a real browser with the repo's Node Playwright (@playwright/test): run the e2e suite, take screenshots, catch console errors and CSP violations before handing UI work back.
---

# Web app testing (Node Playwright)

The repo ships `@playwright/test` and `playwright.config.ts`: specs in `tests/e2e`, the
production standalone build served on port 3100 by `webServer` (`scripts/start-standalone.ts`,
ready when `/api/health` answers, `APP_ENV=dev`, `ADMIN_HOST=admin.localhost`), Desktop
Chrome, trace kept on failure. Python Playwright is not installed: write TypeScript specs.

## Run

```bash
npm run build && npm run test:e2e                                    # full suite
PLAYWRIGHT_CHROMIUM_PATH=/opt/pw-browsers/chromium npm run test:e2e  # cloud sessions
npx playwright test tests/e2e/public.spec.ts                         # one file
```

`reuseExistingServer` is on outside CI: start `node scripts/start-standalone.ts` once with
the same env to iterate without restarting the server. Admin pages are reached by hostname,
`page.goto("http://admin.localhost:3100/")` (Chromium resolves `*.localhost`); `request`
calls pass a `host: "admin.localhost:3100"` header instead.

## Ad-hoc visual check

Write a temporary spec (delete it before committing; `test-results/` is gitignored):

```ts
// tests/e2e/tmp-check.spec.ts
import { expect, test } from "@playwright/test";

test("home /fr renders cleanly", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/fr");
  await page.waitForLoadState("networkidle"); // let client JS settle before inspecting
  await page.screenshot({ path: "test-results/home-fr.png", fullPage: true });
  expect(errors).toEqual([]);
});
```

Open the PNG with the Read tool to judge the result: one screenshot per state, and check
`/ar` (RTL) as well as `/fr` after any layout change. For CSP, copy `watchCsp` from
`tests/e2e/public.spec.ts`.

## Rules

- Prefer `getByRole`, `getByLabel`, `getByText` locators; wait for `networkidle` or a
  visible element, never a fixed timeout.
- Keep screenshots, traces and temporary specs out of Git.
- Run the suite through a subagent that returns only the failures and their messages.
