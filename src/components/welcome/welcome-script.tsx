import { WELCOME_SCRIPT } from "@/lib/welcome/script";

/** Inline pre-paint script, right after ThemeScript: decides the welcome threshold before the body paints. */
export function WelcomeScript({ nonce }: { nonce?: string }) {
  // eslint-disable-next-line no-restricted-syntax, react/no-danger -- constant script, pinned by hash (inline-hashes.ts)
  return <script nonce={nonce} dangerouslySetInnerHTML={{ __html: WELCOME_SCRIPT }} />;
}
