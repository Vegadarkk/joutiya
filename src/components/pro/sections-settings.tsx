"use client";

import { useState, type FormEvent } from "react";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { FormMessage } from "@/components/auth/form-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SHOP_SECTIONS_MAX, SHOP_SECTION_NAME_MAX, type ShopSection } from "@/lib/contracts/catalog";
import type { ProSelfView } from "@/lib/contracts/pro";
import { firstStrictIssue } from "@/lib/moderation/free-text";
import { saveSections } from "@/lib/pro/client";

// The storefront's sections in the Pro area (catalogue §5): up to 12 names (« Ramadan », « Rentrée »),
// in the order of the storefront tabs. A listing joins one from « Mes annonces ». Names follow the
// storefront text screen, live here and again on the server.

type Row = { key: string; id?: string; name: string };

let rowCount = 0;
const rowOf = (section?: ShopSection): Row => ({ key: `row-${(rowCount += 1)}`, ...(section ? { id: section.id, name: section.name } : { name: "" }) });

export function SectionsSettings({ shop }: { shop: Pick<ProSelfView, "sections"> }) {
  const t = useTranslations("Pro.sections");
  const issues = useTranslations("FreeText");
  const [saved, setSaved] = useState<ShopSection[]>(shop.sections);
  const [rows, setRows] = useState<Row[]>(() => shop.sections.map(rowOf));
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);

  const names = rows.map((row) => row.name.trim());
  const issueOf = (name: string) => (name ? firstStrictIssue(name) : null);
  const duplicate = (index: number) => names[index] !== "" && names.findIndex((name) => name.toLocaleLowerCase("fr") === names[index]?.toLocaleLowerCase("fr")) !== index;
  const invalid = rows.some((_, index) => names[index] === "" || issueOf(names[index] ?? "") !== null || duplicate(index));
  const dirty = JSON.stringify(rows.map((row) => [row.id ?? null, row.name.trim()])) !== JSON.stringify(saved.map((section) => [section.id, section.name]));

  function move(index: number, by: -1 | 1) {
    setRows((current) => {
      const next = [...current];
      const [row] = next.splice(index, 1);
      if (row) next.splice(index + by, 0, row);
      return next;
    });
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !dirty || invalid) return;
    setPending(true);
    setFailure(null);
    try {
      const result = await saveSections({ sections: rows.map((row) => ({ ...(row.id ? { id: row.id } : {}), name: row.name.trim() })) });
      setSaved(result.sections);
      setRows(result.sections.map(rowOf));
      toast.success(t("saved"));
    } catch (caught) {
      setFailure(caught);
    } finally {
      setPending(false);
    }
  }

  return (
    <section aria-labelledby="pro-sections" data-testid="sections-settings" className="flex flex-col gap-5 rounded-lg border border-border bg-surface p-5">
      <header className="flex flex-col gap-1">
        <h2 id="pro-sections" className="text-lg font-semibold">
          {t("title")}
        </h2>
        <p className="text-sm text-foreground-muted text-pretty">{t("lead")}</p>
      </header>
      <form onSubmit={(event) => void onSubmit(event)} noValidate className="flex flex-col gap-4">
        {rows.length > 0 ? (
          <ol className="flex flex-col gap-2">
            {rows.map((row, index) => {
              const issue = issueOf(names[index] ?? "");
              const problem = issue ? issues(issue) : duplicate(index) ? t("duplicate") : null;
              return (
                <li key={row.key} className="flex flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <span className="w-5 shrink-0 text-end text-sm text-foreground-muted tabular-nums">{index + 1}</span>
                    <Input
                      value={row.name}
                      maxLength={SHOP_SECTION_NAME_MAX}
                      aria-label={t("nameOf", { index: index + 1 })}
                      aria-invalid={problem ? true : undefined}
                      placeholder={t("placeholder")}
                      dir="auto"
                      className="min-w-0 flex-1"
                      onChange={(event) => setRows((current) => current.map((entry) => (entry.key === row.key ? { ...entry, name: event.target.value } : entry)))}
                    />
                    <Button type="button" variant="ghost" size="sm" className="size-11 shrink-0 px-0" aria-label={t("up", { index: index + 1 })} disabled={index === 0} onClick={() => move(index, -1)}>
                      <ArrowUp aria-hidden="true" />
                    </Button>
                    <Button type="button" variant="ghost" size="sm" className="size-11 shrink-0 px-0" aria-label={t("down", { index: index + 1 })} disabled={index === rows.length - 1} onClick={() => move(index, 1)}>
                      <ArrowDown aria-hidden="true" />
                    </Button>
                    <Button type="button" variant="ghost" size="sm" className="size-11 shrink-0 px-0 text-danger" aria-label={t("remove", { index: index + 1 })} onClick={() => setRows((current) => current.filter((entry) => entry.key !== row.key))}>
                      <Trash2 aria-hidden="true" />
                    </Button>
                  </div>
                  {problem ? <p className="ps-7 text-sm text-danger">{problem}</p> : null}
                </li>
              );
            })}
          </ol>
        ) : (
          <p className="rounded-md bg-surface-muted px-3 py-2 text-sm text-foreground-muted text-pretty">{t("empty")}</p>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" variant="outline" size="sm" className="max-sm:h-11" disabled={rows.length >= SHOP_SECTIONS_MAX} onClick={() => setRows((current) => [...current, rowOf()])}>
            <Plus aria-hidden="true" />
            {t("add")}
          </Button>
          <span className="text-sm text-foreground-muted tabular-nums">{t("count", { count: rows.length, max: SHOP_SECTIONS_MAX })}</span>
        </div>
        {failure ? <FormMessage error={failure} title={t("failed")} /> : null}
        <Button type="submit" loading={pending} disabled={!dirty || invalid} className="self-start">
          {t("save")}
        </Button>
      </form>
    </section>
  );
}
