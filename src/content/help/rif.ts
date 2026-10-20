import type { HelpLocaleContent } from "./catalog";

// Help centre, Tarifit in Latin script (design phase-5 D25, Z9): same articles and facts as fr.ts,
// shorter. Draft wording: a native speaker reviews it before launch (owner, log L6-U4). Interface
// labels stay in French, as the rif interface itself falls back to French (messages/rif.json).

export const HELP_RIF: HelpLocaleContent = {
  categories: {
    compte: { title: "Amiḍan d tukcimt", description: "Ad tesnulfuḍ amiḍan, ad tkecmeḍ, ad tbeddleḍ awal n uɛeddi." },
    annonces: { title: "Ad tessufɣeḍ d ad tsegdeḍ annonce", description: "Tasuffeɣt, tiwlafin, abeddel, aḥbas, asnulfu." },
    recherche: { title: "Tarzzut", description: "Ifilṭren, ayen tḥemmleḍ, tarzzut yettwaḥerzen d iselɣa." },
    messagerie: { title: "Tibratin", description: "Ad taruḍ i umzenzu, ad terreḍ, ad tḥebseḍ yiwen." },
    securite: { title: "Taɣellist", description: "Ad tissineḍ tixriqin d mamec ad tḥedreḍ zzaysent." },
    moderation: { title: "Asmekti d tigtinin", description: "Ad tsmektiḍ x yiwet n tɣawsa, ad tfehmeḍ tagtint, ad tagiḍ fellas." },
    donnees: { title: "Isefka d tawuri n Joutiya", description: "Isefka nnec, tawuri nneɣ, Amallal n Joutiya." },
  },
  articles: {
    "creer-un-compte": {
      title: "Ad tesnulfuḍ amiḍan",
      summary: "Amiḍan bla idrimen, s e-mail niɣ s Google, ḥima ad tessufɣeḍ annonces d ad taruḍ i imzenza.",
      blocks: [
        "Ad teẓreḍ annonces war ttexs amiḍan. Amiḍan ixs-it ḥima ad tessufɣeḍ annonce, ad taruḍ i umzenzu, niɣ ad teḥrezeḍ ayen tḥemmleḍ.",
        {
          steps: [
            "Rzem tasna n « Inscription » d xtar: e-mail d awal n uɛeddi, niɣ amiḍan Google.",
            "S e-mail, rzem asaɣ n usentem i dak-d ɣa yawḍen: amiḍan nnec ad yexdem xmi tsentmeḍ e-mail.",
            "Isem nnec ad d-yban deg annonces d tebratin; tzemmreḍ ad t-tbeddleḍ deg « Mes paramètres ».",
          ],
        },
        "Amiḍan bla idrimen. Xtar awal n uɛeddi war tesxedmeḍ deg wadeg nniḍen.",
      ],
      keywords: ["inscription", "amiḍan", "compte", "google", "e-mail"],
    },
    "connexion-et-mot-de-passe": {
      title: "Tukcimt d wawal n uɛeddi",
      summary: "Ad tkecmeḍ, ad d-tafeḍ amiḍan nnec, ad tbeddleḍ awal n uɛeddi.",
      blocks: [
        "Kcem s tarrayt i texṭareḍ: e-mail d awal n uɛeddi, niɣ Google.",
        {
          list: [
            "Tettuḍ awal n uɛeddi: ssuter asaɣ deg tasna « Mot de passe oublié ». Asaɣ ad dak-d yawḍ s e-mail.",
            "Ad tbeddleḍ awal n uɛeddi: « Mes paramètres », « Mot de passe ».",
            "Amiḍan n Google war ɣar-s awal n uɛeddi: ssuter asaɣ n « Mot de passe oublié » ḥima ad tegged yiwen.",
          ],
        },
        "Mala tarid awal n uɛeddi ixeṣṣṛen aṭas n tikkal, tukcimt ad tettwaḥbes kra n tesdidin.",
        { note: "Joutiya werǧin ad dak-d tessuter awal n uɛeddi niɣ code i dak-d yawḍen s SMS niɣ s e-mail." },
      ],
      keywords: ["mot de passe", "awal n uɛeddi", "tukcimt", "connexion", "tettuḍ"],
    },
    "deposer-une-annonce": {
      title: "Ad tessufɣeḍ annonce",
      summary: "Tasuffeɣt bla idrimen; annonce ad teqqim {ttlDays} n wussan.",
      blocks: [
        "Ad tessufɣeḍ annonce bla idrimen. Ixs amiḍan s e-mail yettwasentmen.",
        {
          steps: [
            "Wet x « Déposer une annonce » d xtar taggayt.",
            "Ari x tɣawsa: azwel, aglam, ssuma niɣ tamuḥant.",
            "Rnu tawlaft ɣas d yiwet: tamezwarut d tin n wudem.",
            "Ari tamdint; ḥuma war ttexs adres nnec.",
            "Ɣar tikkelt nniḍen, d ssuffeɣ.",
          ],
        },
        "Brouillon nnec yettwaḥraz mala tettaruḍ. Tzemmreḍ ad teḥrezeḍ ar {maxDrafts} n brouillons; brouillon war yettwabeddel {draftPurgeDays} n wussan ad yettwakkes.",
        "S umata, annonce ad tban nican. Kra n annonces ad tent-iɣar umsefrez zzat n usuffeɣ, s umata deg 24 n tsaɛtin.",
        "Annonce ad teqqim {ttlDays} n wussan. Tiɣawsiwin yettwagedlen deg Lmeɣrib ad tent-tafeḍ deg tasna « Objets interdits ».",
      ],
      keywords: ["annonce", "ssuffeɣ", "zzenz", "brouillon", "publier"],
    },
    "photos-d-une-annonce": {
      title: "Tiwlafin n annonce",
      summary: "Ar {maxPhotos} n twlafin, {photoMb} Mo i yal yiwet, i tuṭṭfeḍ cek s yixef nnec.",
      blocks: [
        {
          list: [
            "Ar {maxPhotos} n twlafin i yal annonce, {photoMb} Mo i yal yiwet.",
            "JPEG, PNG, WebP d HEIC (iPhone).",
            "Ɣas d yiwet n twlaft ḥima ad tessufɣeḍ; tamezwarut d tin n wudem.",
          ],
        },
        "Sken tiɣawsa s tidett, s tafat n wass. Tawlaft n internet niɣ n tɣawsa nniḍen ad tekker x imsaɣen.",
        "Tiwlafin n tɛeryant ttwagedlent. War tsekkan ca udmawen niɣ tiwṛiqin.",
      ],
      keywords: ["tawlaft", "photo", "tiwlafin", "heic", "iphone"],
    },
    "gerer-mes-annonces": {
      title: "Ad tsegdeḍ annonces nnec",
      summary: "Beddel, ḥbes, ger « vendue », snulfu niɣ kkes annonce deg « Mes annonces ».",
      blocks: [
        "Marra annonces nnec ɛlant deg « Mes annonces ».",
        {
          list: [
            "Abeddel: kra n ubeddel ad t-iɣar umsefrez zzat ma ad yban.",
            "Aḥbas: annonce ad teffeɣ zi tarzzut; tzemmreḍ ad tt-terreḍ mala war tekmil.",
            "« Vendue »: annonce ad teffeɣ zi tarzzut.",
            "Asnulfu: deg {renewDays} n wussan ineggura, niɣ deffir n tagra; annonce ad tales {ttlDays} n wussan.",
            "Akkes: annonce ad tekkes i lebda.",
          ],
        },
        "Amḍan n annonces yeddren yettwaḥedded i yal amiḍan.",
      ],
      keywords: ["mes annonces", "beddel", "ḥbes", "vendue", "kkes", "snulfu"],
    },
    "rechercher-une-annonce": {
      title: "Ad tarezzuḍ x annonce",
      summary: "Awalen, taggayt, ssuma, tamdint d asettef ḥima ad tafeḍ annonce.",
      blocks: [
        "Ari kra n wawalen deg tarzzut, s tefransist, s taɛrabt niɣ s darija. Ɛawed s ifilṭren: taggayt, ssuma, tamdint.",
        "Settef s « Pertinence », « Plus récentes », s ssuma niɣ s « Plus proches ».",
        "Ul (cœur) deg annonce ad tt-yerr ɣer « Mes favoris ».",
      ],
      keywords: ["tarzzut", "recherche", "ifilṭren", "favoris", "ssuma"],
    },
    "recherches-et-alertes": {
      title: "Tarzzut yettwaḥerzen d iselɣa",
      summary: "Ḥrez ar {savedMax} n terzzut d ad dak-d yawḍ e-mail yal ass s annonces timaynutin.",
      blocks: [
        "Zi tasna n tarzzut, ḥrez-tt s ifilṭren nnes. Tzemmreḍ ad teḥrezeḍ ar {savedMax}.",
        "I yal tarzzut, xtar e-mail yal ass niɣ war ca. Yal e-mail ɣar-s asaɣ ḥima ad t-tḥebseḍ.",
        "Ad tent-tafeḍ deg « Mes recherches ».",
      ],
      keywords: ["alerte", "asselɣu", "mes recherches", "e-mail"],
    },
    "contacter-un-vendeur": {
      title: "Ad taruḍ i umzenzu",
      summary: "Tibratin n Joutiya d abrid nni kan ḥima ad tmeslayeḍ d umzenzu.",
      blocks: [
        "Rzem annonce d wet x tqeffalt n tebratin. Ixs ad tiliḍ tkecmeḍ s amiḍan yettwasentmen. Deg tebrat tamezwarut ad dak-d tettwassuter tasenqedt anti-robot.",
        "Assa, tibratin d abrid nni kan: uṭṭun n tilifun n umzenzu war d-yettban.",
        {
          list: [
            "Aḍris kan, ar {messageMax} n yisekkilen.",
            "Isuɣan war ttawḍen: ad d-banen ffren.",
            "Ad d-yban usmekti mala tabrat tessiwel x udfaɛ zzat niɣ x RIB.",
          ],
        },
        "E-mail nnec werǧin ad yban: isem nnec kan.",
      ],
      keywords: ["tabrat", "tibratin", "message", "tilifun", "whatsapp", "amzenzu"],
    },
    "bloquer-un-utilisateur": {
      title: "Ad tḥebseḍ yiwen",
      summary: "Aḥbas ad iqen marra tibratin jar-awen.",
      blocks: [
        "Deg tmeslayt, rzem tabdart n tigawin d xtar « Bloquer ». War tettarum ca jar-awen.",
        "Win tḥebseḍ ad iẓar kan belli war yezmir ca ad dak-yari. Tzemmreḍ ad t-tserreḥeḍ melmi ma texsed.",
        "Aḥbas war yessawaḍ ca i umsefrez: mala tabrat d tamencuṛt niɣ d taxriqt, smekti fellas.",
      ],
      keywords: ["bloquer", "ḥbes", "harcèlement", "spam"],
    },
    "eviter-les-arnaques": {
      title: "Ad tḥedreḍ zi tixriqin",
      summary: "War tefkeḍ ca idrimen zzat ma ad teẓreḍ tiɣawsa.",
      blocks: [
        { note: "War tefkeḍ ca idrimen, ɣas d aḥric, zzat ma ad teẓreḍ tiɣawsa d tesneqdeḍ-tt." },
        {
          list: [
            "Win dak-yessutren idrimen zzat s virement niɣ s mandat.",
            "Win dak-yessutren RIB, uṭṭun n tkarḍa niɣ code n SMS.",
            "Win dak-yennan ad tmeslayem deg wadeg nniḍen niɣ dak-yuznen asaɣ.",
            "Ssuma ireẓẓan aṭas, niɣ amzenzu war yezmir ad dak-isken tiɣawsa.",
          ],
        },
        "Mmager amzenzu deg wadeg n medden, s wass. Joutiya war tettekki ca deg udfaɛ, war tessawaḍ ca tiɣawsiwin: win yennan aya d axerraq.",
      ],
      keywords: ["arnaque", "taxriqt", "axerraq", "virement", "rib", "iban", "code"],
    },
    "signaler-un-contenu": {
      title: "Ad tsmektiḍ x yiwet n tɣawsa",
      summary: "Annonce, amiḍan niɣ tabrat war iṣeḥḥan, smekti fellas s kra n tikkal n ufus.",
      blocks: [
        "Wet x « Signaler » deg annonce niɣ deg umiḍan, niɣ deg tabdart n tmeslayt. Xtar sebba, d ari ayen teẓriḍ.",
        "Bla amiḍan, ari isem nnec d e-mail nnec. I tɣawsiwin yeqqursen aṭas (arraw imecṭaḥ, terrorisme, asexsi n tudert), tzemmreḍ ad tsmektiḍ bla isem.",
        "Tiɣawsiwin ixsen awerri ad ttwaɣrent deg yiwet n tsaɛet; tinniḍen deg 24 n tsaɛtin, 3 niɣ 7 n wussan.",
        { note: "Mala yella uɛekkuz nican, ɛeyyeḍ i police (19) niɣ i Gendarmerie royale (177)." },
      ],
      keywords: ["signaler", "asmekti", "police", "urgence"],
    },
    "decisions-et-recours": {
      title: "Tigtinin d urecwar",
      summary: "Yal tagtint ɣar-s sebba nnes, tzemmreḍ ad tagiḍ fellas deg 6 n wayyuren.",
      blocks: [
        "Mala yekkes umsefrez kra niɣ yeɛqeb amiḍan, ad dak-d yawḍ e-mail s sebba. Marra tigtinin nnec deg « Décisions et recours ».",
        {
          steps: [
            "Rzem tagtint deg « Décisions et recours », niɣ asaɣ n e-mail.",
            "Ari mayemmi tagtint war tṣeḥḥa ca.",
            "Azen: ad tt-iɣar umsefrez nniḍen, s umata deg {appealDays} n wussan.",
          ],
        },
        "Ad tagiḍ deg 6 n wayyuren. Mala yettwaqbel, ad d-tuɣal tɣawsa niɣ ad yekkes uɛeqqab.",
      ],
      keywords: ["recours", "tagtint", "décision", "contester"],
    },
    "suspension-de-compte": {
      title: "Asmekti, aḥbas d ukkas n umiḍan",
      summary: "Aɛeqqab yettali s tiseddarin: asmekti, aḥbas n 7 n wussan, 30 n wussan, uca akkas.",
      blocks: [
        { steps: ["asmekti;", "aḥbas n 7 n wussan;", "aḥbas n 30 n wussan;", "akkas n umiḍan i lebda."] },
        "Tamencuṛt yeqqursen aṭas tzemmer ad tekkes amiḍan nican.",
        "Deg uḥbas, tzemmreḍ ad teɣreḍ tibratin nnec d ad tagiḍ x tegtint, maca war tzemmreḍ ad taruḍ niɣ ad tessufɣeḍ annonce.",
      ],
      keywords: ["suspendu", "aḥbas", "banni", "sanction"],
    },
    "donnees-personnelles": {
      title: "Isefka nnec",
      summary: "Ayen nḥerrez, mayemmi, ar melmi, d mamec ad tsexdmeḍ izerfan nnec: deg « Politique de confidentialité ».",
      blocks: [
        "« Politique de confidentialité » tessiwel x isefka, x wussan n uḥraz d x izerfan nnec.",
        "Medden ẓerren kan isem nnec d annonces nnec. E-mail nnec werǧin ad yban.",
        "War tessufɣeḍ ca isefka n medden nniḍen (isem, tilifun, adres, tawlaft).",
      ],
      keywords: ["isefka", "données", "confidentialité", "cookies"],
    },
    "role-de-joutiya": {
      title: "Tawuri n Joutiya",
      summary: "Joutiya teṭṭef annonces n medden: war d amzenzu, war d amsaɣ.",
      blocks: [
        "Annonces arident-tent imawlan nsent, d nitni i ɣer tella.",
        "Joutiya war tettekki ca deg uzenzi: war tettaɣ idrimen jar medden, war tessawaḍ, war tettḍemmen tiɣawsiwin, war tegguḍ ca jar umsaɣ d umzenzu.",
        "Mala yella umennuɣ, ssiwel d umdan nniḍen. Mala d taxriqt, ruḥ ɣer police niɣ ɣer Gendarmerie royale, d smekti x tɣawsa deg Joutiya.",
      ],
      keywords: ["litige", "amennuɣ", "remboursement", "garantie"],
    },
    "assistant-joutiya": {
      title: "Amallal n Joutiya",
      summary: "Amallal n tmusni tamsnalit (IA) i d-yerran x isteqsiyen nnec zi imagraden n tasna n tallalt.",
      blocks: [
        "Amallal n Joutiya d IA, war d amdan. Ad d-yerr zi imagraden n tallalt d ad dak-isken min yesxdem.",
        "Yezmer ad yecceḍ: ɣar amagrad. War yeẓẓar ca amiḍan nnec, war yezmir ad yexdem kra deg umkan nnec.",
        "War t-tfekkeḍ ca isefka nnec: isem, tilifun, e-mail, adres, awal n uɛeddi niɣ code.",
      ],
      keywords: ["assistant", "amallal", "ia", "robot"],
    },
  },
};
