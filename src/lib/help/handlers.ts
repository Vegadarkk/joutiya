import "server-only";
import { anonymous, beginAnonymous, respond } from "@/lib/auth/anonymous";
import { optionalUser } from "@/lib/auth/guards";
import { askAssistant } from "@/lib/ai/assistant";
import { assistantRequestSchema, type AssistantResponse, type HelpHit } from "@/lib/contracts/assistant";
import { readJson } from "@/lib/http/json";
import { escalateOnIp } from "@/lib/listings/escalation";
import { enforceLimit } from "@/lib/rate-limit/limiter";
import { loadHelpArticles, searchHelp } from "./search";

// POST /api/assistant (design phase-5 D25, AF §6 and §7): visitors and members, same origin. Limits
// before any other work, all "closed" (the AI budget is at stake: a store outage answers 503):
// 20 per hour and 50 per day per account (signed in) or device, 200 per day per IP /64, then
// Turnstile. The session only picks the limiter key: no account read, nothing about the person
// in the prompt. The AI being unavailable is not an error: 200 with the matching help articles.

const SEARCH_LIMIT = 4;

async function ask(request: Request): Promise<Response> {
  const flow = beginAnonymous(request);
  const input = await readJson(request, assistantRequestSchema);
  const viewer = await optionalUser(request);
  const subject = viewer ? `u:${viewer.user.uid}` : flow.identity.deviceKey;
  await enforceLimit("assistant.device.hour", subject);
  await enforceLimit("assistant.device.day", subject);
  if (await escalateOnIp(request, "assistant.ip", flow.device, input.turnstileToken, "assistant")) flow.turnstilePassed = true;

  const articles = await loadHelpArticles(input.locale);
  const outcome = await askAssistant({ locale: input.locale, question: input.question, history: input.history, articles });
  if (outcome.mode === "ai") {
    const bySlug = new Map(articles.map((article) => [article.slug, article]));
    const cited = outcome.cited.flatMap((slug): HelpHit[] => {
      const article = bySlug.get(slug);
      return article ? [{ slug, title: article.title, summary: article.summary }] : [];
    });
    return respond<AssistantResponse>(flow, { mode: "ai", answer: outcome.answer, articles: cited });
  }
  return respond<AssistantResponse>(flow, { mode: "search", articles: await searchHelp(input.locale, input.question, SEARCH_LIMIT, articles) });
}

/** POST /api/assistant (device and Turnstile pass cookies on every answer, errors included). */
export const handleAssistant = anonymous(ask);
