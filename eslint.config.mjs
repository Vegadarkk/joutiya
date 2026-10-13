import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([".next/**", "dist/**", "coverage/**", "playwright-report/**", "test-results/**", "next-env.d.ts", "workers/*/.wrangler/**"]),
  {
    rules: {
      // XSS (§6): raw HTML injection is never needed; the CSP hook and React escaping do the rest.
      "react/no-danger": "error",
      "no-restricted-syntax": [
        "error",
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message: "dangerouslySetInnerHTML is forbidden (XSS, §6).",
        },
      ],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
      eqeqeq: ["error", "always"],
      "no-console": ["error", { allow: ["warn", "error"] }],
    },
  },
  {
    // Scripts and tests print on purpose.
    files: ["scripts/**", "tests/**", "**/*.test.ts", "workers/**"],
    rules: { "no-console": "off" },
  },
]);
