import { describe, expect, it } from "vitest";
import { findContacts } from "@/lib/moderation/contacts";

describe("findContacts", () => {
  it("finds e-mail addresses, plain and lightly obfuscated", () => {
    expect(findContacts("mail: test.user@gmail.com")).toEqual([{ kind: "email", raw: "test.user@gmail.com" }]);
    expect(findContacts("contact test (at) gmail.com svp")).toEqual([{ kind: "email", raw: "test (at) gmail.com" }]);
    expect(findContacts("écrire à vendeur[at]yahoo.fr.")).toEqual([{ kind: "email", raw: "vendeur[at]yahoo.fr" }]);
    expect(findContacts("ahmed arobase hotmail.com")).toEqual([{ kind: "email", raw: "ahmed arobase hotmail.com" }]);
  });

  it("finds links: scheme, www, messaging hosts, bare domains", () => {
    expect(findContacts("https://wa.me/212612345678")).toEqual([{ kind: "url", raw: "https://wa.me/212612345678" }]);
    expect(findContacts("wa.me/212612345678")).toEqual([{ kind: "url", raw: "wa.me/212612345678" }]);
    expect(findContacts("Site: www.monsite.ma, promo")).toEqual([{ kind: "url", raw: "www.monsite.ma" }]);
    expect(findContacts("visitez monsite.com/offre")).toEqual([{ kind: "url", raw: "monsite.com/offre" }]);
    expect(findContacts("insta: instagram.com/foo")).toEqual([{ kind: "url", raw: "instagram.com/foo" }]);
    expect(findContacts("contactez-moi sur t.me/foo")).toEqual([{ kind: "url", raw: "t.me/foo" }]);
    expect(findContacts("voir aussi sur avito.ma")).toEqual([{ kind: "url", raw: "avito.ma" }]);
    expect(findContacts("Acheté sur Jumia.ma hier")).toEqual([{ kind: "url", raw: "Jumia.ma" }]);
    expect(findContacts("groupe chat.whatsapp.com/ABC123")).toEqual([{ kind: "url", raw: "chat.whatsapp.com/ABC123" }]);
  });

  it("does not double count the domain of an e-mail and keeps text order", () => {
    expect(findContacts("web www.foo.ma mail a@foo.ma")).toEqual([
      { kind: "url", raw: "www.foo.ma" },
      { kind: "email", raw: "a@foo.ma" },
    ]);
  });

  it.each([
    "chaussures taille 38.5 com neuf",
    "Peugeot 206. Ma voiture est propre",
    "prix 1.5 ma",
    "etc. com",
    "fichier photo.jpg",
    "serie.tv",
    "appelez.me",
    "note 4.5 info",
    "Lave-linge 7 kg classe A++",
    "contact par messagerie uniquement",
    "",
  ])("stays silent on %j", (text) => {
    expect(findContacts(text)).toEqual([]);
  });
});
