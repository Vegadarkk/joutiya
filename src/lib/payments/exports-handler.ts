import "server-only";
import { audit } from "@/lib/audit";
import { requireStaff } from "@/lib/auth/guards";
import { HttpError, notFound, unavailable } from "@/lib/http/errors";
import { requestIdentity } from "@/lib/rate-limit/keys";
import { enforceLimit } from "@/lib/rate-limit/limiter";
import { z } from "@/lib/zod";
import { dgiRegister, dgiTotals, eReporting, EXPORT_REPORTS, urssaf, type ExportReport } from "./exports";
import { parsePeriod, receiptsOf, salesOf } from "./sales";
import { isStripeConfigured, stripeRequest } from "./stripe-api";

// GET /api/admin/exports/{report}?period= (phase 7 design §8): a tax export as a CSV download,
// admin only, every download audited. The DGI files take a quarter; URSSAF and e-reporting a month
// or a quarter. Plans come from Stripe and URSSAF's receipts need it.

type Params = { params: Promise<Record<string, string | string[] | undefined>> };

const PERIODS: Record<ExportReport, RegExp> = {
  "registre-dgi": /^\d{4}-[QT][1-4]$/,
  "totaux-dgi": /^\d{4}-[QT][1-4]$/,
  urssaf: /^\d{4}-(?:\d{2}|[QT][1-4])$/,
  "e-reporting": /^\d{4}-(?:\d{2}|[QT][1-4])$/,
};

export async function handleBillingExport(request: Request, context: Params): Promise<Response> {
  const staff = await requireStaff(request, { roles: ["admin"] });
  const report = z.enum(EXPORT_REPORTS).safeParse((await context.params).report);
  if (!report.success) throw notFound();
  const raw = new URL(request.url).searchParams.get("period") ?? "";
  const period = PERIODS[report.data].test(raw) ? parsePeriod(raw) : null;
  if (!period) throw new HttpError(400, "invalid_body", "period: a quarter (2027-T1) for the DGI files, a month (2027-03) or a quarter otherwise");
  await enforceLimit("admin.read.uid", staff.user.uid);
  const stripe = isStripeConfigured() ? stripeRequest : null;

  let body: string;
  if (report.data === "urssaf") {
    if (!stripe) throw unavailable("STRIPE_SECRET_KEY is not set: the EUR received are read from Stripe");
    const [receipts, sales] = await Promise.all([receiptsOf(period, stripe), salesOf(period, { stripe })]);
    body = urssaf(receipts, sales, period);
  } else {
    const sales = await salesOf(period, { stripe });
    body = report.data === "registre-dgi" ? dgiRegister(sales) : report.data === "totaux-dgi" ? dgiTotals(sales, period) : eReporting(sales);
  }
  await audit(
    { actorUid: staff.user.uid, actorRole: staff.role, action: "billing.export", target: { type: "export", id: `${report.data}_${period.label}` }, automated: false, ip: requestIdentity(request.headers).ip },
    { required: true },
  );
  return new Response(body, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="joutiya-${report.data}-${period.label}.csv"`,
      "cache-control": "no-store",
    },
  });
}
