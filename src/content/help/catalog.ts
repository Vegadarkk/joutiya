import type { LegalSlug } from "@/config/legal-pages";

// Help centre catalog (design phase-5 D25): the article slugs, their category and their links,
// shared by the three locales. The texts live in fr.ts, ar.ts and rif.ts, one entry per slug (the
// compiler and tests/unit/help-corpus.test.ts check that none is missing). Client-safe.
//
// Article texts may hold placeholders `{name}` resolved by `helpValues` (src/content/help/index.ts)
// from the code's own constants and `config/legal`, so a limit changed in code changes the help
// text with it. Never put a postal address, a company detail or a contact e-mail in an article:
// link to the legal pages instead (they read config/legal).

export const HELP_CATEGORIES = ["compte", "annonces", "recherche", "messagerie", "securite", "moderation", "donnees"] as const;
export type HelpCategory = (typeof HELP_CATEGORIES)[number];

/** App pages an article may link to (labels: messages `Help.pages`). */
export const HELP_PAGES = {
  inscription: "/inscription",
  connexion: "/connexion",
  motDePasse: "/mot-de-passe-oublie",
  parametres: "/parametres",
  deposer: "/deposer",
  mesAnnonces: "/mes-annonces",
  recherche: "/recherche",
  favoris: "/favoris",
  recherches: "/recherches",
  messages: "/messages",
  recours: "/recours",
} as const;
export type HelpPage = keyof typeof HELP_PAGES;

export type HelpLink = { kind: "help"; slug: HelpSlug } | { kind: "legal"; slug: LegalSlug } | { kind: "page"; page: HelpPage };

export const HELP_SLUGS = [
  "creer-un-compte",
  "connexion-et-mot-de-passe",
  "deposer-une-annonce",
  "photos-d-une-annonce",
  "gerer-mes-annonces",
  "rechercher-une-annonce",
  "recherches-et-alertes",
  "contacter-un-vendeur",
  "bloquer-un-utilisateur",
  "eviter-les-arnaques",
  "signaler-un-contenu",
  "decisions-et-recours",
  "suspension-de-compte",
  "donnees-personnelles",
  "role-de-joutiya",
  "assistant-joutiya",
] as const;
export type HelpSlug = (typeof HELP_SLUGS)[number];

export interface HelpArticleMeta {
  category: HelpCategory;
  links: readonly HelpLink[];
}

const help = (slug: HelpSlug): HelpLink => ({ kind: "help", slug });
const legal = (slug: LegalSlug): HelpLink => ({ kind: "legal", slug });
const page = (id: HelpPage): HelpLink => ({ kind: "page", page: id });

export const HELP_META: Readonly<Record<HelpSlug, HelpArticleMeta>> = {
  "creer-un-compte": { category: "compte", links: [page("inscription"), help("connexion-et-mot-de-passe"), legal("cgu")] },
  "connexion-et-mot-de-passe": { category: "compte", links: [page("connexion"), page("motDePasse"), page("parametres")] },
  "deposer-une-annonce": { category: "annonces", links: [page("deposer"), help("photos-d-une-annonce"), legal("objets-interdits")] },
  "photos-d-une-annonce": { category: "annonces", links: [help("deposer-une-annonce"), legal("objets-interdits")] },
  "gerer-mes-annonces": { category: "annonces", links: [page("mesAnnonces"), help("deposer-une-annonce")] },
  "rechercher-une-annonce": { category: "recherche", links: [page("recherche"), page("favoris"), help("recherches-et-alertes"), legal("referencement-et-classement")] },
  "recherches-et-alertes": { category: "recherche", links: [page("recherches"), help("rechercher-une-annonce")] },
  "contacter-un-vendeur": { category: "messagerie", links: [page("messages"), help("eviter-les-arnaques"), help("bloquer-un-utilisateur")] },
  "bloquer-un-utilisateur": { category: "messagerie", links: [page("messages"), help("signaler-un-contenu")] },
  "eviter-les-arnaques": { category: "securite", links: [help("signaler-un-contenu"), legal("confiance-et-securite")] },
  "signaler-un-contenu": { category: "moderation", links: [help("decisions-et-recours"), legal("contact-autorites"), legal("objets-interdits")] },
  "decisions-et-recours": { category: "moderation", links: [page("recours"), help("suspension-de-compte"), legal("cgu")] },
  "suspension-de-compte": { category: "moderation", links: [page("recours"), help("decisions-et-recours"), legal("cgu")] },
  "donnees-personnelles": { category: "donnees", links: [legal("confidentialite"), legal("cookies"), legal("mentions-legales")] },
  "role-de-joutiya": { category: "donnees", links: [legal("cgu"), legal("droits-et-obligations"), help("eviter-les-arnaques")] },
  "assistant-joutiya": { category: "donnees", links: [help("donnees-personnelles"), legal("confidentialite")] },
};

/** A paragraph, a bullet list, numbered steps (a real sequence) or a caution note. */
export type HelpBlock = string | { list: readonly string[] } | { steps: readonly string[] } | { note: string };

export interface HelpText {
  title: string;
  /** One sentence: cards, search results, the assistant's links. */
  summary: string;
  blocks: readonly HelpBlock[];
  /** Extra search terms (synonyms, Darija, arabizi); never shown. */
  keywords?: readonly string[];
}

export interface HelpLocaleContent {
  categories: Readonly<Record<HelpCategory, { title: string; description: string }>>;
  articles: Readonly<Record<HelpSlug, HelpText>>;
}
