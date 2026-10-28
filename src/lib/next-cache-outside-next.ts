// Stands in for "next/cache" in the worker bundle (scripts/build-node.ts). Node's ESM loader cannot
// load the package path "next/cache" (next has no exports map), and the worker has no ISR cache to
// invalidate anyway: like the real function outside a request, this throws, and revalidate.ts
// logs and swallows it.
export function revalidatePath(): never {
  throw new Error("revalidatePath is unavailable outside the Next.js server");
}
