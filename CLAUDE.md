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

## Project state (2026-10-05)

- No application code yet. The owner must **validate the architecture** (exact
  stack, folder tree, DB schemas, MVP roadmap) **before any code is generated**.
- The owner picks the logo from several concepts before brand integration.
- Fill in the Architecture section below once validated.

## Architecture

_Not validated. Do not invent a stack or folder structure._
Planned services (not configured): Firestore (Auth + DB), Cloudflare (CDN + media),
RevenueCat, Google Ads, Hostinger (hosting, domain joutiya.ma).

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
  a requirement), `webapp-testing` to check UI in a browser before handing back.
- Do not read `node_modules/`, `.next/`, `dist/`, `build/`, `coverage/` or lockfiles
  unless specifically needed.
- Delegate verbose output (tests, logs, web docs) to a subagent that returns only a
  summary.
- Keep this file under 200 lines; specialized procedures go in a Skill
  (`.claude/skills/`), not here.

# Compact instructions

Keep: owner decisions, files changed, unresolved errors, next step. Drop tool
output already acted on.
