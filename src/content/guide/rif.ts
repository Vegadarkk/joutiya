import type { GuideLocaleContent } from "./catalog";

// Admin procedures guide, Tarifit in Latin script (design guide-demarches G1, Z9): same procedures
// and facts as fr.ts, shorter. Draft wording: a native speaker reviews it with the help centre
// before launch. Link labels keep the administrations' own names.

export const GUIDE_RIF: GuideLocaleContent = {
  rubrics: {
    etudiant: {
      title: "Inelmaden",
      summary: "Tiwsa n leqraya, axxam n tesdawit, asurif n tdawit, Massar.",
      intro: "ONOUSC d lwizara n uselmed unnig i yessegden tiwsa n inelmaden. Isutar ttwagen-d deg internet, deg wakud i yettwarzmen kul aseggwas: ḍfer imezgura i d-ttffɣen.",
    },
    "auto-entrepreneur": {
      title: "Auto-entrepreneur",
      summary: "Ad tejjleḍ deg ustatu, ad tesmektiḍ lexdmet nnec, asurif n tdawit.",
      intro: "Astatu n auto-entrepreneur yejja-c ad texdmeḍ s yisem nnec s tiwriwin fessusnin: ajjel deg uɣmis aɣelnaw, asmekti n lexdmet d axelleṣ n tbazert, asurif n tdawit. Ma tzenzaḍ deg {brand} deg lxedmet nnec, ldi amiḍan Pro.",
    },
    vehicule: {
      title: "Ad tzenzeḍ niɣ ad taɣeḍ tamubilt",
      summary: "Mutation n tkarḍa tazegzawt, vignette, permis, tamubilt n MRE.",
      intro: "Tazenzit n tmubilt war tekmil s tsura: abeddel n bab nnes (mutation) yettwag deg NARSA, d timbre yettwaxelleṣ deg DGI. Alami tettwag mutation, amzenzu yeqqim d bab n tmubilt deg idlisen.",
    },
    immobilier: {
      title: "Ad taɣeḍ, ad tzenzeḍ niɣ ad tekriḍ axxam",
      summary: "Ad tesneqdeḍ axxam, ad tezmeḍ tazenzit, tibazar n temnaḍt, lekra.",
      intro: "Uqbel ad taɣeḍ, senqed axxam deg conservation foncière (ANCFCC). Tazenzit tettwazmem ɣer notaire, ɣer adul niɣ ɣer avocat, umbeɛd ttwaxelleṣen ihqqen deg DGI.",
    },
    mre: {
      title: "Imeɣriben n umaḍal (MRE)",
      summary: "Consulat, ajjel, tuɣalin, procuration.",
      intro: "Zeg berra, aṭas n tiwriwin ttɛeddayen x consulat n tmurt nnec d isenfaren n lwizara n MRE deg internet.",
    },
    "pro-cooperative": {
      title: "Tisharikin d tcoopératives",
      summary: "Ad tesnulfuḍ tasharikt niɣ tacoopérative, ICE, tibazar d CNSS.",
      intro: "Tasharikt tettwajjel deg registre du commerce (OMPIC) d ad tawi ICE; tacoopérative tettwag x ODCO. Ad ak-ttwasutren wid uṭṭunen ḥima amiḍan Pro.",
    },
    identite: {
      title: "Tamagit d leḥala madaniya",
      summary: "CNIE, passeport, rasm n tlalit, casier judiciaire, tamurt (nationalité).",
      intro: "Deg Lmeɣrib, CNIE d passeport ttwagen ɣer DGSN, d rasm n tlalit ɣer leḥala madaniya n tjmaɛt. Zeg berra, consulat ad yegg aya.",
    },
  },
  procedures: {
    "bourse-etudes": {
      title: "Ad tesutreḍ tawsa n leqraya",
      body: ["Asuter yettwag deg internet, s lɛada mbeɛd bac. Tiwtilin, imezgura d ikaɣeḍen ttwaffɣen kul aseggwas."],
    },
    "bourse-etranger": {
      title: "Tawsa ḥima ad teqqareḍ berra",
      body: ["Kra n tiwsa ttxellaṣen leqraya berra n Lmeɣrib. Tamurt, tiwriwin d imezgura ttbeddalen kul aseggwas."],
    },
    "logement-universitaire": {
      title: "Axxam deg cité universitaire",
      body: ["Imukan deg cité universitaire ttwakfen s usuter, s tiwtilin n ONOUSC."],
    },
    "amo-etudiant": {
      title: "Asurif n tdawit i inelmaden",
      body: ["Inelmaden zemmren ad awin AMO n inelmaden. Tasna tunṣibt tessfehm ajjel d tiwtilin."],
    },
    massar: {
      title: "Massar",
      body: ["Massar d tasna n lwizara n uselmed: tinqiḍin, igmad, d code Massar i ttsutren aṭas n tiwriwin."],
    },
    "ae-inscription": {
      title: "Ajjel deg ustatu n auto-entrepreneur",
      body: ["Ajjel deg uɣmis aɣelnaw yettwag deg tasna tunṣibt n ustatu. Din ad tafeḍ lexdayem i yettwaqbalen d tilisa n lexdmet."],
      prepare: ["Takarḍa nnec (CNIE)", "Aglam n lxedmet nnec"],
    },
    "ae-impots": {
      title: "Ad tesmektiḍ d ad txelleṣeḍ tibazar",
      body: ["DGI tesmun isenfaren nnes deg yiwet n tasna: asmekti, axelleṣ, tiwraqin."],
    },
    "ae-protection-sociale": {
      title: "Asurif n tdawit",
      body: ["CNSS i yessegden AMO n wid war nexdim ɣer yiwen, d auto-entrepreneurs."],
    },
    "ae-services": {
      title: "Akk tiwriwin n tisharikin",
      body: ["Tisniwin tiɣelnawin ssmunent isenfaren n internet i tisharikin d imsuqen."],
    },
    "vehicule-mutation": {
      title: "Abeddel n bab n tmubilt (mutation)",
      body: [
        "Mbeɛd tazenzit, mutation tettarra amsaɣ d bab amaynu n tmubilt. NARSA tessfehm tiwriwin d ikaɣeḍen; timbre n mutation yettwaxelleṣ deg tasna n DGI.",
        "Ssleggem tirra x lɛaqd n tzenzit d ḥrez yiwet n nnusxa: nettat ad tesbeyyen mlmi tbeddel tmubilt afus.",
      ],
      prepare: ["Lɛaqd n tzenzit s tirra n sin", "Takarḍa tazegzawt n tmubilt", "Tikarḍiwin n umzenzu d umsaɣ"],
    },
    "vehicule-vignette": {
      title: "Axelleṣ n vignette",
      body: ["Vignette txelleṣ deg tasna n DGI. Amsaɣ yzemmer ad isuter ayen yesbeyyanen axelleṣ n useggwas-a."],
    },
    "vehicule-permis": {
      title: "Abeddel n permis n berra",
      body: ["Permis n berra yzemmer ad yettwabeddel s permis amerruki, s tiwtilin n NARSA."],
    },
    "vehicule-mre": {
      title: "Ad d-tasaḍ ɣer Lmeɣrib s tmubilt nnec (MRE)",
      body: ["MRE yzemmer ad d-yas s tmubilt nnes s admission temporaire. Tamubilt-a war tettwazenz deg Lmeɣrib bla dédouanement."],
    },
    "immo-verifier": {
      title: "Senqed axxam uqbel ad t-taɣeḍ",
      body: ["I wexxam s titre, certificat de propriété n conservation foncière yesbeyyen bab nnes d ayen yellan fellas (hypothèque, saisie). Suter-it uqbel ad txelleṣeḍ ca."],
    },
    "immo-vente": {
      title: "Azmam n tzenzit d ihqqen",
      body: [
        "Tazenzit n wexxam tettwaru ɣer notaire, ɣer sin adul niɣ ɣer avocat. Ihqqen n tira d tbazert x rribḥ ttwaxelleṣen deg DGI.",
        "Umbeɛd tazenzit tettwaru deg titre foncier: d aya i yettarran amsaɣ d bab n wexxam.",
      ],
    },
    "immo-taxes-locales": {
      title: "Taxe d'habitation d taxe de services communaux",
      body: ["Tibazar-a n temnaḍt ttffɣent-d zeg TGR, d tzemmreḍ ad tent-teẓreḍ d ad tent-txelleṣeḍ deg internet."],
    },
    "immo-location-touristique": {
      title: "Lekra n wexxam i turist",
      body: [
        "Lekra n wexxam s lmefrucat i turist, ula i kra n yiḍan, ttwaḥkem s lqanun 80-14 n usensi aturisti: ɣer wanaw n usensi, ixs turagt zzat lexdma d ttamin. Lwizara n Turizm tssufeɣ lqanun d yiḍrisen-nnes.",
        "Win yesseqdacen axxam ad yessenqed tamagit n kul amsaɣ, ad t-ixebber kul ass i tmeqranin. Ad yejmeɛ daɣ tabzert n wqqim, ad tt-yerr i tɣiwant. Steqsa tiɣiwant-nnek uqbel lekra amezwaru.",
      ],
    },
    "immo-location": {
      title: "Lekra n wexxam",
      body: [
        "Lekra n wexxam ttwaḥkem s lqanun 67-12: lɛaqd s tira, aglam n wexxam, d adrim n ḍḍmana s tilisa. Ssleggem tirra x lɛaqd d ḥrez ireṣyuyen n lekra.",
        "Ur txelleṣ ca ḥima ad teḥjzeḍ axxam war teẓriḍ: d nettat i d taxriqt tamezwarut deg lekra.",
      ],
    },
    "mre-services": {
      title: "Isenfaren n internet i MRE",
      body: ["Lwizara n MRE tesmun isenfaren n consulat, n tedbelt d n lɛadala i yellan zeg twriqt."],
    },
    "mre-immatriculation": {
      title: "Ajjel deg consulat",
      body: ["Ajjel deg consulat d amezwaru n aṭas n tiwriwin berra. Asmawen unṣib yesbeyyen consulat nnec."],
    },
    "mre-retour": {
      title: "Tuɣalin ɣer Lmeɣrib i lebda",
      body: ["Tuɣalin i lebda tettak kra n tsehlin, i tɣawsiwin nnec d tmubilt, s tiwtilin n consulat."],
    },
    "mre-procuration": {
      title: "Procuration ḥima ad tzenzeḍ niɣ ad taɣeḍ axxam",
      body: ["Zeg berra, tzemmreḍ ad tekfeḍ procuration i yiwen tamneḍ ḥima ad yegg tazenzit deg Lmeɣrib. Ɣer-tt uqbel ad tezmemeḍ: tzemmer ad tezzenz s yisem nnec."],
    },
    "pro-societe": {
      title: "Ad tesnulfuḍ tasharikt",
      body: ["Registre du commerce n OMPIC i yettarun tisharikin d imsuqen. OMPIC tessfehm tiwriwin, zeg yisem alami d ajjel."],
    },
    "pro-ice": {
      title: "ICE",
      body: ["ICE yessinn tasharikt ɣer akk tidbelin. Yettwaru x tfaturin nnes d ad ak-yettwasuter ḥima amiḍan Pro."],
    },
    "pro-cooperative": {
      title: "Ad tesnulfuḍ tacoopérative",
      body: ["ODCO tettɛawan ad ttwasnulfunt tcoopératives, ladɣa n tfellaḥt d n tḥanut: iqanunen, delegations n temnaḍin."],
    },
    "pro-obligations": {
      title: "Tibazar d CNSS",
      body: ["Tasharikt tesmekti tibazar nnes deg DGI d ixeddamen nnes deg CNSS, deg internet."],
    },
    "id-cnie": {
      title: "Takarḍa n tmagit (CNIE)",
      body: ["Deg Lmeɣrib, CNIE tettwasuter ɣer DGSN s lmuɛid deg internet. Zeg berra, asuter yettɛedda x consulat."],
    },
    "id-passeport": {
      title: "Passeport",
      body: ["Passeport yettwasuter deg internet ɣer DGSN deg Lmeɣrib, niɣ ɣer consulat zeg berra."],
    },
    "id-naissance": {
      title: "Rasm n tlalit",
      body: ["Rasm n tlalit yettwasuter ɣer leḥala madaniya n tjmaɛt i deg tettwaru tlalit, d berra ɣer consulat."],
    },
    "id-livret": {
      title: "Livret de famille",
      body: ["Livret de famille yettwak-d zeg leḥala madaniya mbeɛd tameɣra; berra, zeg consulat."],
    },
    "id-casier": {
      title: "Casier judiciaire",
      body: ["Casier judiciaire yettwasuter deg internet ɣer lwizara n lɛadala. Tawriqt tettwaru s taɛrabt."],
    },
    "id-nationalite": {
      title: "Certificat de nationalité",
      body: ["Certificat de nationalité yettwasuter deg internet deg tasna n lwizara n lɛadala (s taɛrabt)."],
    },
  },
  sources: {
    "idarati-entreprises": "Isenfaren i tisharikin (Idarati)",
    "idarati-logement": "Isenfaren n wexxam (Idarati)",
    "tourisme-hebergement": "Asensi aturisti: lqanun 80-14 (Lwizara n Turizm)",
    "idarati-papiers": "Isenfaren n ikaɣeḍen d twacult (Idarati)",
    "maroc-grand-public": "Isenfaren n internet i imezdaɣ d MRE",
    "maroc-entreprises": "Isenfaren n internet i tisharikin",
    chikaya: "Chikaya: ad tesmektiḍ x tedbelt",
    "dgi-teleservices": "Isenfaren n DGI",
    "tgr-taxes-locales": "Taxe d'habitation (TGR)",
    cnss: "Tasna n CNSS",
    "ae-portail": "Tasna tunṣibt n auto-entrepreneur",
    "onousc-bourses": "Tiwsa n ONOUSC",
    "onousc-bourses-maroc": "Tiwsa deg Lmeɣrib",
    "onousc-bourses-etranger": "Tiwsa i leqraya berra",
    "onousc-logement": "Cité universitaire",
    "onousc-amo": "Asurif n tdawit i inelmaden",
    mabourse: "Asuter n tawsa deg internet",
    massar: "Massar",
    "narsa-mutation": "Mutation n tmubilin (NARSA)",
    "narsa-permis": "Abeddel n permis",
    ancfcc: "Conservation foncière (ANCFCC)",
    "ancfcc-tarifs": "Ixxuṣen n conservation foncière",
    "mre-accueil": "Lwizara n MRE",
    "mre-consulaire": "Isenfaren n consulat deg internet",
    "mre-justice": "Isenfaren n tedbelt d lɛadala",
    "consulat-trouver": "Af-d consulat nnec",
    "consulat-immatriculation": "Ajjel deg consulat",
    "consulat-retour": "Tuɣalin i lebda",
    "consulat-voiture": "Admission temporaire n tmubilin",
    "consulat-procuration": "Procuration i wexxam",
    "consulat-naissance": "Rasm n tlalit (consulat)",
    "consulat-copie-integrale": "Copie intégrale n rasm n tlalit (consulat)",
    "consulat-cnie": "CNIE tamezwarut (consulat)",
    "consulat-livret": "Livret de famille (consulat)",
    "consulat-casier": "Casier judiciaire (consulat)",
    casier: "Asuter n casier judiciaire",
    nationalite: "Asuter n certificat de nationalité",
    cnie: "CNIE (DGSN)",
    passeport: "Passeport (DGSN)",
    "odco-creer": "Snulfu-d tacoopérative nnec",
    "odco-cadre": "Lqanun n tcoopératives",
    "odco-delegations": "Delegations n ODCO",
    "ompic-creation": "Asnulfu d tudert n tsharikt",
    "ompic-rcc": "Registre du commerce",
    "ompic-ice": "ICE",
  },
};
