import type { ReactElement } from "react";
import type * as NextNavigation from "next/navigation";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import fr from "../../messages/fr.json";
import { FavoriteButton, type FavoriteButtonProps } from "@/components/favorites/favorite-button";
import type * as AuthClient from "@/lib/auth/client";
import type { SessionSummary } from "@/lib/contracts/auth";
import type { FavoritesState } from "@/lib/favorites/client";

// A click on the heart (D17) with a signed-in session: the server render gives the button's click
// handler, run here against a mocked favorites store. A click while the listing's request is in
// flight must change nothing and announce nothing (setFavorite ignores it).

const store = vi.hoisted(() => ({
  state: undefined as unknown as FavoritesState,
  setFavorite: vi.fn<(listingId: string, favorite: boolean) => Promise<void>>(),
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof NextNavigation>()),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn(), back: vi.fn(), forward: vi.fn() }),
  usePathname: () => "/fr/recherche",
}));
vi.mock("@/lib/auth/client", async (importOriginal) => {
  const session = { uid: "u1" } as SessionSummary;
  return {
    ...(await importOriginal<typeof AuthClient>()),
    useSession: () => ({ status: "ready", session }),
    loadSession: async () => session,
  };
});
vi.mock("@/lib/favorites/client", () => ({
  useFavorites: () => store.state,
  favoritesSnapshot: () => store.state,
  loadFavoriteIds: async () => undefined,
  forgetFavorites: () => undefined,
  setFavorite: store.setFavorite,
}));
vi.mock("sonner", () => ({ toast: { success: store.success, error: store.error } }));

/** Renders the heart and returns its click handler. */
function heart(props: FavoriteButtonProps): () => void {
  let click: (() => void) | undefined;
  function Capture() {
    const element = FavoriteButton(props) as ReactElement<{ onClick: () => void }>;
    click = element.props.onClick;
    return element;
  }
  renderToStaticMarkup(
    <NextIntlClientProvider locale="fr" messages={fr} timeZone="Africa/Casablanca">
      <Capture />
    </NextIntlClientProvider>,
  );
  if (!click) throw new Error("no click handler");
  return click;
}

/** Lets the async handler run to its end. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("FavoriteButton click", () => {
  beforeEach(() => {
    store.setFavorite.mockReset().mockResolvedValue(undefined);
    store.success.mockReset();
    store.error.mockReset();
  });

  it("adds a listing and confirms it", async () => {
    store.state = { status: "ready", uid: "u1", ids: new Set(), busy: new Set() };
    heart({ listingId: "abcd2345" })();
    await settle();
    expect(store.setFavorite).toHaveBeenCalledWith("abcd2345", true);
    expect(store.success).toHaveBeenCalledWith(fr.Favorites.button.added, expect.anything());
  });

  it("ignores a click while the listing's removal is in flight, without an 'added' toast", async () => {
    // The removal already took the id out of `ids` (optimistic), so the click reads as "add".
    store.state = { status: "ready", uid: "u1", ids: new Set(), busy: new Set(["abcd2345"]) };
    heart({ listingId: "abcd2345" })();
    await settle();
    expect(store.setFavorite).not.toHaveBeenCalled();
    expect(store.success).not.toHaveBeenCalled();
    expect(store.error).not.toHaveBeenCalled();
  });
});
