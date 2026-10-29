import { describe, expect, it } from "vitest";
import { parseSocialLink, SOCIAL_NETWORKS, socialHref, type SocialNetwork } from "@/config/social-links";
import { reasonsFor } from "@/config/report-reasons";
import { checkSocialLink, publicSocialLinks, socialView } from "@/lib/pro/social-links-rules";

// Social links of a Pro shop (src/config/social-links.ts): only a handle is kept, the link is
// rebuilt on the network's own host over https, whatever the shop pasted.

const handle = (network: SocialNetwork, raw: string) => {
  const parsed = parseSocialLink(network, raw);
  return "handle" in parsed ? parsed.handle : parsed.problem;
};

describe("parseSocialLink", () => {
  it("reads a handle, an @handle or the profile address, and rebuilds the https link", () => {
    expect(handle("instagram", "@Dar.Argan")).toBe("dar.argan");
    expect(handle("instagram", "https://www.instagram.com/dar.argan/?hl=fr")).toBe("dar.argan");
    expect(handle("instagram", "instagram.com/dar_argan")).toBe("dar_argan");
    expect(handle("instagram", "http://m.instagram.com/dar.argan")).toBe("dar.argan");
    expect(handle("tiktok", "https://www.tiktok.com/@atlas.velos?lang=fr")).toBe("atlas.velos");
    expect(handle("facebook", "https://web.facebook.com/AtlasVelos.Casa")).toBe("atlasvelos.casa");
    expect(handle("facebook", "https://www.facebook.com/profile.php?id=100089123456789")).toBe("100089123456789");
    expect(handle("facebook", "https://www.facebook.com/people/Atlas-Velos/100089123456789/")).toBe("100089123456789");
    expect(handle("youtube", "https://www.youtube.com/@AtlasVelos/videos")).toBe("atlasvelos");
    expect(handle("x", "https://twitter.com/atlas_velos")).toBe("atlas_velos");
    expect(handle("linkedin", "https://ma.linkedin.com/company/atlas-velos/about/")).toBe("company/atlas-velos");
    expect(handle("linkedin", "atlas-velos")).toBe("company/atlas-velos");
    expect(handle("snapchat", "https://www.snapchat.com/add/atlas.velos")).toBe("atlas.velos");
    expect(handle("whatsapp", "https://wa.me/message/ABCDEFGHIJ2K1")).toBe("ABCDEFGHIJ2K1");

    expect(socialHref("instagram", "dar.argan")).toBe("https://www.instagram.com/dar.argan/");
    expect(socialHref("facebook", "100089123456789")).toBe("https://www.facebook.com/profile.php?id=100089123456789");
    expect(socialHref("linkedin", "company/atlas-velos")).toBe("https://www.linkedin.com/company/atlas-velos/");
    expect(socialHref("whatsapp", "ABCDEFGHIJ2K1")).toBe("https://wa.me/message/ABCDEFGHIJ2K1");
  });

  it("refuses another site, a shortener, a link page or a lookalike host", () => {
    for (const raw of ["https://bit.ly/abc", "https://linktr.ee/atlas", "https://instagram.com.evil.ma/atlas", "https://evil.ma/instagram.com/atlas", "https://instagram.com:8443/atlas", "https://user@instagram.com/atlas"]) {
      expect(handle("instagram", raw)).toBe("host");
    }
    expect(handle("tiktok", "https://vm.tiktok.com/ZMabc/")).toBe("host");
    expect(handle("whatsapp", "https://api.whatsapp.com/send?phone=212612345678")).toBe("host");
  });

  it("refuses pages that are not a profile", () => {
    expect(handle("instagram", "https://www.instagram.com/p/C1abc/")).toBe("profile");
    expect(handle("facebook", "https://www.facebook.com/groups/123456789")).toBe("profile");
    expect(handle("facebook", "https://www.facebook.com/sharer/sharer.php?u=x")).toBe("profile");
    expect(handle("facebook", "https://www.facebook.com/l.php?u=https://evil.ma")).toBe("profile");
    expect(handle("youtube", "https://www.youtube.com/watch?v=abc")).toBe("profile");
    expect(handle("x", "https://x.com/intent/tweet")).toBe("profile");
    expect(handle("tiktok", "https://www.tiktok.com/atlas")).toBe("profile");
    expect(handle("linkedin", "https://www.linkedin.com/feed/")).toBe("profile");
  });

  it("refuses unsafe or malformed input", () => {
    expect(handle("instagram", "javascript://instagram.com/%0aalert(1)")).toBe("invalid");
    expect(handle("instagram", "data:text/html,x")).toBe("invalid");
    expect(handle("instagram", "dar argan")).toBe("invalid");
    expect(handle("instagram", "")).toBe("invalid");
    expect(handle("instagram", "https://www.instagram.com/%E0%A4%A")).toBe("invalid");
    expect(handle("instagram", "dar..argan")).toBe("handle");
    expect(handle("instagram", "<script>")).toBe("handle");
    expect(handle("x", "@a_name_far_too_long_for_x")).toBe("handle");
  });

  it("keeps phone numbers off the page: WhatsApp takes the Business short link only", () => {
    expect(handle("whatsapp", "https://wa.me/212612345678")).toBe("phone");
    expect(handle("whatsapp", "+212612345678")).toBe("phone");
    expect(handle("whatsapp", "0612345678")).toBe("phone");
    expect(handle("whatsapp", "atlasvelos")).toBe("invalid");
    expect(handle("instagram", "@0612345678")).toBe("phone");
    expect(handle("instagram", "@atlas.06.12.34.56.78")).toBe("phone");
    expect(handle("facebook", "https://www.facebook.com/profile.php?id=212612345678")).toBe("handle");
  });
});

