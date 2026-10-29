import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ReactNode } from "react";
import type * as NextNavigation from "next/navigation";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import fr from "../../messages/fr.json";
import { FavoriteButton } from "@/components/favorites/favorite-button";
import { Gallery } from "@/components/listing/gallery";
import { ListingCard } from "@/components/listing/listing-card";
import { ChipRadioGroup } from "@/components/post/controls/chips";
import { Button } from "@/components/ui/button";
import { ListingGridSkeleton, PageSkeleton } from "@/components/feedback/skeletons";
import { KhatamLoader } from "@/components/ui/khatam-loader";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { quietLinkClassName, textLinkClassName } from "@/components/ui/text-link";
import { Toaster, toastMotionClassName } from "@/components/ui/toaster";
import type { PublicListingCard } from "@/lib/listings/public";

// C7 polish pass: one set of interaction states. Press = scale .98 in 150 ms on the door curve
// (with `scale` in the transition: Tailwind v4 scales with that property, not `transform`); focus =
// the global solid outline on controls, a border plus halo on text fields, a soft halo only on
// programmatic focus targets; links never pop their underline; skeletons stand still under reduced
// motion; toasts enter and leave with opacity and 8 px.

const sonnerProps = vi.hoisted(() => ({ current: null as null | Record<string, unknown> }));
vi.mock("sonner", () => ({
  Toaster: (props: Record<string, unknown>) => {
    sonnerProps.current = props;
    return null;
  },
}));
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof NextNavigation>()),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn(), back: vi.fn(), forward: vi.fn() }),
  usePathname: () => "/fr",
}));

function render(node: ReactNode) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="fr" messages={fr} timeZone="Africa/Casablanca">
      {node}
    </NextIntlClientProvider>,
  );
}

/** The class attribute of the first element matching `tag` (and `marker` inside the tag, if given). */
function classOf(html: string, tag: string, marker = ""): string[] {
  const match = new RegExp(`<${tag}\\b[^>]*${marker}[^>]*>`).exec(html);
  const value = match && /class="([^"]*)"/.exec(match[0]);
  if (!value) throw new Error(`no <${tag}> with a class in ${html}`);
  return value[1]!.replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&").split(/\s+/);
}

const transitioned = (classes: string[]) => classes.find((name) => name.startsWith("transition-[")) ?? "";

describe("Button", () => {
  it("animates the press it shows", () => {
    const classes = classOf(renderToStaticMarkup(<Button>Publier</Button>), "button");
    expect(classes).toContain("active:scale-[0.98]");
    expect(transitioned(classes)).toMatch(/[[,]scale[\],]/);
    expect(classes).toEqual(expect.arrayContaining(["duration-150", "ease-door"]));
    // The global :focus-visible outline, not a local ring.
    expect(classes.filter((name) => name.includes("focus-visible:"))).toEqual([]);
  });

  it("fades the danger hover instead of snapping it", () => {
    const classes = classOf(renderToStaticMarkup(<Button variant="danger">Supprimer</Button>), "button");
    expect(classes).toContain("hover:opacity-90");
    expect(transitioned(classes)).toContain("opacity");
  });

  it("keeps the link variant still and moves its underline instead", () => {
    const classes = classOf(renderToStaticMarkup(<Button variant="link">Conditions</Button>), "button");
    expect(classes).toEqual(expect.arrayContaining(["underline", "decoration-current/40", "underline-offset-4", "hover:decoration-current", "hover:underline-offset-2", "active:scale-100"]));
    expect(classes).not.toContain("hover:no-underline");
    expect(transitioned(classes)).toBe("transition-[color,text-decoration-color,text-underline-offset]");
  });
});

