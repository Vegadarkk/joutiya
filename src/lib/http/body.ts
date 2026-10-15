// Bounded request bodies (§6, abuse row). Content-Length is only a hint (absent on chunked
// bodies), so the read itself stops at the cap: an oversized body is never held in memory.

/** Text of `body`, or null as soon as it exceeds `max` bytes (the rest is never read). */
export async function readCapped(body: ReadableStream<Uint8Array> | null, max: number): Promise<string | null> {
  if (!body) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
}
