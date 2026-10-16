import type { Metadata } from "next";
import { headers } from "next/headers";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { AuthShell } from "@/components/auth/auth-shell";
import { ForgotForm } from "@/components/auth/forgot-form";
import { Link } from "@/i18n/navigation";
import { pageLocale } from "@/i18n/params";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const locale = pageLocale((await params).locale);
  const t = await getTranslations({ locale, namespace: "Auth.forgot" });
  return { title: t("title") };
}

export default async function ForgotPasswordPage({ params }: { params: Promise<{ locale: string }> }) {
  const locale = pageLocale((await params).locale);
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: "Auth.forgot" });
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <AuthShell
      title={t("title")}
      lead={t("lead")}
      footer={
        <p>
          <Link href="/connexion" className="font-medium text-link underline-offset-2 hover:underline">
            {t("back")}
          </Link>
        </p>
      }
    >
      <ForgotForm nonce={nonce} />
    </AuthShell>
  );
}