describe("text links", () => {
  it("never toggle the underline line, which cannot transition", () => {
    for (const className of [textLinkClassName, quietLinkClassName]) {
      const classes = className.split(" ");
      expect(classes).toContain("underline");
      expect(classes.some((name) => name.endsWith("no-underline") || /^[\w-]+:underline$/.test(name))).toBe(false);
      expect(transitioned(classes)).toContain("text-decoration-color");
      expect(classes).toEqual(expect.arrayContaining(["duration-150", "ease-door"]));
    }
    expect(quietLinkClassName.split(" ")).toEqual(expect.arrayContaining(["decoration-transparent", "hover:decoration-current"]));
  });

  it("fade the listing card title underline in when the card is hovered", () => {
    const listing: PublicListingCard = {
      id: "abcd2345",
      slugId: "velo-abcd2345",
      title: "Vélo de ville",
      subcategoryId: "velos",
      price: 1500,
      priceNegotiable: false,
      isDonation: false,
      citySlug: "casablanca",
      photo: null,
      photoCount: 0,
      sellerType: "individual",
      sortAt: "2026-10-16T10:00:00.000Z",
    };
    const html = render(<ListingCard listing={listing} mediaBaseUrl={null} locale="fr" />);
    const classes = classOf(html, "a", 'dir="auto"');
    expect(classes).toEqual(expect.arrayContaining(["decoration-transparent", "group-hover:decoration-current"]));
    expect(classes).not.toContain("group-hover:underline");
  });
});

