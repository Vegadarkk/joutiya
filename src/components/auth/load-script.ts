// Third-party scripts (Turnstile, Google Identity Services) are injected once per page with the
// request nonce, so the private CSP ('nonce' + 'strict-dynamic') accepts them (§6).

const loading = new Map<string, Promise<void>>();

export function loadScript(src: string, nonce?: string): Promise<void> {
  const existing = loading.get(src);
  if (existing) return existing;
  const promise = new Promise<void>((resolve, reject) => {
    if (typeof document === "undefined") {
      reject(new Error("loadScript: no document"));
      return;
    }
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    if (nonce) script.nonce = nonce;
    script.onload = () => resolve();
    script.onerror = () => {
      loading.delete(src);
      script.remove();
      reject(new Error(`loadScript: ${src} failed`));
    };
    document.head.appendChild(script);
  });
  loading.set(src, promise);
  return promise;
}
