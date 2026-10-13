import { useFormatter, useTranslations } from "next-intl";
import { Container } from "@/components/layout/container";
import { fill, type Block, type LegalText, type LegalValues } from "@/content/legal/fr";
import type { Locale } from "@/config/site";

interface LegalPageProps {
  locale: Locale;
  title: string;
  text: LegalText;
  values: LegalValues;
  /** Phase 1 texts are provisional (§10); the final ones come with phase 6. */
  provisional?: boolean;
}

/** French typography: no line break before « : ; ! ? » or after «. */
function frenchSpacing(text: string): string {
  return text.replace(/ ([:;!?»])/g, "\u00a0$1").replace(/« /g, "«\u00a0");
}

function render(text: string, values: LegalValues): string {
  return frenchSpacing(fill(text, values));
}

function BlockView({ block, values }: { block: Block; values: LegalValues }) {
  if (typeof block === "string") return <p>{render(block, values)}</p>;
  return (
    <ul className="flex list-disc flex-col gap-1.5 ps-5 marker:text-featured">
      {block.list.map((item) => (
        <li key={item}>{render(item, values)}</li>
      ))}
    </ul>
  );
}

/**
 * A legal document: French is authoritative (§7), so on the Arabic and Tarifit interfaces the
 * body stays in French with a note, while the title and the chrome follow the locale.
 */
export function LegalPage({ locale, title, text, values, provisional = true }: LegalPageProps) {
  const t = useTranslations("Legal");
  const format = useFormatter();
  const foreign = locale !== "fr";
  const updated = format.dateTime(new Date(`${text.updated}T12:00:00Z`), { dateStyle: "long" });
  const toc = text.sections.length > 2;

  return (
    <Container className="py-10 sm:py-14">
      <header className="max-w-[68ch]">
        <h1 className="text-3xl font-semibold text-balance sm:text-4xl">{title}</h1>
        <p className="mt-3 text-sm text-foreground-muted">{t("updated", { date: updated })}</p>
        {provisional || foreign ? (
          <aside className="mt-6 flex flex-col gap-1 border-s-4 border-featured bg-surface-muted px-4 py-3 text-sm">
            {provisional ? (
              <>
                <p className="font-medium">{t("provisionalTitle")}</p>
                <p className="text-foreground-muted">{t("provisionalBody")}</p>
              </>
            ) : null}
            {foreign ? <p className="text-foreground-muted">{t("frenchPrevails")}</p> : null}
          </aside>
        ) : null}
      </header>

      <div className={toc ? "mt-10 grid gap-10 lg:grid-cols-[15rem_minmax(0,68ch)] lg:gap-14" : "mt-10 max-w-[68ch]"}>
        {toc ? (
          <nav aria-labelledby="legal-toc" className="lg:sticky lg:top-24 lg:self-start">
            <h2 id="legal-toc" className="mb-3 text-sm font-semibold">
              {t("contents")}
            </h2>
            <ol lang="fr" dir="ltr" className="flex flex-col gap-2 border-s border-border ps-4 text-sm">
              {text.sections.map((section) => (
                <li key={section.id}>
                  <a href={`#${section.id}`} className="text-foreground-muted hover:text-foreground hover:underline">
                    {section.heading}
                  </a>
                </li>
              ))}
            </ol>
          </nav>
        ) : null}

        <article lang="fr" dir="ltr" className="flex min-w-0 flex-col gap-10 leading-relaxed">
          {text.intro ? <p className="text-lg text-pretty">{render(text.intro, values)}</p> : null}
          {text.sections.map((section) => (
            <section key={section.id} id={section.id} aria-labelledby={`${section.id}-h`} className="scroll-mt-24">
              <h2 id={`${section.id}-h`} className="mb-3 text-xl font-semibold text-balance">
                {section.heading}
              </h2>
              <div className="flex flex-col gap-3 text-pretty">
                {section.blocks.map((block, index) => (
                  <BlockView key={index} block={block} values={values} />
                ))}
              </div>
            </section>
          ))}
        </article>
      </div>
    </Container>
  );
}
