import { EXAMPLES_SCRIPT } from "@/lib/examples/script";

/** Inline pre-paint script, after WelcomeScript: html[data-examples] from the « Masquer les annonces exemples » cookie. */
export function ExamplesScript({ nonce }: { nonce?: string }) {
  // eslint-disable-next-line no-restricted-syntax, react/no-danger -- constant script, pinned by hash (inline-hashes.ts)
  return <script nonce={nonce} dangerouslySetInnerHTML={{ __html: EXAMPLES_SCRIPT }} />;
}