describe("Skeleton", () => {
  it("is a still cream block, without the shine sweep", () => {
    const classes = classOf(renderToStaticMarkup(<Skeleton className="h-4" />), "div");
    expect(classes).toEqual(["rounded-md", "bg-skeleton", "h-4"]);
  });

  it("keeps the blocks and lays one khatam over the region, the status named in text", () => {
    for (const html of [renderToStaticMarkup(<ListingGridSkeleton label="Chargement de vos favoris" />), renderToStaticMarkup(<PageSkeleton label="Chargement" />)]) {
      expect(html).toMatch(/^<div role="status" aria-busy="true" class="relative/);
      expect(html.match(/data-testid="skeleton-loader"/g)).toHaveLength(1);
      expect(html.match(/data-loader="khatam"/g)).toHaveLength(1);
      expect(html.match(/class="rounded-md bg-skeleton/g)?.length).toBeGreaterThan(4);
    }
  });
});

describe("KhatamLoader", () => {
  it("is a gold khatam, hidden from assistive technology unless it carries a label", () => {
    const decorative = renderToStaticMarkup(<KhatamLoader />);
    expect(decorative).toBe('<span aria-hidden="true" data-loader="khatam" class="khatam size-[2.125rem] [--khatam-stroke:2.5px] text-gold-500 dark:text-gold-300"></span>');
    const status = renderToStaticMarkup(<KhatamLoader size="lg" label="Chargement des annonces…" />);
    expect(status).toMatch(/^<span role="status" class="inline-flex"><span aria-hidden="true" data-loader="khatam" class="khatam size-12 /);
    expect(status).toContain('<span class="sr-only">Chargement des annonces…</span>');
  });

  it("stands in for the spinner of buttons, in the text's size and colour", () => {
    expect(renderToStaticMarkup(<Spinner />)).toBe('<span aria-hidden="true" data-loader="khatam" class="khatam size-[1.1em] [--khatam-stroke:0.1em]"></span>');
    const button = renderToStaticMarkup(<Button loading>Publier</Button>);
    expect(button).toContain('aria-busy="true"');
    expect(button).toContain('data-loader="khatam"');
  });

  it("stays still under reduced motion", () => {
    const css = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src/styles/globals.css"), "utf8");
    const rule = /@utility khatam \{[\s\S]*?\n\}/.exec(css)?.[0] ?? "";
    expect(rule).toContain("animation: khatam-turn 3.2s linear infinite;");
    expect(rule).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*animation: none;/);
  });
});

describe("Toaster", () => {
  it("moves a toast 8 px with opacity, only when motion is welcome", () => {
    const classes = toastMotionClassName.split(" ");
    expect(classes).toContain("motion-safe:data-[mounted=false]:[--y:translateY(-8px)]!");
    expect(classes).toContain("motion-safe:data-[removed=true]:data-[front=true]:data-[swipe-out=false]:[--y:translateY(-8px)]!");
    expect(classes).toContain("motion-safe:[transition-duration:200ms]!");
    expect(classes.every((name) => name.startsWith("motion-safe:"))).toBe(true);
  });

  it("hands the motion to every toast, on the reading side", () => {
    render(<Toaster dir="rtl" />);
    const props = sonnerProps.current as { position: string; toastOptions: { className: string } };
    expect(props.position).toBe("top-left");
    expect(props.toastOptions.className.split(" ")).toEqual(expect.arrayContaining(["font-sans", ...toastMotionClassName.split(" ")]));
  });
});

describe("controls", () => {
  it("give chips press feedback and the global focus outline", () => {
    const html = renderToStaticMarkup(<ChipRadioGroup label="État" options={[{ value: "new", label: "Neuf" }]} value="new" onChange={() => undefined} />);
    const classes = classOf(html, "button");
    expect(classes).toContain("active:scale-[0.98]");
    expect(transitioned(classes)).toContain("scale");
    expect(classes.filter((name) => name.includes("focus-visible:"))).toEqual([]);
  });

  it("ring the visible disc of the favorite heart, not its 44 px target, with no photo in between", () => {
    const classes = classOf(render(<FavoriteButton listingId="abcd2345" />), "button");
    expect(classes).toEqual(expect.arrayContaining(["outline-none", "[&:focus-visible>span]:outline-2", "[&:focus-visible>span]:outline-offset-0", "[&:focus-visible>span]:outline-ring"]));
    expect(transitioned(classOf(render(<FavoriteButton listingId="abcd2345" />), "span", 'class="inline-flex size-9'))).toContain("scale");
  });
  it("draw the gallery focus inside, on top of the photo, with a surface band against any picture", () => {
    const photos = [
      { id: "photo0001", w: 1600, h: 1200, blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj" },
      { id: "photo0002", w: 1600, h: 1200, blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj" },
    ];
    const html = render(<Gallery listingId="abcd2345" title="Vélo" photos={photos} mediaBaseUrl="https://media.joutiya.test" />);
    const band = "focus-visible:after:shadow-[inset_0_0_0_2px_var(--ring),inset_0_0_0_4px_var(--surface)]";
    for (const classes of [classOf(html, "button", "cursor-zoom-in"), classOf(html, "button", 'aria-current="true"')]) {
      expect(classes).toEqual(expect.arrayContaining(["focus-visible:outline-none", "focus-visible:after:absolute", "focus-visible:after:inset-0", band]));
      expect(classes.some((name) => name.startsWith("focus-visible:ring"))).toBe(false);
    }
  });
});

// Source guards over every component and page.
const SRC = fileURLToPath(new URL("../../src", import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? sources(full) : /\.tsx?$/.test(name) ? [full] : [];
  });
}

describe("interaction state guards", () => {
  const files = sources(SRC).map((file) => ({ file: path.relative(SRC, file), text: readFileSync(file, "utf8") }));

  it("never transitions `transform`: Tailwind v4 moves, scales and rotates with their own properties", () => {
    const offenders = files.flatMap(({ file, text }) => (text.match(/transition-\[[^\]]*\btransform\b[^\]]*\]/g) ?? []).map((list) => `${file}: ${list}`));
    expect(offenders).toEqual([]);
  });

  it("keeps translucent focus halos to text fields and programmatic focus targets", () => {
    // Home sections are outside the polish pass (owned by the welcome work at the time).
    const PENDING = new Set(["components/home/category-grid.tsx"]);
    const offenders = files.flatMap(({ file, text }) =>
      PENDING.has(file)
        ? []
        : text
            .split("\n")
            .filter((line) => /focus-visible:ring-ring\/\d+/.test(line) && !line.includes("focus-visible:border-ring") && !line.includes("tabIndex={-1}"))
            .map((line) => `${file}: ${line.trim().slice(0, 120)}`),
    );
    expect(offenders).toEqual([]);
  });
});
