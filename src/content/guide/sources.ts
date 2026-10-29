// Admin procedures guide (design guide-demarches G2): the only links the guide may show. Every URL is
// an official page of a Moroccan administration, on a host of OFFICIAL_HOSTS; the guide never hosts a
// copy of a form or a document, and its texts never hold a URL (tests/unit/guide-corpus.test.ts).
// The worker checks every link weekly (src/worker/jobs/guide-links.ts) and the back office shows the
// result (/guide). Client-safe.
//
// Adding a link: open the page by hand, read it, set `reviewedAt` to that day. `confirmed: false`
// marks a page we could not open from the development machines (geo or anti-bot block): the site
// hides it until the checker has seen it answer once.

/** Hosts the guide may link to, with the authority that runs them (shown next to each link). */
export const OFFICIAL_HOSTS = {
  "idarati.ma": "Idarati",
  "maroc.ma": "Portail national",
  "www.chikaya.ma": "Chikaya",
  "www.tax.gov.ma": "DGI",
  "www.tgr.gov.ma": "TGR",
  "www.cnss.ma": "CNSS",
  "ae.gov.ma": "Auto-entrepreneur",
  "www.onousc.ma": "ONOUSC",
  "mabourse.enssup.gov.ma": "Enseignement supérieur",
  "massar.men.gov.ma": "Massar",
  "www.narsa-securiteroutiere.ma": "NARSA",
  "www.ancfcc.gov.ma": "ANCFCC",
  "www.mre.gov.ma": "Ministère des MRE",
  "www.consulat.ma": "Affaires étrangères",
  "casierjudiciaire.justice.gov.ma": "Ministère de la Justice",
  "nationalitemarocaine.justice.gov.ma": "Ministère de la Justice",
  "www.odco.gov.ma": "ODCO",
  "www.ompic.ma": "OMPIC",
  "www.cnie.ma": "DGSN",
  "www.passeport.ma": "DGSN",
  "mtaess.gov.ma": "Ministère du Tourisme",
} as const;
export type OfficialHost = keyof typeof OFFICIAL_HOSTS;

/** Languages a page is offered in (badges next to the link). */
export const PAGE_LANGS = ["fr", "ar", "en", "es"] as const;
export type PageLang = (typeof PAGE_LANGS)[number];

export interface GuideSource {
  url: string;
  langs: readonly PageLang[];
  /** Day a person last read the page (YYYY-MM-DD); the back office flags it after 180 days. */
  reviewedAt: string;
  /** False: never opened from our machines; hidden until the checker sees it answer. */
  confirmed: boolean;
}

const source = (url: string, langs: readonly PageLang[], confirmed = true, reviewedAt = "2026-10-28"): GuideSource => ({ url, langs, reviewedAt, confirmed });

