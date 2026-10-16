import type { Metadata } from "next";
import { headers } from "next/headers";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { AuthShell } from "@/components/auth/auth-shell";
import { SignupForm } from "@/components/auth/signup-form";
import { Link, redirect } from "@/i18n/navigation";
import { pageLocale } from "@/i18n/params";
import { currentMember } from "@/lib/auth/current-user";
import { afterSignInTarget, safeNextPath } from "@/lib/auth/next-path";

type Props = { params: Promise<{ locale: string }>; searchParams: Promise<{ next?: string | string[] }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const locale = pageLocale((await params).locale);
  const t = await getTranslations({ locale, namespace: "Auth.signUp" });
  return { title: t("title") };
}

export default async function SignUpPage({ params, searchParams }: Props) {
  const locale = pageLocale((await params).locale);
  setRequestLocale(locale);
  if (await currentMember()) {
    const target = afterSignInTarget((await searchParams).next);
    redirect({ href: target.pathname, locale: target.locale ?? locale });
  }
  const t = await getTranslations({ locale, namespace: "Auth.signUp" });
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  // The link to the other flow keeps a valid `next`.
  const raw = (await searchParams).next;
  const next = safeNextPath(Array.isArray(raw) ? raw[0] : raw);
  return (
    <AuthShell
      title={t("title")}
      lead={t("lead")}
      footer={
        <p>
          {t("hasAccount")}{" "}
          <Link href={next ? { pathname: "/connexion", query: { next } } : "/connexion"} className="font-medium text-link underline-offset-2 hover:underline">
            {t("signIn")}
          </Link>
        </p>
      }
    >
      <SignupForm nonce={nonce} />
    </AuthShell>
  );
}
