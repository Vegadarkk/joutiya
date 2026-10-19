import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fr from "../../messages/fr.json";
import { clampIndex, Gallery, GALLERY_SIZES, stepForKey, targetIndex, type GalleryProps } from "@/components/listing/gallery";
import { createTrackNavigator } from "@/components/listing/gallery-track";
import { isolate } from "@/lib/i18n/bidi";

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
  it("makes the first photo the LCP image; the others are not in the server HTML (they mount when idle)", () => {
    const html = render();
    const images = slides(html);
    expect(images).toHaveLength(1);
    const [first] = images as [string];
    expect(first).toContain('fetchPriority="high"');
    expect(first).toContain('loading="eager"');
    expect(first).not.toContain("lazy");
    // React hoists a matching preload for the high-priority image.
    expect(html).toMatch(/<link rel="preload" as="image" imageSrcSet="[^"]*photo0001-s\.webp 480w[^"]*" imageSizes="[^"]*" fetchPriority="high"\/>/);
    // Every slide is there (blurhash, button that opens the lightbox); the lazy images of the others
    // mount after hydration (e2e listing.spec.ts checks loading="lazy" on them).
    expect(html.match(/cursor-zoom-in/g)).toHaveLength(3);
    expect(html).not.toContain("photo0002-l.webp");
  });

  it("serves both WebP variants through srcset and sizes with the intrinsic size", () => {
    const [first] = slides(render()) as [string];
    expect(first).toContain(`src="${MEDIA}/listings/abcd2345/photo0001-l.webp"`);
    expect(first).toContain(`srcSet="${MEDIA}/listings/abcd2345/photo0001-s.webp 480w, ${MEDIA}/listings/abcd2345/photo0001-l.webp 1600w"`);
    expect(first).toContain(`sizes="${GALLERY_SIZES}"`);
    expect(first).toContain('width="1600" height="1200"');
    // Portrait and smaller-than-small candidates: listing-photo.test.ts (srcSetOf).
    // The seller's title is bidi-isolated inside the translated alt text.
    expect(first).toContain(`alt="${isolate("Vélo de ville")}, photo 1 sur 3"`);
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

  it("makes the track a named, focusable scroller for the keyboard", () => {
    expect(render()).toMatch(/<ul tabindex="0" aria-label="Photos : faites défiler pour voir la suite"/i);
  });

  it("shows an empty state without photo or without a media host", () => {
    for (const html of [render({ photos: [] }), render({ mediaBaseUrl: null })]) {
      expect(html).not.toContain("<img");
      expect(html).toContain(fr.ListingPage.gallery.empty.replace("'", "&#x27;"));
      expect(html).toContain('data-testid="gallery"');
    }
  });
});

describe("gallery navigation", () => {
  it("moves one photo per arrow key, mirrored in right-to-left pages, and jumps with Home and End", () => {
    expect(stepForKey("ArrowRight", false)).toBe(1);
    expect(stepForKey("ArrowLeft", false)).toBe(-1);
    expect(stepForKey("ArrowRight", true)).toBe(-1);
    expect(stepForKey("ArrowLeft", true)).toBe(1);
    expect(stepForKey("Home", true)).toBe("first");
    expect(stepForKey("End", false)).toBe("last");
    expect(stepForKey("Enter", false)).toBeNull();
  });

  it("starts from the photo in view and stays inside the track", () => {
    // From the second photo, "next" is the third, not the second (the lightbox counter bug).
    expect(targetIndex(1, 1, 3)).toBe(2);
    expect(targetIndex(1, 2, 3)).toBe(2);
    expect(targetIndex(-1, 0, 3)).toBe(0);
    expect(targetIndex(-1, 2, 3)).toBe(1);
    expect(targetIndex("first", 2, 3)).toBe(0);
    expect(targetIndex("last", 0, 3)).toBe(2);
    expect(clampIndex(5, 2)).toBe(1);
    expect(clampIndex(-1, 2)).toBe(0);
    expect(clampIndex(0, 0)).toBe(0);
  });
});

