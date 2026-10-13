import { THEME_SCRIPT } from "@/lib/theme/script";

/** Inline pre-paint script: first element of <body>, so the theme is set before anything paints. */
export function ThemeScript({ nonce }: { nonce?: string }) {
  // eslint-disable-next-line no-restricted-syntax, react/no-danger -- constant script, pinned by hash (inline-hashes.ts)
  return <script nonce={nonce} dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />;
}
