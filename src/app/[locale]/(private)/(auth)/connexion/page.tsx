import type { Metadata } from "next";
import { headers } from "next/headers";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { AuthShell } from "@/components/auth/auth-shell";
import { LoginForm } from "@/components/auth/login-form";
import { Link, redirect } from "@/i18n/navigation";
import { pageLocale } from "@/i18n/params";
import { currentMember } from "@/lib/auth/current-user";
import { afterSignInTarget, safeNextPath } from "@/lib/auth/next-path";

type Props = { params: Promise<{ locale: string }>; searchParams: Promise<{ next?: string | string[] }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const locale = pageLocale((await params).locale);
  const t = await getTranslations({ locale, namespace: "Auth.signIn" });
  return { title: t("title") };
}

export default async function SignInPage({ params, searchParams }: Props) {
  const locale = pageLocale((await params).locale);
  setRequestLocale(locale);
  // Already signed in: straight to the page the person wanted (same `next` check as the form).
  if (await currentMember()) {
    const target = afterSignInTarget((await searchParams).next);
    redirect({ href: target.pathname, locale: target.locale ?? locale });
  }
  const t = await getTranslations({ locale, namespace: "Auth.signIn" });
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
          {t("noAccount")}{" "}
          <Link href={next ? { pathname: "/inscription", query: { next } } : "/inscription"} className="font-medium text-link underline-offset-2 hover:underline">
            {t("create")}
          </Link>
        </p>
      }
    >
      <LoginForm nonce={nonce} />
    </AuthShell>
  );
}
