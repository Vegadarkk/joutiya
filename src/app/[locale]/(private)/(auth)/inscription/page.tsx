import type { Metadata } from "next";
import { headers } from "next/headers";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { AuthShell } from "@/components/auth/auth-shell";
import { SignupForm } from "@/components/auth/signup-form";
import { Link, redirect } from "@/i18n/navigation";
import { pageLocale } from "@/i18n/params";
import { currentMember } from "@/lib/auth/current-user";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const locale = pageLocale((await params).locale);
  const t = await getTranslations({ locale, namespace: "Auth.signUp" });
  return { title: t("title") };
}

export default async function SignUpPage({ params }: { params: Promise<{ locale: string }> }) {
  const locale = pageLocale((await params).locale);
  setRequestLocale(locale);
  if (await currentMember()) redirect({ href: "/parametres", locale });
  const t = await getTranslations({ locale, namespace: "Auth.signUp" });
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <AuthShell
      title={t("title")}
      lead={t("lead")}
      footer={
        <p>
          {t("hasAccount")}{" "}
          <Link href="/connexion" className="font-medium text-link underline-offset-2 hover:underline">
            {t("signIn")}
          </Link>
        </p>
      }
    >
      <SignupForm nonce={nonce} />
    </AuthShell>
  );
}
