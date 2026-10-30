import { describe, expect, it } from "vitest";
import { PROHIBITED_GROUPS, PROHIBITED_GROUP_IDS, prohibitedGroupById } from "@/config/prohibited";
import { compileKeywords, normalizeTerm, tokenVariants } from "@/lib/moderation/keywords";
import { containsProhibited } from "@/lib/moderation/prohibited";

const hard = (text: string) => containsProhibited(text).hard;
const soft = (text: string) => containsProhibited(text).soft;

describe("prohibited lists (config integrity)", () => {
  it("has every group once, with disjoint hard and soft lists and non-empty normalised terms", () => {
    expect(PROHIBITED_GROUPS.map((group) => group.id)).toEqual([...PROHIBITED_GROUP_IDS]);
    for (const group of PROHIBITED_GROUPS) {
      const hardTerms = group.hard.map(normalizeTerm);
      const softTerms = group.soft.map(normalizeTerm);
      for (const term of [...hardTerms, ...softTerms]) expect(term, group.id).not.toBe("");
      expect(new Set(hardTerms).size, `${group.id} hard duplicates`).toBe(hardTerms.length);
      expect(new Set(softTerms).size, `${group.id} soft duplicates`).toBe(softTerms.length);
      for (const term of softTerms) expect(hardTerms, `${group.id}: ${term} both hard and soft`).not.toContain(term);
      expect(compileKeywords(group.hard).length).toBeGreaterThanOrEqual(group.hard.length);
    }
    expect(prohibitedGroupById("weapons")?.hard).toContain("kalachnikov");
    expect(prohibitedGroupById("nope")).toBeUndefined();
  });
});

describe("containsProhibited: hard hits (422)", () => {
  it.each([
    ["Vends kalachnikov neuve", "weapons"],
    ["Vends AK-47", "weapons"],
    ["fusil de chasse calibre 12", "weapons"],
    ["Fusils de chasse à vendre", "weapons"],
    ["بندقية صيد للبيع", "weapons"],
    ["Cocaïne pure", "drugs"],
    ["zetla dyal lkhir", "drugs"],
    ["karkoubi 9ar9oubi", "drugs"],
    ["السلاح والمخدرات للبيع", "drugs"],
    ["montre first copy", "counterfeit"],
    ["sac qualité AAA+ neuf", "counterfeit"],
    ["iphone icloud bloqué", "stolen"],
    ["هاتف مسروق", "stolen"],
    ["faux passeport rapide", "identity_documents"],
    ["permis bla examen", "identity_documents"],
    ["جواز سفر للبيع", "identity_documents"],
    ["massage érotique casa", "human"],
    ["escort casablanca", "human"],
    ["vente d'organe", "human"],
    ["chardonneret ma9nin chanteur", "protected_species"],
    ["عاج الفيل", "protected_species"],
    ["gazelle vivante", "protected_species"],
    ["tramadol 100mg", "medicines"],
    ["حبوب الإجهاض", "medicines"],
    ["abonnement IPTV 12 mois", "hacking_piracy"],
    ["compte Netflix pas cher", "hacking_piracy"],
    ["اختراق واتساب", "hacking_piracy"],
    ["1xbet code promo", "gambling"],
    ["jeux d'argent en ligne", "gambling"],
    ["القمار", "gambling"],
  ])("%j -> hard %s", (text, group) => {
    expect(hard(text)).toEqual([group]);
  });

  it("reports the matched terms and prefers hard over soft for a group", () => {
    const result = containsProhibited("عاج الفيل");
    expect(result.hard).toEqual(["protected_species"]);
    expect(result.soft).toEqual([]);
    expect(result.matches).toEqual([
      { group: "protected_species", level: "hard", term: "عاج الفيل" },
      { group: "protected_species", level: "soft", term: "عاج" },
    ]);
  });
});

describe("containsProhibited: soft hits (needs_review)", () => {
  it.each([
    ["pistolet à colle", "weapons"],
    ["armes de collection", "weapons"],
    ["مسدس ماء للأطفال", "weapons"],
    ["mkohla", "weapons"],
    ["l'héroïne du roman", "drugs"],
    ["حشيش اصطناعي للحدائق", "drugs"],
    ["l7chich", "drugs"],
    ["Black Opium parfum", "drugs"],
    ["réplique montre", "counterfeit"],
    ["ta9lid", "counterfeit"],
    ["ساحل العاج", "protected_species"],
    ["pompe à insuline", "medicines"],
    ["boîtier IPTV", "hacking_piracy"],
    ["casino", "gambling"],
    ["paris sportifs", "gambling"],
    ["visa", "identity_documents"],
    ["voiture sans carte grise", "stolen"],
    ["rencontre", "human"],
  ])("%j -> soft %s", (text, group) => {
    expect(hard(text)).toEqual([]);
    expect(soft(text)).toEqual([group]);
  });
});

