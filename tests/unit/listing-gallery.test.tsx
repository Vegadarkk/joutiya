import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";
import fr from "../../messages/fr.json";
import { Gallery, GALLERY_SIZES, type GalleryProps } from "@/components/listing/gallery";

// Server HTML of the listing gallery (design §5, §8): what the ISR page paints before hydration.

const MEDIA = "https://media.joutiya.test";
const PHOTOS: GalleryProps["photos"] = [
  { id: "photo0001", w: 1600, h: 1200, blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj" },
  { id: "photo0002", w: 1200, h: 1600, blurhash: "LKO2?U%2Tw=w]~RBVZRi};RPxuwH" },
  { id: "photo0003", w: 400, h: 300, blurhash: "not-a-blurhash" },
];

function render(props: Partial<GalleryProps> = {}) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="fr" messages={fr}>
      <Gallery listingId="abcd2345" title="Vélo de ville" photos={PHOTOS} mediaBaseUrl={MEDIA} {...props} />
    </NextIntlClientProvider>,
  );
}

/** The slides' images (the thumbnails come after the track and have an empty alt). */
function slides(html: string): string[] {
  return [...html.matchAll(/<img[^>]*>/g)].map((match) => match[0]).filter((img) => !img.includes('alt=""'));
}

describe("Gallery", () => {
  it("makes the first photo the LCP image and lazy-loads the others", () => {
    const [first, second, third] = slides(render());
    expect(first).toContain('fetchPriority="high"');
    expect(first).toContain('loading="eager"');
    expect(first).not.toContain("lazy");
    // React hoists a matching preload for the high-priority image.
    expect(render()).toMatch(/<link rel="preload" as="image" imageSrcSet="[^"]*photo0001-s\.webp 480w[^"]*" imageSizes="[^"]*" fetchPriority="high"\/>/);
    for (const img of [second, third]) {
      expect(img).toContain('loading="lazy"');
      expect(img).toContain('decoding="async"');
      expect(img).not.toContain("fetchPriority");
    }
  });

  it("serves both WebP variants through srcset and sizes with the intrinsic size", () => {
    const [first, second, third] = slides(render());
    expect(first).toContain(`src="${MEDIA}/listings/abcd2345/photo0001-l.webp"`);
    expect(first).toContain(`srcSet="${MEDIA}/listings/abcd2345/photo0001-s.webp 480w, ${MEDIA}/listings/abcd2345/photo0001-l.webp 1600w"`);
    expect(first).toContain(`sizes="${GALLERY_SIZES}"`);
    expect(first).toContain('width="1600" height="1200"');
    // Portrait: the small variant is 480 px high, 360 px wide.
    expect(second).toContain("photo0002-s.webp 360w");
    // Smaller than the small variant: one candidate only.
    expect(third).toContain(`srcSet="${MEDIA}/listings/abcd2345/photo0003-l.webp 400w"`);
    expect(first).toContain('alt="Vélo de ville, photo 1 sur 3"');
  });

  it("paints the blurhash under each photo in the server HTML, and nothing for an invalid hash", () => {
    const html = render();
    expect(html.match(/background-image:url\(&quot;data:image\/bmp;base64,/g)).toHaveLength(2);
  });

  it("shows a counter, arrows and thumbnails for several photos", () => {
    const html = render();
    expect(html).toContain('data-testid="gallery-counter"');
    expect(html).toMatch(/data-testid="gallery-counter"[^>]*>1 \/ 3</);
    expect(html).toContain(`aria-label="${fr.ListingPage.gallery.previous}"`);
    expect(html).toContain(`aria-label="${fr.ListingPage.gallery.next}"`);
    expect(html).toContain(`aria-label="${fr.ListingPage.gallery.thumbnails}"`);
    expect(html).toContain('aria-current="true"');
    expect(html).toContain("rtl:-scale-x-100");
    // Thumbnails use the small variant only.
    expect(html).toContain(`src="${MEDIA}/listings/abcd2345/photo0002-s.webp"`);
    // The lightbox is not in the HTML until opened.
    expect(html).not.toContain('role="dialog"');
  });

  it("gives each photo a button that opens the full-screen view", () => {
    const html = render();
    expect(html.match(new RegExp(fr.ListingPage.gallery.open, "g"))).toHaveLength(3);
    expect(html).toContain('aria-roledescription="carrousel"');
    expect(html).toContain('aria-label="Photos de l&#x27;annonce, 3 photos"');
  });

  it("has no counter, arrows or thumbnails for a single photo", () => {
    const html = render({ photos: PHOTOS.slice(0, 1) });
    expect(slides(html)).toHaveLength(1);
    expect(html).not.toContain("gallery-counter");
    expect(html).not.toContain(fr.ListingPage.gallery.next);
    expect(html).not.toContain(fr.ListingPage.gallery.thumbnails);
  });

  it("shows an empty state without photo or without a media host", () => {
    for (const html of [render({ photos: [] }), render({ mediaBaseUrl: null })]) {
      expect(html).not.toContain("<img");
      expect(html).toContain(fr.ListingPage.gallery.empty.replace("'", "&#x27;"));
      expect(html).toContain('data-testid="gallery"');
    }
  });
});
