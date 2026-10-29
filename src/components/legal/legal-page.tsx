import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { useTranslations } from "next-intl";
import { Container } from "@/components/layout/container";
import { quietLinkClassName, textLinkClassName } from "@/components/ui/text-link";
import { Link } from "@/i18n/navigation";
import type { Inline, MdBlock } from "@/lib/legal/markdown";
import { cn } from "@/lib/utils";

// A legal document rendered from its Markdown source (phase 6, D11): title and version line from
// the source, a table of contents of the numbered sections, then the body. French is
// authoritative (§7): the Arabic text says so, and pages without an Arabic text (or the Tarifit
// site) show the French one with the same note.

export interface LegalPageProps {
  blocks: MdBlock[];
  /** Language of the text (may differ from the site's: Tarifit shows French). */
  language: "fr" | "ar";
  /** The text is a translation: the note that the French text prevails. */
  translated: boolean;
  /** The site is not in French but the text is: the note that only French exists. */
  frenchOnly: boolean;
  provisional?: boolean;
  /** Current text not yet in force (CGU §22.1): its date (formatted) and the version still in force. */
  upcoming?: { date: string; previous: { version: string; href: string } };
  /** Earlier versions kept online (CGU §22.4), newest first, dates formatted. */
  archive?: { version: string; from: string; replacedOn: string; href: string }[];
  /** This is an earlier version: until when it applies, and the current text. */
  archived?: { version: string; replacedOn: string; inForce: boolean; currentHref: string };
}

/** French typography: no line break before « : ; ! ? » or after «. */
function frenchSpacing(text: string): string {
  return text.replace(/ ([:;!?»])/g, " $1").replace(/« /g, "« ");
}

function InlineView({ nodes, french }: { nodes: Inline[]; french: boolean }): ReactNode {
  return nodes.map((node, index) => {
    switch (node.type) {
      case "text":
        return french ? frenchSpacing(node.value) : node.value;
      case "strong":
        return (
          <strong key={index} className="font-semibold">
            <InlineView nodes={node.children} french={french} />
          </strong>
        );
      case "em":
        return (
          <em key={index}>
            <InlineView nodes={node.children} french={french} />
          </em>
        );
      case "code":
        return (
          <code key={index} dir="ltr" className="rounded-sm bg-surface-muted px-1 py-0.5 font-mono text-[0.875em]">
            {node.value}
          </code>
        );
      case "link": {
        const children = <InlineView nodes={node.children} french={french} />;
        const className = cn("font-medium text-link", textLinkClassName);
        // Same-site paths take the locale of the page; anchors, https and mailto stay as written.
        if (node.href.startsWith("/")) {
          return (
            <Link key={index} href={node.href} className={className}>
              {children}
            </Link>
          );
        }
        const external = node.href.startsWith("https://");
        return (
          <a key={index} href={node.href} className={className} {...(external ? { rel: "noopener noreferrer" } : {})}>
            {children}
          </a>
        );
      }
    }
  });
}