export const GUIDE_SOURCES = {
  // Portals
  "idarati-entreprises": source("https://idarati.ma/e-service/services-en-ligne/?thematic=entreprises-emploi-et-affaires", ["fr"]),
  "idarati-logement": source("https://idarati.ma/e-service/services-en-ligne/?thematic=construction-logement-et-immobilier", ["fr"]),
  // Tourist accommodation: law 80-14 and its texts (no step-by-step procedure on the page).
  "tourisme-hebergement": source("https://mtaess.gov.ma/fr/tourisme/metiers-tourisme/hebergement-touristique/", ["fr", "ar"], true, "2026-10-29"),
  "idarati-papiers": source("https://idarati.ma/e-service/services-en-ligne/?thematic=papiers-famille-et-citoyennete", ["fr"]),
  "maroc-grand-public": source("https://maroc.ma/fr/services-numeriques/grand-public", ["fr", "ar"]),
  "maroc-entreprises": source("https://maroc.ma/fr/services-numeriques/entreprises-professionnels", ["fr", "ar"]),
  chikaya: source("https://www.chikaya.ma/", ["fr", "ar"]),
  // Tax and social security
  "dgi-teleservices": source("https://www.tax.gov.ma/wps/portal/DGI/Teleservices", ["fr", "ar", "en", "es"]),
  "tgr-taxes-locales": source("https://www.tgr.gov.ma/wps/portal/EmissionTHTSC", ["fr"]),
  cnss: source("https://www.cnss.ma/", ["fr", "ar"], false),
  "ae-portail": source("https://ae.gov.ma/", ["fr", "ar"], false),
  // Students
  "onousc-bourses": source("https://www.onousc.ma/Bourses", ["fr"]),
  "onousc-bourses-maroc": source("https://www.onousc.ma/Bourses-de-premier-cycle-au-Maroc", ["fr"]),
  "onousc-bourses-etranger": source("https://www.onousc.ma/Bourses-des-etudes-a-l-etranger", ["fr"]),
  "onousc-logement": source("https://www.onousc.ma/se-loger-dans-une-cite-universitaire", ["fr"]),
  "onousc-amo": source("https://www.onousc.ma/Couverture-medicale", ["fr"]),
  mabourse: source("https://mabourse.enssup.gov.ma/", ["fr"]),
  massar: source("https://massar.men.gov.ma/", ["fr", "ar"], false),
  // Vehicles
  "narsa-mutation": source("https://www.narsa-securiteroutiere.ma/fr/mutation-de-vehicules/", ["fr", "ar"]),
  "narsa-permis": source("https://www.narsa-securiteroutiere.ma/fr/echange-du-permis-de-conduire/", ["fr"]),
  // Property
  ancfcc: source("https://www.ancfcc.gov.ma/", ["fr", "ar"]),
  "ancfcc-tarifs": source("https://www.ancfcc.gov.ma/TarifsFr/", ["fr"]),
  // Diaspora (MRE)
  "mre-accueil": source("https://www.mre.gov.ma/fr", ["fr", "ar", "en"]),
  "mre-consulaire": source("https://www.mre.gov.ma/fr/e-services/guide-des-prestations-consulaires-en-ligne", ["fr"]),
  "mre-justice": source("https://www.mre.gov.ma/fr/e-services/services-administratifs-et-judiciaires-en-ligne", ["fr"]),
  "consulat-trouver": source("https://www.consulat.ma/fr/trouver-un-consulat", ["fr", "ar"]),
  "consulat-immatriculation": source("https://www.consulat.ma/fr/attestation-dimmatriculation-consulaire", ["fr", "ar"]),
  "consulat-retour": source("https://www.consulat.ma/fr/le-retour-definitif-au-maroc", ["fr", "ar"]),
  "consulat-voiture": source("https://www.consulat.ma/fr/admission-temporaire-des-voitures-au-maroc", ["fr", "ar"]),
  "consulat-procuration": source("https://www.consulat.ma/fr/procuration-pour-transactions-immobilieres", ["fr", "ar"]),
  // Identity and civil status
  "consulat-naissance": source("https://www.consulat.ma/fr/extrait-dacte-de-naissance", ["fr", "ar"]),
  "consulat-copie-integrale": source("https://www.consulat.ma/fr/copie-integrale-de-lacte-de-naissance", ["fr", "ar"]),
  "consulat-cnie": source("https://www.consulat.ma/fr/delivrance-de-la-cnie-pour-la-premiere-fois", ["fr", "ar"]),
  "consulat-livret": source("https://www.consulat.ma/fr/delivrance-du-livret-de-famille", ["fr", "ar"]),
  "consulat-casier": source("https://www.consulat.ma/fr/casier-judiciare-pour-les-marocains", ["fr", "ar"]),
  casier: source("https://casierjudiciaire.justice.gov.ma/Accueil.aspx", ["fr", "ar", "en", "es"]),
  nationalite: source("https://nationalitemarocaine.justice.gov.ma/Pages/NouvelleDemande", ["ar"]),
  cnie: source("https://www.cnie.ma/", ["fr", "ar"], false),
  passeport: source("https://www.passeport.ma/", ["fr", "ar"], false),
  // Companies and cooperatives
  "odco-creer": source("https://www.odco.gov.ma/service/creer-votre-cooperative/", ["fr", "ar"]),
  "odco-cadre": source("https://www.odco.gov.ma/service/cadre-juridique/", ["fr", "ar"]),
  "odco-delegations": source("https://www.odco.gov.ma/nos-delegations-regionales/", ["fr", "ar"]),
  "ompic-creation": source("https://www.ompic.ma/fr/creation-et-vie-de-lentreprise", ["fr", "ar"]),
  "ompic-rcc": source("https://www.ompic.ma/fr/services-rcc", ["fr", "ar"]),
  "ompic-ice": source("https://www.ompic.ma/fr/identifiant-commun-de-lentreprise", ["fr", "ar"]),
} as const satisfies Record<string, GuideSource>;
export type GuideSourceId = keyof typeof GUIDE_SOURCES;
export const GUIDE_SOURCE_IDS = Object.keys(GUIDE_SOURCES) as GuideSourceId[];

export function isGuideSourceId(value: string): value is GuideSourceId {
  return Object.hasOwn(GUIDE_SOURCES, value);
}

export function isOfficialHost(host: string): host is OfficialHost {
  return Object.hasOwn(OFFICIAL_HOSTS, host);
}

/** The authority running a source's host. */
export function sourceAuthority(id: GuideSourceId): string {
  return OFFICIAL_HOSTS[new URL(GUIDE_SOURCES[id].url).hostname as OfficialHost];
}

/** The host as shown to visitors (without "www."). */
export function sourceDomain(id: GuideSourceId): string {
  return new URL(GUIDE_SOURCES[id].url).hostname.replace(/^www\./, "");
}
