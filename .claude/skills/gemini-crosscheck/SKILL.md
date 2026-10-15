---
name: gemini-crosscheck
description: Second opinion from Gemini on public-information research (pricing, quotas, regulations, API behavior) before presenting findings. Never for code, user, listing or repo data.
---

# Gemini cross-check

Use after you have written your own answer to a research question whose facts come
from outside the repo (service pricing and free quotas, legal texts, library or API
behavior) and being wrong would cost the owner money or rework. Ask Gemini the same
question, compare, and report every disagreement with the better-sourced side.
Do not defer to Gemini: a disputed point is settled in the official docs, not by vote.

Verified 2026-10-15: Interactions API, `gemini-3.8-flash` and `gemini-3.5-flash-lite`
both answer; the 429 and 503 paths below were exercised.

Gemini answers from training data and lags on recent facts (on 2026-10-15 it denied its
own model name existed). Google Search grounding (`tools:[{type:"google_search"}]`) is
not available on this free key: it returned 429 "exceeded your current quota" while plain
calls worked (2026-10-15), so do not send it. Hence: a stale or "unsure" answer is no
evidence either way; use the cross-check for stable facts (legal texts, long-standing API
behavior, arithmetic, reasoning gaps), not to confirm current prices, quotas or model
names, which only the official page settles.

## Hard rules

- Key: `GEMINI_API_KEY` from the cloud environment, checked by name only
  (`[ -n "$GEMINI_API_KEY" ]`). Never print, echo, log or commit it; `printenv` and
  `env` are denied by `.claude/settings.json` anyway. Absent key: skip the cross-check
  and say so in one line.
- The key lives in the owner's global environment and shares its free quota with his
  other projects: research use only, never imported by product code.
- Free tier: Google may use prompts and answers to improve its products and human
  reviewers may read them. Send **public information only**: no user or listing data,
  no repo code or file contents, no secrets, no owner personal or legal details,
  nothing from `.env*`. Product use is excluded (EU users need the paid terms).
- Daily request quota is small: group related questions into one prompt, keep it under
  ~2k tokens, one call per research topic.

## Call

Endpoint and header per https://ai.google.dev/gemini-api/docs/quickstart. Models:
`gemini-3.8-flash` (stable default), `gemini-3.5-flash-lite` (cheaper). On a 404 for
the model, re-read https://ai.google.dev/gemini-api/docs/models and update this file.

```bash
OUT="$SCRATCHPAD/gemini.json"   # scratchpad dir, never the repo
MODEL="${MODEL:-gemini-3.8-flash}"
Q="Answer concisely and cite official source URLs. Say 'unsure' when unsure.

$QUESTION"
[ -n "$GEMINI_API_KEY" ] || { echo "GEMINI_API_KEY absent: cross-check skipped"; exit 0; }
code=$(jq -n --arg q "$Q" --arg m "$MODEL" '{model:$m,input:$q}' |
  curl -sS --max-time 60 -o "$OUT" -w '%{http_code}' -X POST \
    "https://generativelanguage.googleapis.com/v1beta/interactions" \
    -H "x-goog-api-key: $GEMINI_API_KEY" -H "Content-Type: application/json" -d @-)
case "$code" in
  200) jq -r '.steps[]|select(.type=="model_output")|.content[]|select(.type=="text")|.text' "$OUT" ;;
  429) echo "Gemini 429 (quota)" ;;
  *)   echo "Gemini HTTP $code"; jq -c '.error // empty' "$OUT" ;;
esac
```

The response also holds a `thought` step and a `signature` blob: extract only
`model_output`, never dump the raw body into the thread.

## Errors

- 429: wait 60 s, retry once; still 429: report "cross-check skipped (quota)" and go on.
  Never loop.
- 400 or 403 on the key: tell the owner in one French line; do not retry.
- 503 ("high demand"), other 5xx or timeout: retry once with
  `MODEL=gemini-3.5-flash-lite`, then skip.

## Report

In the owner reply (French, brief): one line per disagreement, "point: my answer /
Gemini's answer / verdict with source". No disagreement: one line "recoupé avec Gemini,
aucun écart". The Gemini raw output stays in the scratchpad.
