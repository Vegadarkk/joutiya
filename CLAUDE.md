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

## Context economy

- Read only the files you need; rely on this file instead of re-scanning the repo.
- Do not read `node_modules/`, `.next/`, `dist/`, `build/`, `coverage/` or lockfiles
  unless specifically needed.
- Delegate verbose output (tests, logs, web docs) to a subagent that returns only a
  summary.
- Keep this file under 200 lines; specialized procedures go in a Skill
  (`.claude/skills/`), not here.

# Compact instructions

Keep: owner decisions, files changed, unresolved errors, next step. Drop tool
output already acted on.
