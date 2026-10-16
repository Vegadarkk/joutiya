import type { Metadata } from "next";
import { headers } from "next/headers";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { AuthShell } from "@/components/auth/auth-shell";
import { LoginForm } from "@/components/auth/login-form";
import { Link, redirect } from "@/i18n/navigation";
import { pageLocale } from "@/i18n/params";
import { currentMember } from "@/lib/auth/current-user";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const locale = pageLocale((await params).locale);
  const t = await getTranslations({ locale, namespace: "Auth.signIn" });
  return { title: t("title") };
}

export default async function SignInPage({ params }: { params: Promise<{ locale: string }> }) {
  const locale = pageLocale((await params).locale);
  setRequestLocale(locale);
  // Already signed in: nothing to do here.
  if (await currentMember()) redirect({ href: "/parametres", locale });
  const t = await getTranslations({ locale, namespace: "Auth.signIn" });
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <AuthShell
      title={t("title")}
      lead={t("lead")}
      footer={
        <p>
          {t("noAccount")}{" "}
          <Link href="/inscription" className="font-medium text-link underline-offset-2 hover:underline">
            {t("create")}
          </Link>
        </p>
      }
    >
      <LoginForm nonce={nonce} />
    </AuthShell>
  );
}
