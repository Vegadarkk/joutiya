import { TriangleAlert } from "lucide-react";
import type { HelpBlock } from "@/content/help";
import type { Locale } from "@/config/site";

// Body of a help article (design phase-5 D25): paragraphs, bullet lists, numbered steps (only for
// real sequences) and caution notes, in the reading measure of the legal pages.

/** French typography: no line break before « : ; ! ? » or after «. */
function frenchSpacing(text: string): string {
  return text.replace(/ ([:;!?»])/g, " $1").replace(/« /g, "« ");
}

export function ArticleBody({ blocks, locale }: { blocks: readonly HelpBlock[]; locale: Locale }) {
  const text = (value: string) => (locale === "fr" ? frenchSpacing(value) : value);
  return (
    <div className="flex flex-col gap-5 text-base leading-7">
      {blocks.map((block, index) => {
        const key = `${index}`;
        if (typeof block === "string") return <p key={key}>{text(block)}</p>;
        if ("list" in block) {
          return (
            <ul key={key} className="flex list-disc flex-col gap-2 ps-5 marker:text-featured">
              {block.list.map((item) => (
                <li key={item}>{text(item)}</li>
              ))}
            </ul>
          );
        }
        if ("steps" in block) {
          return (
            <ol key={key} className="flex flex-col gap-3">
              {block.steps.map((item, step) => (
                <li key={item} className="flex gap-3">
                  <span
                    aria-hidden="true"
                    className="flex size-7 shrink-0 items-center justify-center rounded-full bg-structure text-sm font-semibold text-structure-foreground tabular-nums"
                  >
                    {step + 1}
                  </span>
                  <span className="pt-0.5">{text(item)}</span>
                </li>
              ))}
            </ol>
          );
        }
        return (
          <p key={key} className="flex gap-3 border-s-4 border-featured bg-warning-surface/60 px-4 py-3 font-medium">
            <TriangleAlert className="mt-1 size-4 shrink-0 text-warning" aria-hidden="true" />
            <span>{text(block.note)}</span>
          </p>
        );
      })}
    </div>
  );
}
