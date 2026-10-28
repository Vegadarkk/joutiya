import { useTranslations } from "next-intl";
import type { PublicShopPayment } from "@/lib/contracts/seller-payment";
import { cn } from "@/lib/utils";

// The distance seller's information of a shop that takes payments (law 31-08, art. 29), shown on
// its storefront while « Payer chez le vendeur » or cash on delivery is on. The Pro fills it and
// alone answers for the sale; the platform stays the host.

export function SellerInfo({ payment, className }: { payment: PublicShopPayment; className?: string }) {
  const t = useTranslations("SellerPayment.info");
  const rows: { key: string; label: string; value: string; ltr?: boolean }[] = [
    { key: "name", label: t("name"), value: payment.shopName },
    { key: "ice", label: t("ice"), value: payment.ice, ltr: true },
    { key: "address", label: t("address"), value: payment.info.address },
    { key: "email", label: t("email"), value: payment.info.email, ltr: true },
    { key: "delivery", label: t("delivery"), value: payment.info.delivery },
    { key: "returns", label: t("returns"), value: payment.info.returns },
  ];
  return (
    <section aria-labelledby="seller-info" className={cn("flex flex-col gap-4 rounded-lg border border-border bg-surface p-5 sm:p-6", className)}>
      <div className="flex flex-col gap-1">
        <h2 id="seller-info" className="text-lg font-semibold">
          {t("title")}
        </h2>
        <p className="text-sm text-foreground-muted text-pretty">{t("lead")}</p>
      </div>
      <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-[minmax(0,10rem)_1fr]">
        {rows.map((row) => (
          <div key={row.key} className="contents">
            <dt className="font-medium text-foreground-muted">{row.label}</dt>
            <dd dir={row.ltr ? "ltr" : "auto"} className="min-w-0 break-words whitespace-pre-line text-pretty">
              {row.value}
            </dd>
          </div>
        ))}
      </dl>
      <p className="border-t border-border pt-3 text-xs text-foreground-muted text-pretty">{t("prices")}</p>
    </section>
  );
}
