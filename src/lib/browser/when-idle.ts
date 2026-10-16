// Work that can wait for the first paint and hydration (error tracking, the toast container): run
// it once the main thread is idle, at the latest after `timeout` ms. Safari has no
// requestIdleCallback: a plain timer stands in. Returns a cancel function (effect cleanups).

export function whenIdle(task: () => void, timeout = 3000): () => void {
  if (typeof window.requestIdleCallback === "function") {
    const handle = window.requestIdleCallback(task, { timeout });
    return () => window.cancelIdleCallback(handle);
  }
  const handle = window.setTimeout(task, timeout / 2);
  return () => window.clearTimeout(handle);
}