describe("social links rules", () => {
  it("refuses a handle carrying a prohibited word", () => {
    expect(checkSocialLink("instagram", "@atlas.velos")).toEqual({ handle: "atlas.velos" });
    expect(checkSocialLink("instagram", "@cannabis.shop")).toEqual({ problem: "prohibited" });
  });

  it("shows nothing while hidden, drops a handle off its grammar, keeps the network order", () => {
    const now = new Date("2026-10-29T12:00:00Z");
    const social = {
      links: [
        { network: "whatsapp" as const, handle: "ABCDEFGHIJ2K1" },
        { network: "x" as const, handle: "bad handle" },
        { network: "instagram" as const, handle: "dar.argan" },
      ],
      updatedAt: now,
    };
    expect(publicSocialLinks(social).map((link) => link.network)).toEqual(["instagram", "whatsapp"]);
    expect(publicSocialLinks({ ...social, hiddenAt: now, hiddenReason: "Compte d'un autre vendeur" })).toEqual([]);
    expect(socialView({ ...social, hiddenAt: now, hiddenReason: "Compte d'un autre vendeur" }).hidden).toEqual({ reason: "Compte d'un autre vendeur", at: now.toISOString() });
    for (const link of publicSocialLinks(social)) expect(link.href.startsWith("https://")).toBe(true);
  });

  it("every network's link is https on one of its own hosts", () => {
    const samples: Record<SocialNetwork, string> = { instagram: "a.b", tiktok: "ab", facebook: "atlasvelos", youtube: "abc", x: "a", linkedin: "in/ab", snapchat: "abc", whatsapp: "ABCDEFGH" };
    for (const network of SOCIAL_NETWORKS) {
      const url = new URL(socialHref(network, samples[network]));
      expect(url.protocol).toBe("https:");
      expect(handle(network, url.toString())).toBe(samples[network]);
    }
  });

  it("the storefront report offers « Lien de réseau social suspect »", () => {
    expect(reasonsFor("user").map((reason) => reason.id)).toContain("social_link");
    expect(reasonsFor("listing").map((reason) => reason.id)).not.toContain("social_link");
  });
});
