# Joutiya — Claude Code instructions

C2C/B2C classifieds marketplace for Morocco, modeled on Leboncoin.fr (multi-criteria
search, multi-photo listings, messaging, pro accounts, paid boosts, RevenueCat pro
subscriptions, Google Ads slots, moderation).

## Language and replies

- **Always reply to the user in French**, in every message, whatever language the
  context is in. Docs written for the user to review are in French too.
- Claude-facing text (this file, `.claude/`, code, comments, commits, notes for
  Claude or between sessions): concise English.
- Answer first. No preamble, no recap, no long report unless asked.
- Neutral and factual: do not side with the owner by default. If a decision is
  questionable, say so with facts and recommend the stronger option.
- No "I'm not a lawyer/doctor" disclaimers.

## Project state (2026-10-12)

- Architecture v3 ("start at 0 EUR") validated by the owner on 2026-10-12. MVP phase 0
  is under way; launch is planned after phases 0-6 (~week 16). Source of truth:
  the architecture doc (Claude Doc "Architecture du MVP v3"), copy in the project
  files as `joutiya/architecture-final.md`; read only the section you need (11 sections,
  ~175 KB). Deviations need the owner's approval.
- The owner picks the logo from concepts before brand integration.
- No cloud resource is created, and no existing account completed, without the
  owner's explicit approval; all targets are listed in `infra/targets.json` and checked
  by `scripts/assert-target.ts`.

## Architecture

- **App**: one Next.js 16 (App Router, strict TypeScript, Tailwind v4, shadcn/ui,
  next-intl FR/AR/RIF) app + a BullMQ worker sharing `src/lib`; one Docker image,
  targets `web` and `worker`. Public anonymous pages: ISR + hash CSP; private pages:
  dynamic + nonce CSP. `admin.joutiya.ma` is rewritten to `src/app/admin` by `proxy.ts`.
- **Hosting**: Oracle Cloud Always Free ARM VM (Docker Compose, staging as a separate
  Compose project), Cloudflare Free in front, traffic only via Cloudflare Tunnel (no
  inbound port, SSH included). The VM holds no unique data (`infra/redeploy.md`).
- **Data**: Firebase Spark (Auth without Identity Platform, Firestore Standard, EU),
  projects dev / staging / prod. All reads and writes go through the Next.js API (server
  first, rate limited); Firestore rules deny everything except realtime messaging.
- **Services**: Meilisearch (search), R2 + `sharp` + local ONNX models (photos),
  Valkey x2 (queue `noeviction`, rate limit `allkeys-lru`), Resend (mail), WhatsApp
  inbound phone check, Turnstile, Sentry EU, Stripe + RevenueCat (credits wallet, Pro
  subscriptions), Claude Haiku 5.5 / Sonnet 5.5 for moderation and the assistant,
  hard cap 5 USD/month.
- **Adapters**: every free service sits behind an interface (`MailTransport`,
  `PhoneVerifier`, `AiProvider`, `ModerationClassifier`, `ObjectStore`,
  `PaymentProvider`, `Alerter`); switch by config, never by rewrite.
- **Quota guards**: each free quota has an app-side counter, a 70% alert and a defined
  degraded mode at 100%.

## Hard rules

- **Third-party services**: use only new dedicated "Joutiya" projects. Never write
  to an existing project on those accounts.
- **Secrets**: never put keys, tokens or `.env` in Git, PRs, logs or chat. Only
  `.env.example` (no values) is versioned.
- **Legal**: publisher Adark Prime; the only address to display is 6 rue
  d'Armaillé, 75017 Paris. Never use or ask for a personal address. Legal form,
  capital and VAT are config variables, never hardcoded. The platform is a neutral
  host (explicit disclaimers for buyer/seller disputes).
- **Security**: OWASP by design (XSS, CSRF, Firestore injection, strict CORS,
  sanitized uploads), rate limiting (search, sign-up, messaging, listing creation),
  strict roles: visitor / individual / pro / admin.

## Model and effort

- Never change Cody's model or effort level: the owner sets them personally. The repo
  pins only `model: opus` (Opus 5.5). Ultracode and effort live in the owner's own
  Cody config, never in committed settings: cloud threads (Sonnet research and
  triage included) share this checkout and would inherit them.
- Code, debug and graphic design work (logo, UI, visual identity) must run on
  Opus 5.5 with ultracode on. If the session runs another model or ultracode is
  off, remind the owner in French (one line) at the start of the task, then continue.
- Search, triage and research go to subagents / workflow agents on Sonnet (Haiku for
  trivial lookups). Keep Opus for code, debug, design and verification.
- Never launch a workflow without `ultracode` on, the `ultracode` keyword, or
  `/effort ultracode`.

## Context economy

- Read only the files you need; rely on this file instead of re-scanning the repo.
  Don't re-read a file unless it changed. Skip files over 100KB unless required.
- Thorough in reasoning, concise in output. No openers, closing fluff or emojis.
- Never guess APIs, versions, flags or package names: verify in code or docs first.
- Skills in `.claude/skills/`: `frontend-design` for any UI work (premium look is
  a requirement), `webapp-testing` to check UI in a browser before handing back,
  `gemini-crosscheck` to second-check public-info research (free tier: no user, listing
  or repo data).
- Do not read `node_modules/`, `.next/`, `dist/`, `build/`, `coverage/` or lockfiles
  unless specifically needed.
- Delegate verbose output (tests, logs, web docs) to a subagent that returns only a
  summary.
- Keep this file under 200 lines; specialized procedures go in a Skill
  (`.claude/skills/`), not here.

## Commands

Node 24; `npm ci --ignore-scripts` once.
- `npm run check`: lint, typecheck, unit tests, guard tests. `npm run test:rules`: Firestore rules in the
  emulator (Java 21). `npm run build`, then `npm run test:e2e` (Playwright; in the cloud set
  `PLAYWRIGHT_CHROMIUM_PATH`). `shellcheck infra/vm/*.sh` for the VM scripts.
- `node scripts/assert-target.ts`: validate `infra/targets.json` (exact third-party
  identifiers). With `APP_ENV` set it also checks the configured identifiers, and it always
  checks the owner's `JOUTIYA_*_TUNNEL_TOKEN`, e.g.
  `node --env-file=.env.local scripts/assert-target.ts`; never print env file values.
  Unit tests: `node --test scripts/assert-target.test.ts` (run in CI).
- Owner-machine scripts, dry run unless `--apply`: `scripts/cloudflare.ts` (edge config),
  `scripts/legal-config.ts` (Firestore `config/legal`); `scripts/deploy-prod.ts` promotes,
  rolls back and syncs the VM files. Steps in `docs/phase-1.md`, rebuild in `infra/redeploy.md`.
- Image: `docker build -f docker/Dockerfile --target web` (or `worker`); Compose in `docker/`.

# Compact instructions

Keep: owner decisions, files changed, unresolved errors, next step. Drop tool
output already acted on.
