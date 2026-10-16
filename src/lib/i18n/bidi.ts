// Unicode bidi isolates for values placed inside translated text: a French title in the Arabic UI
// (or the reverse) keeps its own direction and punctuation, and a phone number keeps its digit
// groups in order under dir="rtl". Plain characters, so they also work in aria-label, title and
// ICU arguments, where a <bdi> element cannot go.

const FSI = "⁨"; // first strong isolate: direction taken from the value's first strong letter
const LRI = "⁦"; // left-to-right isolate: digits, "+" and spaces stay left to right
const PDI = "⁩"; // pop directional isolate

/** User text (titles, names) inside a translated string. */
export function isolate(value: string): string {
  return value ? `${FSI}${value}${PDI}` : value;
}

/** Phone numbers, codes and other left-to-right tokens inside a translated string. */
export function isolateLtr(value: string): string {
  return value ? `${LRI}${value}${PDI}` : value;
}
