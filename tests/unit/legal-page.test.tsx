import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";
import fr from "../../messages/fr.json";
import { LegalPage } from "@/components/legal/legal-page";
import { DEFAULT_LEGAL } from "@/config/legal";
import { LEGAL_TEXTS } from "@/content/legal/fr";
import { legalValues } from "@/content/legal/mentions";

// Optional mentions (`ifSet` blocks): the CNDP sentence appears only with a receipt number (C2-05).

function privacyPage(cndpReceiptNo: string): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="fr" messages={fr} timeZone="Africa/Casablanca">
      <LegalPage locale="fr" title="Confidentialité" text={LEGAL_TEXTS.confidentialite} values={legalValues({ ...DEFAULT_LEGAL, cndpReceiptNo })} />
    </NextIntlClientProvider>,
  );
}

describe("LegalPage optional blocks", () => {
  it("leaves the CNDP sentence out while no declaration is filed", () => {
    const html = privacyPage("");
    expect(html).not.toContain("Déclaration auprès de la CNDP");
    expect(html).not.toContain("en cours</p>");
    // The rights paragraph around it still renders.
    expect(html).toContain("la CNDP (cndp.ma).");
  });

  it("renders it with the receipt number once configured", () => {
    expect(privacyPage("D-123/2027")).toContain("<p>Déclaration auprès de la CNDP : récépissé n° D-123/2027.</p>");
  });
});
