import { randomUUID } from "node:crypto";
import type { Locale } from "@/config/site";
import type { MailTransport, RenderedMail, SendResult, TemplateData, TemplateId } from "../types";

// Development mailbox (APP_ENV=dev with DEV_MAILBOX, or no provider key): mails stay in memory and
// are read back by GET /api/dev/mailbox (e2e tests, local sign-up flows). Newest first, 500 kept.

export interface MemoryMailRecord {
  id: string;
  /** ISO timestamp of the send. */
  at: string;
  template: TemplateId;
  locale: Locale;
  to: string;
  subject: string;
  text: string;
  html: string;
  data: TemplateData[TemplateId] | Record<string, never>;
}

export interface MemoryMailFilter {
  /** Case-insensitive exact match on the recipient. */
  to?: string;
  template?: string;
}

const MAX_RECORDS = 500;
const records: MemoryMailRecord[] = [];

export function memoryMailbox(): { list(filter?: MemoryMailFilter): MemoryMailRecord[]; clear(): void } {
  return {
    list(filter = {}) {
      const to = filter.to?.trim().toLowerCase();
      return records.filter((record) => (!to || record.to.toLowerCase() === to) && (!filter.template || record.template === filter.template));
    },
    clear() {
      records.length = 0;
    },
  };
}

export class MemoryTransport implements MailTransport {
  readonly name = "memory";

  async send(mail: RenderedMail): Promise<SendResult> {
    const record: MemoryMailRecord = {
      id: randomUUID(),
      at: new Date().toISOString(),
      template: mail.meta?.template ?? "verifyEmail",
      locale: mail.meta?.locale ?? "fr",
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
      data: mail.meta?.data ?? {},
    };
    records.unshift(record);
    if (records.length > MAX_RECORDS) records.length = MAX_RECORDS;
    return { provider: this.name, id: record.id };
  }
}
