import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The sign-in, sign-up and account forms and the posting wizard validate the same way, "onTouched"
// (a field's error appears once it is left, then follows every change): the two funnels must not
// feel different, and react-hook-form's default (errors on submit only) is never relied on. No DOM
// runner is installed, so each form's source is checked instead of its behaviour.

const COMPONENTS = path.resolve(__dirname, "../../src/components");

/** useForm calls expected per file: every form of the auth funnel and the two text steps of the wizard. */
const FORMS: Record<string, number> = {
  "auth/login-form.tsx": 1,
  "auth/signup-form.tsx": 1,
  "auth/forgot-form.tsx": 1,
  "auth/resend-verification.tsx": 1,
  "auth/google-consent-step.tsx": 1,
  "auth/settings-view.tsx": 2,
  "auth/verifications-view.tsx": 1,
  "auth/action-view.tsx": 1,
  "post/steps/title-step.tsx": 1,
  "post/steps/description-step.tsx": 1,
};

/** The options object of each useForm({ … }) call of a source, braces balanced. */
function formOptions(source: string): string[] {
  const options: string[] = [];
  const open = /\buseForm(?:<[^(]*>)?\(\{/g;
  for (let match = open.exec(source); match; match = open.exec(source)) {
    const start = match.index + match[0].length - 1;
    let depth = 0;
    for (let i = start; i < source.length; i += 1) {
      if (source[i] === "{") depth += 1;
      else if (source[i] === "}") {
        depth -= 1;
        if (depth === 0) {
          options.push(source.slice(start, i + 1));
          break;
        }
      }
    }
  }
  return options;
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? filesUnder(full) : [full];
  });
}

describe("form validation mode", () => {
  it.each(Object.entries(FORMS))("%s validates onTouched in each of its %i useForm call(s)", (file, calls) => {
    const options = formOptions(readFileSync(path.join(COMPONENTS, file), "utf8"));
    expect(options).toHaveLength(calls);
    for (const option of options) {
      expect(option).toContain('mode: "onTouched"');
      expect(option).not.toContain("reValidateMode");
    }
  });

  it("leaves no form of the auth funnel or of the wizard on another mode", () => {
    for (const dir of ["auth", "post"]) {
      for (const file of filesUnder(path.join(COMPONENTS, dir)).filter((name) => name.endsWith(".tsx"))) {
        for (const option of formOptions(readFileSync(file, "utf8"))) {
          expect(option, path.relative(COMPONENTS, file)).toContain('mode: "onTouched"');
        }
      }
    }
  });

  it("reads the options of a useForm call whatever its generics and layout", () => {
    const source = 'useForm<A, unknown, B>({ resolver: r, defaultValues: { a: { b: "" } }, mode: "onTouched" });\nuseForm({\n  mode: "onBlur",\n});';
    expect(formOptions(source)).toEqual(['{ resolver: r, defaultValues: { a: { b: "" } }, mode: "onTouched" }', '{\n  mode: "onBlur",\n}']);
  });
});
