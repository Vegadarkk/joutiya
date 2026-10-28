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

  it("says when to come back on a spent daily Firestore quota (503 quota_exhausted)", () => {
    expect(text(render([failed("a", "quota_exhausted")]))).toContain(fr.Listing.errors.quota_exhausted);
    expect(text(render([failed("a", "quota_exhausted")], "ar"))).toContain(ar.Listing.errors.quota_exhausted);
  });
});

describe("PhotoUploader counter", () => {
  const ready = (key: string): PhotoItem => ({ key, uploadId: key, status: "ready", progress: 1, previewUrl: null, photo: null });
  const withFile = (item: PhotoItem): PhotoItem => ({ ...item, status: "rejected", file: new File(["x"], "x.jpg", { type: "image/jpeg" }) });

  it("leaves failed and refused tiles out of the count and the room", () => {
    const html = text(render([ready("a"), ready("b"), failed("c", "network"), withFile(failed("d", "nsfw"))]));
    expect(html).toContain("2 / 10 photos");
    expect(html).toContain("Vous pouvez encore ajouter 8 photos.");
  });

  it("disables the retry of a refused tile when every slot is taken", () => {
    const full = Array.from({ length: 10 }, (_, index) => ready(`r${index}`));
    const html = render([...full, withFile(failed("x", "network"))]);
    expect(text(html)).toContain("10 / 10 photos");
    expect(html).toMatch(/<button[^>]*aria-label="Réessayer la photo 11"[^>]*disabled=""/);
  });
});

describe("PhotoUploader faces", () => {
  const ready = (key: string, faces?: number): PhotoItem => ({ key, uploadId: key, status: "ready", progress: 1, previewUrl: null, photo: null, ...(faces ? { faces } : {}) });

  function renderWithCrop(photos: PhotoItem[], locale: Locale = "fr") {
    return renderToStaticMarkup(
      <NextIntlClientProvider locale={locale} messages={locale === "ar" ? ar : fr}>
        <PhotoUploader photos={photos} maxPhotos={10} onAdd={noop} onRemove={noop} onRetry={noop} onRefresh={noop} onMove={noop} onCrop={noop} />
      </NextIntlClientProvider>,
    );
  }

  it("marks a photo with a face, offers its crop and says a kept face goes to a moderator", () => {
    const html = renderWithCrop([ready("a"), ready("b", 2)]);
    expect(text(html)).toContain("Visage détecté sur 1 photo");
    expect(text(html)).toContain("un modérateur vérifiera l'annonce");
    expect(html.match(/data-testid="photo-face"/g)).toHaveLength(1);
    expect(html).toContain('aria-label="Recadrer la photo 2"');
    expect(html).not.toContain('aria-label="Recadrer la photo 1"');
  });

  it("says nothing without faces, and offers no crop without a handler", () => {
    expect(text(renderWithCrop([ready("a")]))).not.toContain("Visage détecté");
    const html = render([ready("a", 1)]);
    expect(text(html)).toContain(fr.Listing.photos.faces.bodyNoCrop);
    expect(html).not.toContain("Recadrer la photo");
  });

  it("says it in Arabic too", () => {
    const html = text(renderWithCrop([ready("a", 1)], "ar"));
    expect(html).toContain(ar.Listing.photos.faces.tile);
    expect(html).toContain(ar.Listing.photos.faces.body);
  });
});
