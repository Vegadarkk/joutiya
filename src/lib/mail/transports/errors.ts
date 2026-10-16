// Provider failures carry whether a retry makes sense: 429 and 5xx (and network errors) do,
// a rejected address or payload does not. BullMQ retries the former; deliverMail logs the latter.

export class ProviderError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number | undefined,
    readonly retryable: boolean,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/** Leading integer of a header value ("12", "12/100", "12 emails"), or undefined. */
export function leadingInt(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const match = /^\s*(\d+)/.exec(value);
  return match ? Number(match[1]) : undefined;
}

/** Error body `{ name, message }` of a provider, read defensively (never throws, never logs secrets). */
export async function readErrorBody(response: Response): Promise<{ name?: string; message?: string }> {
  try {
    const text = (await response.text()).slice(0, 2_000);
    const parsed = JSON.parse(text) as Record<string, unknown>;
    return {
      name: typeof parsed["name"] === "string" ? parsed["name"] : typeof parsed["code"] === "string" ? parsed["code"] : undefined,
      message: typeof parsed["message"] === "string" ? parsed["message"].slice(0, 300) : undefined,
    };
  } catch {
    return {};
  }
}

export const SEND_TIMEOUT_MS = 10_000;

/** fetch() failures (DNS, reset, timeout) are transient from the queue's point of view. */
export function networkError(provider: string, error: unknown): ProviderError {
  const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return new ProviderError(provider, undefined, true, `${provider}: network failure (${reason.slice(0, 200)})`);
}