/** A scroll-snap track 360 px wide: smooth scrolls only record their target, the test moves it. */
class FakeTrack {
  clientWidth = 360;
  scrollLeft = 0;
  readonly targets: number[] = [];
  constructor(
    readonly direction: "ltr" | "rtl" = "ltr",
    private readonly instant = false,
  ) {}
  scrollTo({ left }: { left: number }) {
    this.targets.push(left);
    if (this.instant) this.scrollLeft = left;
  }
  /** The photo a recorded scroll was heading to. */
  photo(at = this.targets.length - 1): number {
    return Math.abs(this.targets[at] ?? 0) / this.clientWidth;
  }
}

describe("track navigation during a smooth scroll", () => {
  beforeEach(() => {
    vi.stubGlobal("getComputedStyle", (element: FakeTrack) => ({ direction: element.direction }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const track = (direction: "ltr" | "rtl" = "ltr", instant = false) => new FakeTrack(direction, instant);
  const element = (fake: FakeTrack) => fake as unknown as HTMLElement;

  it("moves two photos for two presses made before the first scroll is halfway", () => {
    const fake = track();
    const nav = createTrackNavigator();
    nav.goTo(element(fake), nav.at(element(fake), 4, 0) + 1, 4);
    expect(fake.photo()).toBe(1);
    // 100 ms later the scroll is under halfway: the position alone still says photo 1 of 4 (index 0).
    fake.scrollLeft = 120;
    nav.onScroll(element(fake), 4);
    nav.goTo(element(fake), nav.at(element(fake), 4, 0) + 1, 4);
    expect(fake.photo()).toBe(2);
    // Past halfway to its photo, the position takes over again (and agrees).
    fake.scrollLeft = 560;
    nav.onScroll(element(fake), 4);
    expect(nav.at(element(fake), 4, 0)).toBe(2);
  });

  it("mirrors the scroll in right-to-left pages and keeps the target there too", () => {
    const fake = track("rtl");
    const nav = createTrackNavigator();
    nav.goTo(element(fake), 1, 4);
    fake.scrollLeft = -90;
    nav.goTo(element(fake), nav.at(element(fake), 4, 0) + 1, 4);
    expect(fake.targets).toEqual([-360, -720]);
  });

  it("keeps the target across a scroll cut short by the next one, and drops it once the track rests elsewhere", () => {
    const fake = track();
    const nav = createTrackNavigator();
    nav.goTo(element(fake), 2, 4);
    // scrollend between two photos: the first scroll was interrupted, not finished.
    fake.scrollLeft = 300;
    nav.onScrollEnd(element(fake));
    expect(nav.at(element(fake), 4, 0)).toBe(2);
    // Resting on a photo (another scroll put it there): the position is the truth again.
    fake.scrollLeft = 0;
    nav.onScrollEnd(element(fake));
    expect(nav.at(element(fake), 4, 0)).toBe(0);
  });

  it("follows the visitor who takes over the track mid-scroll", () => {
    const fake = track();
    const nav = createTrackNavigator();
    nav.goTo(element(fake), 3, 4);
    fake.scrollLeft = 200;
    nav.settle();
    expect(nav.at(element(fake), 4, 0)).toBe(1);
  });

  it("keeps nothing pending after an instant scroll or a step that cannot move", () => {
    const instant = track("ltr", true);
    const nav = createTrackNavigator();
    nav.goTo(element(instant), 2, 4);
    instant.scrollLeft = 0;
    expect(nav.at(element(instant), 4, 0)).toBe(0);

    const last = track();
    last.scrollLeft = 3 * 360;
    nav.goTo(element(last), 5, 4);
    expect(last.photo()).toBe(3);
    last.scrollLeft = 360;
    expect(nav.at(element(last), 4, 0)).toBe(1);
    // Without a track (not mounted yet), the index in state answers.
    expect(nav.at(null, 4, 2)).toBe(2);
  });
});
