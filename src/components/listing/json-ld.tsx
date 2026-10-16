import { serializeJsonLd } from "@/lib/listings/jsonld";

// Structured data block. `type="application/ld+json"` is not executable: the public hash CSP leaves
// it alone (inline-hashes.ts skips non-JS types) and serializeJsonLd escapes `<`, so the content
// can never close the element. React has no other way to print raw JSON inside <script>.

export function JsonLd({ data }: { data: unknown }) {
  // eslint-disable-next-line no-restricted-syntax, react/no-danger -- data block (not executable), escaped by serializeJsonLd
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: serializeJsonLd(data) }} />;
}
