import { formatAlert, type Alert, type AlertChannel } from "./types";

/** Telegram Bot API sendMessage: free, rings on the owner's phone (Z5). */
export class TelegramChannel implements AlertChannel {
  readonly name = "telegram";

  constructor(
    private readonly token: string,
    private readonly chatId: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(alert: Alert, env: string): Promise<void> {
    const response = await this.fetchImpl(`https://api.telegram.org/bot${this.token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: this.chatId,
        text: formatAlert(alert, env),
        disable_web_page_preview: true,
        disable_notification: alert.severity === "info",
      }),
      signal: AbortSignal.timeout(5_000),
    });
    // The token is part of the URL: never include the URL or the body in the error.
    if (!response.ok) throw new Error(`telegram: HTTP ${response.status}`);
  }
}
