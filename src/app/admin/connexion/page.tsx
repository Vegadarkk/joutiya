import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { Logo } from "@/components/layout/logo";
import { Badge } from "@/components/ui/badge";
import { currentStaff } from "@/lib/auth/current-user";
import { accessIdentity } from "@/lib/auth/guards";
import { publicConfig } from "@/lib/config/public";
import { LoginForm } from "../_components/login-form";

// Staff sign-in page, outside the protected group. The Access identity of the request prefills
// the e-mail; `?mode=setPassword&oobCode=` shows the set-password form first (invitation link).

export const metadata: Metadata = { title: "Connexion" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function StaffSignInPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const oobCode = params["oobCode"];
  const setPasswordCode =
    params["mode"] === "setPassword" && typeof oobCode === "string" && oobCode.length >= 10 && oobCode.length <= 512 ? oobCode : null;
  if (!setPasswordCode && (await currentStaff())) redirect("/");

  const requestHeaders = await headers();
  // accessIdentity works on a Request: only its headers matter here.
  const access = await accessIdentity(new Request("http://admin.invalid/", { headers: requestHeaders }));
  const nonce = requestHeaders.get("x-nonce") ?? undefined;

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center gap-8 px-4 py-12">
      <div className="flex items-center justify-between">
        <Logo label="Aalan" className="h-9" />
        <Badge variant="pro">Back-office</Badge>
      </div>
      <div className="rounded-lg border border-border border-t-[3px] border-t-structure bg-surface p-6 sm:p-8">
        <LoginForm accessEmail={access?.email ?? null} nonce={nonce} turnstileSiteKey={publicConfig().turnstileSiteKey} setPasswordCode={setPasswordCode} />
      </div>
    </main>
  );
}
