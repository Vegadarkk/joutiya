import { lazy, type ComponentType } from "react";

// Lazy islands of the root layouts (header menus, toast container). React.lazy throws during render
// when its chunk cannot be downloaded (a tab opened before a redeploy asks for a chunk the new image
// no longer has, a dropped mobile connection), and these islands have no error boundary closer than
// global-error, which would replace the whole page. They degrade to a plain fallback instead.

/** React.lazy that renders `fallback` when the chunk fails to load, for the rest of the page's life (a reload brings the new chunks). */
export function lazyIsland<P extends object>(load: () => Promise<{ default: ComponentType<P> }>, fallback: NoInfer<ComponentType<P>>) {
  return lazy<ComponentType<P>>(() => load().catch(() => ({ default: fallback })));
}