function BlockView({ block, french }: { block: MdBlock; french: boolean }) {
  switch (block.type) {
    case "heading": {
      const content = <InlineView nodes={block.children} french={french} />;
      if (block.level === 2) {
        return (
          <h2 id={block.id ?? undefined} className="mt-6 scroll-mt-24 text-xl font-semibold text-balance first:mt-0">
            {content}
          </h2>
        );
      }
      return (
        <h3 id={block.id ?? undefined} className="mt-2 scroll-mt-24 text-lg font-semibold text-balance">
          {content}
        </h3>
      );
    }
    case "paragraph":
      return (
        <p className="text-pretty">
          <InlineView nodes={block.children} french={french} />
        </p>
      );
    case "list": {
      const items = block.items.map((item, index) => (
        <li key={index}>
          <InlineView nodes={item} french={french} />
        </li>
      ));
      return block.ordered ? (
        <ol start={block.start} className="flex list-decimal flex-col gap-1.5 ps-6 marker:text-foreground-muted">
          {items}
        </ol>
      ) : (
        <ul className="flex list-disc flex-col gap-1.5 ps-5 marker:text-featured">{items}</ul>
      );
    }
    case "table":
      return (
        <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
          <table className="w-full border-collapse text-start text-sm">
            <thead>
              <tr className="border-b-2 border-border-strong">
                {block.head.map((cell, index) => (
                  <th key={index} scope="col" className="px-3 py-2 text-start align-bottom font-semibold first:ps-0">
                    <InlineView nodes={cell} french={french} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex} className="border-b border-border">
                  {row.map((cell, index) => (
                    <td key={index} className="px-3 py-2 align-top first:ps-0">
                      <InlineView nodes={cell} french={french} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "rule":
      return <hr className="border-border" />;
  }
}

type Heading = Extract<MdBlock, { type: "heading" }>;

function Contents({ sections, language, className }: { sections: Heading[]; language: "fr" | "ar"; className?: string }) {
  return (
    <ol lang={language} dir={language === "fr" ? "ltr" : "rtl"} className={cn("flex flex-col gap-2 border-s border-border ps-4 text-sm", className)}>
      {sections.map((section) => (
        <li key={section.id}>
          <a href={`#${section.id}`} className={cn("text-foreground-muted hover:text-foreground", quietLinkClassName)}>
            {section.text}
          </a>
        </li>
      ))}
    </ol>
  );
}

function VersionsNote({ upcoming, archive, archived }: Pick<LegalPageProps, "upcoming" | "archive" | "archived">): ReactNode {
  const t = useTranslations("Legal");
  const link = cn("font-medium text-link", textLinkClassName);
  if (!upcoming && !archived && (archive ?? []).length === 0) return null;
  return (
    <aside data-testid="legal-versions" className="mt-4 flex max-w-[68ch] flex-col gap-1 border-s-4 border-border bg-surface-muted px-4 py-3 text-sm">
      {upcoming ? (
        <>
          <p className="font-medium">{t("upcomingTitle", { date: upcoming.date })}</p>
          <p className="text-foreground-muted">{t("upcomingBody", { version: upcoming.previous.version })}</p>
          <Link href={upcoming.previous.href} className={link}>
            {t("upcomingLink", { version: upcoming.previous.version })}
          </Link>
        </>
      ) : null}
      {archived ? (
        <>
          <p className="font-medium">{t("archivedTitle", { version: archived.version })}</p>
          <p className="text-foreground-muted">{archived.inForce ? t("archivedInForce", { date: archived.replacedOn }) : t("archivedPast", { date: archived.replacedOn })}</p>
          <Link href={archived.currentHref} className={link}>
            {t("archivedCurrent")}
          </Link>
        </>
      ) : null}
      {!upcoming && !archived && archive && archive.length > 0 ? (
        <>
          <p className="font-medium">{t("archiveTitle")}</p>
          <ul className="flex flex-col gap-0.5">
            {archive.map((entry) => (
              <li key={entry.version}>
                <Link href={entry.href} className={link}>
                  {t("archiveItem", { version: entry.version, from: entry.from, date: entry.replacedOn })}
                </Link>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </aside>
  );
}

export function LegalPage({ blocks, language, translated, frenchOnly, provisional = false, upcoming, archive, archived }: LegalPageProps) {
  const t = useTranslations("Legal");
  const french = language === "fr";
  const titleIndex = blocks.findIndex((block) => block.type === "heading" && block.level === 1);
  const title = titleIndex >= 0 ? (blocks[titleIndex] as Heading) : null;
  // The line under the title ("Version … — en vigueur le …") belongs to the header.
  const versionLine = titleIndex >= 0 && blocks[titleIndex + 1]?.type === "paragraph" ? (blocks[titleIndex + 1] as Extract<MdBlock, { type: "paragraph" }>) : null;
  const body = blocks.filter((block, index) => index !== titleIndex && block !== versionLine);
  const sections = body.filter((block): block is Heading => block.type === "heading" && block.level === 2 && block.id !== null);
  const toc = sections.length > 2;
  const dir = french ? "ltr" : "rtl";

  return (
    <Container className="py-10 sm:py-14">
      <header lang={language} dir={dir} className="max-w-[68ch]">
        <h1 className="text-3xl font-semibold text-balance sm:text-4xl">{title ? <InlineView nodes={title.children} french={french} /> : null}</h1>
        {versionLine ? (
          <p data-testid="legal-version" className="mt-3 text-sm text-foreground-muted">
            <InlineView nodes={versionLine.children} french={french} />
          </p>
        ) : null}
      </header>
      {provisional || translated || frenchOnly ? (
        <aside className="mt-6 flex max-w-[68ch] flex-col gap-1 border-s-4 border-featured bg-surface-muted px-4 py-3 text-sm">
          {provisional ? (
            <>
              <p className="font-medium">{t("provisionalTitle")}</p>
              <p className="text-foreground-muted">{t("provisionalBody")}</p>
            </>
          ) : null}
          {translated ? <p className="text-foreground-muted">{t("frenchPrevails")}</p> : null}
          {frenchOnly ? <p className="text-foreground-muted">{t("frenchOnly")}</p> : null}
        </aside>
      ) : null}
      <VersionsNote upcoming={upcoming} archive={archive} archived={archived} />

      <div className={toc ? "mt-10 grid gap-10 lg:grid-cols-[15rem_minmax(0,68ch)] lg:gap-14" : "mt-10 max-w-[68ch]"}>
        {toc ? (
          // Wide screens: a sticky column. Phones: folded, so the text starts on the first screen.
          <nav aria-labelledby="legal-toc" className="lg:sticky lg:top-24 lg:max-h-[calc(100vh-7rem)] lg:self-start lg:overflow-y-auto">
            <h2 id="legal-toc" className="mb-3 text-sm font-semibold max-lg:hidden">
              {t("contents")}
            </h2>
            <details className="group rounded-md border border-border lg:hidden">
              <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-4 text-sm font-semibold [&::-webkit-details-marker]:hidden">
                {t("contents")}
                <ChevronDown aria-hidden="true" className="size-4 shrink-0 text-foreground-muted transition-transform group-open:rotate-180" />
              </summary>
              <Contents sections={sections} language={language} className="border-s-0 px-4 pt-1 pb-4" />
            </details>
            <Contents sections={sections} language={language} className="max-lg:hidden" />
          </nav>
        ) : null}

        <article lang={language} dir={dir} className="flex min-w-0 flex-col gap-4 leading-relaxed">
          {body.map((block, index) => (
            <BlockView key={index} block={block} french={french} />
          ))}
        </article>
      </div>
    </Container>
  );
}