describe("containsProhibited: job ad groups, matched on job ads only (PR 14b)", () => {
  const emploi = { categoryId: "emploi" };
  const jobSoft = (text: string) => containsProhibited(text, undefined, emploi).soft;

  it("keeps the scoped groups soft (review, never a 422) and closed without the category", () => {
    for (const group of PROHIBITED_GROUPS) if (group.scope) expect(group.hard, group.id).toEqual([]);
    expect(soft("Frais de dossier de 500 DH à régler avant l'entretien")).toEqual([]);
    expect(containsProhibited("Caution de 2 000 DH à l'entrée", undefined, { categoryId: "immobilier" }).soft).toEqual([]);
  });

  it.each([
    ["Frais de dossier de 500 DH à régler avant l'entretien", "job_scam"],
    ["Une caution est demandée au candidat", "job_scam"],
    ["Envoyez une recharge de 100 DH pour recevoir le contrat", "job_scam"],
    ["Paiement par Western Union avant l'entretien", "job_scam"],
    ["رسوم الملف 300 درهم قبل المقابلة", "job_scam"],
    ["Cherche jeune fille de bonne présentation, célibataire", "job_discrimination"],
    ["Poste réservé aux hommes de moins de 30 ans", "job_discrimination"],
    ["Sans enfants et non mariée de préférence", "job_discrimination"],
    ["المطلوب نساء فقط، أقل من 30 سنة", "job_discrimination"],
    ["Recrute petite bonne à partir de 14 ans", "job_minors"],
    ["Serveurs mineurs acceptés pour la saison", "job_minors"],
    ["خدامة صغيرة للسكن مع العائلة", "job_minors"],
  ])("%j on a job ad -> soft %s", (text, group) => {
    expect(containsProhibited(text, undefined, emploi).hard).toEqual([]);
    expect(jobSoft(text)).toEqual([group]);
  });

  it("reports every group hit, in config order, with the matched term", () => {
    const result = containsProhibited("Frais de dossier 300 DH, femme uniquement, moins de 25 ans", undefined, emploi);
    expect(result.soft).toEqual(["job_scam", "job_discrimination"]);
    expect(result.matches).toContainEqual({ group: "job_scam", level: "soft", term: "frais de dossier" });
    expect(result.matches.map((match) => match.term)).toContain("femme uniquement");
  });

  it("leaves ordinary job wording alone", () => {
    for (const text of ["Anglais niveau avancé exigé", "15 ans d'expérience en cuisine", "Aucun frais, logement fourni", "Poste ouvert à tous, débutants acceptés"]) {
      expect(jobSoft(text), text).toEqual([]);
    }
  });
});

describe("containsProhibited: traps stay clean", () => {
  it.each([
    "droguerie à vendre",
    "alarme maison connectée",
    "charme fou, maison avec charme",
    "acheté à Paris",
    "piles AAA rechargeables",
    "Adidas Gazelle 42",
    "massage à domicile",
    "faux plafond et faux cils",
    "CIN obligatoire pour la location",
    "professeur diplômé",
    "caméra espion",
    "skimmer piscine",
    "clé USB flash 64 Go",
    "cracked screen",
    "poker set 300 jetons",
    "قلم رصاص",
    "تقليدي",
    "خرطوش طابعة",
    "",
  ])("%j", (text) => {
    expect(hard(text)).toEqual([]);
    const silent = text === "cracked screen" || text === "poker set 300 jetons";
    if (!silent) expect(soft(text)).toEqual([]);
  });

  it("never matches inside a longer word, but follows French elision", () => {
    expect(containsProhibited("droguerie armement charmeur").matches).toEqual([]);
    expect(containsProhibited("kalachnikovs").hard).toEqual(["weapons"]);
    expect(containsProhibited("l'arme d'escort").matches.map((m) => m.term)).toEqual(["arme", "escort"]);
  });
});

describe("tokenVariants", () => {
  it("folds Latin plurals and Arabic prefixes only", () => {
    expect(tokenVariants("armes")).toEqual(["armes", "arme"]);
    expect(tokenVariants("prix")).toEqual(["prix", "pri"]);
    expect(tokenVariants("bus")).toEqual(["bus"]);
    expect(tokenVariants("والمخدرات")).toEqual(["والمخدرات", "المخدرات", "مخدرات"]);
    expect(tokenVariants("السلاح")).toEqual(["السلاح", "سلاح"]);
    expect(tokenVariants("كيف")).toEqual(["كيف"]);
  });
});
