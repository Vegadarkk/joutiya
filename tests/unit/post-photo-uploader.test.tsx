import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";
import ar from "../../messages/ar.json";
import fr from "../../messages/fr.json";
import { PhotoUploader } from "@/components/post/photo-uploader";
import type { Locale } from "@/config/site";
import type { PhotoItem } from "@/lib/listings/client/store";

// Photo errors of the wizard's photo step: the upload cap (409 upload_limit at sign time) gets a
// short tile text and one banner saying what to do; other API codes keep their Listing.errors text.

const noop = () => undefined;

function failed(key: string, errorCode: string): PhotoItem {
  return { key, uploadId: null, status: "failed", progress: 0, previewUrl: null, photo: null, errorCode };
}

function render(photos: PhotoItem[], locale: Locale = "fr") {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={locale === "ar" ? ar : fr}>
      <PhotoUploader photos={photos} maxPhotos={10} onAdd={noop} onRemove={noop} onRetry={noop} onRefresh={noop} onMove={noop} />
    </NextIntlClientProvider>,
  );
}

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, " ").trim();

describe("PhotoUploader errors", () => {
  it("explains the upload cap once, with a short text on each refused tile", () => {
    const html = text(render([failed("a", "upload_limit"), failed("b", "upload_limit")]));
    expect(html.split(fr.Listing.errors.upload_limit)).toHaveLength(2);
    expect(html.split(fr.Listing.photos.uploadLimit)).toHaveLength(3);
    expect(fr.Listing.errors.upload_limit).toContain("7 jours");
  });

  it("says it in Arabic too", () => {
    const html = text(render([failed("a", "upload_limit")], "ar"));
    expect(html).toContain(ar.Listing.errors.upload_limit);
    expect(html).toContain(ar.Listing.photos.uploadLimit);
  });

  it("keeps the other codes on their tile, without the banner", () => {
    const html = text(render([failed("a", "photo_limit"), failed("b", "storage_full")]));
    expect(html).toContain(fr.Listing.errors.photo_limit);
    expect(html).toContain(fr.Listing.errors.storage_full);
    expect(html).not.toContain(fr.Listing.errors.upload_limit);
    expect(html).not.toContain(fr.Listing.photos.uploadLimit);
  });
});
