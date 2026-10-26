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

## Project state (2026-10-19)

- Architecture v3 ("start at 0 EUR") validated by the owner on 2026-10-12. Launch comes
  after every phase, run in the order P0-P5, P7, P6 (~week 19); Pro offers ship before
  launch with sales off (`salesEnabled=false`) until their own gate. Source of truth: the
  architecture doc (Claude Doc "Architecture du MVP v3"), copy in the project files as
  `joutiya/architecture-final.md`; read only the section you need (11 sections, ~220 KB).
  Deviations need the owner's approval.
- Phases 1-4 are merged on main; phase 5 (PR #53) and phase 7 (PR #56) are open. Phase 0
  waits on the `.ma` domain and the DNS switch (`docs/phase-0.md`); the VM waits for free
  A1 capacity in Paris (`docs/phase-1.md`). The 50 % audit (2026-10-19, go with
  conditions) is in the project files under `joutiya/audit-jalon-50/`.
- One image serves staging and prod: client config is served at runtime, never as
  build-time `NEXT_PUBLIC_*`.
- Brand: final logo files are in `public/brand/` (Moroccan door; ochre, green, gold, cream).
- No cloud resource is created, and no existing account completed, without the owner's
  explicit approval; all targets are listed in `infra/targets.json` and checked by
  `scripts/assert-target.ts`.

## Architecture

- **App**: one Next.js 16 (App Router, strict TypeScript, Tailwind v4, shadcn-style
  components on `radix-ui` + `cva` without the shadcn CLI, next-intl FR/AR/RIF) app + a
  BullMQ worker sharing `src/lib`; one Docker image, targets `web` and `worker`. Public
  anonymous pages: ISR + hash CSP; private pages: dynamic + nonce CSP.
  `admin.joutiya.ma` is rewritten to `src/app/admin` by `proxy.ts`.
- **Hosting**: Oracle Cloud Always Free ARM VM (Docker Compose, staging as a separate
  Compose project), Cloudflare Free in front, traffic only via Cloudflare Tunnel (no
  inbound port, SSH included). The VM holds no unique data (`infra/redeploy.md`).
- **Data**: Firebase Spark (Auth without Identity Platform, Firestore Standard, EU),
  projects dev / staging / prod. All reads and writes go through the Next.js API (server
  first, rate limited). The browser has no Firebase SDK and Firestore rules deny
  everything: live messaging is pushed by the API over SSE (`/api/messages/stream`, Valkey
  pub/sub; decision of 2026-10-19).
- **Services**: Meilisearch (search), R2 + `sharp` + local ONNX models (photos),
  Valkey x2 (queue `noeviction`, rate limit `allkeys-lru`), Resend (mail), WhatsApp
  inbound phone check (parked with Meta since 2026-10-19: messaging is the only
  buyer-seller channel, a Pro's phone is checked by an admin call at KYBC), Turnstile,
  Sentry EU, Stripe + RevenueCat (credits wallet, Pro subscriptions), Claude Haiku 5.5 /
  Sonnet 5.5 for moderation and the assistant, hard cap 5 USD/month.
- **Adapters**: every free service sits behind an interface (`MailTransport`,
  `PhoneVerifier`, `AiProvider`, `ModerationClassifier`, `ObjectStore`,
  `PaymentProvider`, `Alerter`); switch by config, never by rewrite.
- **Quota guards**: each free quota has an app-side counter, a 70% alert and a defined
  degraded mode at 100%.

## Hard rules

- **Accounts and keys**: every service gets a new, dedicated, free "Joutiya" account or
  project (owner decision, 2026-10-12); never reuse, write to or alter an existing one.
  Only the Claude cloud environment stays shared with the owner's other projects until
  Joutiya has revenue: its keys belong to those projects, so scripts read `JOUTIYA_*`
  names only (`JOUTIYA_CLOUDFLARE_API_TOKEN`, never `CLOUDFLARE_API_TOKEN`), never
  modify or delete a resource not named `joutiya-*` or not listed in `infra/targets.json`,
  and need the owner's approval to create a `joutiya-*` resource in an existing account.
- **Secrets**: never put keys, tokens or `.env` files in Git, PRs, logs or chat; print
  variable names, never values. Only `.env.example` (no values) is versioned; local
  secrets live in `.env.local`.
- **Public during development**: the repo is public since 2026-10-19 (unlimited Actions
  minutes) and goes back to private on the day the site opens to visitors (owner,
  2026-10-19; launch checklist in spec §10, phase 6). Private on GitHub Free means 2,000
  Actions minutes a month and branch protection no longer enforced. Going private erases
  nothing already published (forks, archives): never commit personal data, internal ids
  that should stay private, or anything you would not publish.
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
- Code, debug and graphic design work (logo, UI, visual identity) run on Opus 5.5 at
  effort high (owner, 2026-10-26). If the session runs another model or a lower
  effort, remind the owner in French (one line) at the start of the task, then
  continue. Do not ask for ultracode.
- Fable 5.1 is for precise points only (an audit, a hard architecture, security or
  debugging question), never routine work: suggest it to the owner in one French line
  with the reason; the owner switches the model, never Claude.
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
  a requirement), `webapp-testing` to check UI in a real browser (the repo's Node
  Playwright) before handing back, `gemini-crosscheck` to second-check public-info
  research (free tier: no user, listing or repo data).
- `.claude/settings.json` denies reading secret files (`.env`, `.env.local`, `.envrc`,
  `secrets/`, `*.pem`, service-account JSON) and generated output (`.next/`, `dist/`,
  `build/`, `coverage/`), through Read and through `cat`/`head`/`tail`/`sed` in Bash, and
  dumping the environment (`env`, `printenv`, bare `set`/`export`); `.env.example` stays
  readable. A guard, not a sandbox. Do not scan `node_modules/` or lockfiles; open one
  file there only to verify an API.
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
- Scripts, dry run unless `--apply`: `scripts/cloudflare.ts` (edge config),
  `scripts/legal-config.ts` (Firestore `config/legal`), `scripts/oracle-vm.ts` (VM by API; sync,
  promote, rollback and root scripts through OCI Run Command); `scripts/deploy-prod.ts firestore`
  (production rules), `scripts/stripe-setup.ts` (Stripe objects of the Pro plans). Steps in
  `docs/phase-1.md`, rebuild in `infra/redeploy.md`.
- Image: `docker build -f docker/Dockerfile --target web` (or `worker`); Compose in `docker/`.

# Compact instructions

Keep: owner decisions, files changed, unresolved errors, next step. Drop tool
output already acted on.
