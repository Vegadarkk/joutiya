import "server-only";
import { logger } from "@/lib/logging/logger";
import type { MailJob, TemplateId } from "./types";

export type { ActionLinkRequest, MailJob, MailPriority, MailTransport, RenderedMail, SendResult, TemplateData, TemplateId, TemplateMail } from "./types";

// Entry point of the auth routes and the worker: render the template in the user's locale and
// enqueue it (or send it inline when no queue is configured). The implementation lives in
// ./send.ts (phase 2 mail module); until it is wired, mails are only logged.

export async function sendMail<T extends TemplateId>(mail: MailJob<T>): Promise<void> {
  const { enqueueMail } = await import("./send");
  try {
    await enqueueMail(mail);
  } catch (error) {
    logger.error({ template: mail.template, err: (error as Error).message }, "mail enqueue failed");
    throw error;
  }
}
