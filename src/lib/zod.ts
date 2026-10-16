import { z } from "zod";

// Zod 4 compiles object parsers with `new Function` when eval is allowed, and probes for it with
// `Function("")` the first time an object schema is defined. Under our CSP (no 'unsafe-eval')
// the browser reports that probe as a violation even though zod catches the throw. `jitless`
// skips the probe and keeps the interpreted parser everywhere (same results, tiny payloads).
// Every module imports zod from here so the setting runs before the first schema is defined
// (ESLint `no-restricted-imports`).
z.config({ jitless: true });

export * from "zod";
