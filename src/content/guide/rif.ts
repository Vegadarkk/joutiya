import type { GuideLocaleContent } from "./catalog";

// Admin procedures guide, Tarifit in Latin script (design guide-demarches G1, Z9): same procedures
// and facts as fr.ts, shorter. Draft wording: a native speaker reviews it with the help centre
// before launch. Link labels keep the administrations' own names.

export const GUIDE_RIF: GuideLocaleContent = {
  rubrics: {
    etudiant: {
      title: "Inelmaden",
      summary: "Orientation mbeɛd bac, tiwsa n leqraya, axxam n tesdawit, asurif n tdawit, leqraya deg Fransa.",
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
      summary: "CNIE, passeport, rasm n tlalit, casier judiciaire, tamurt (nationalité), service militaire.",
      intro: "Deg Lmeɣrib, CNIE d passeport ttwagen ɣer DGSN, d rasm n tlalit ɣer leḥala madaniya n tjmaɛt. Zeg berra, consulat ad yegg aya.",
    },
    sante: {
      title: "Asurif n tdawit (AMO)",
      summary: "AMO n ixeddamen d win yxeddmen i yixef-nnes, AMO Tadamon (RAMED zik), imuwaḍḍfen.",
      intro: "Ass-a, AMO teṭṭef ixeddamen, win yxeddmen i yixef-nnes d win war ɣer-s ca n wedrim. CNSS d nettat i yessegden aṭas n yinagrawen; imuwaḍḍfen mazal ɣer CNOPS ar d yekmel usiweḍ-nsen ɣer CNSS.",
    },
    retraite: {
      title: "Retrite",
      summary: "Retrite n CNSS, CMR niɣ RCAR, d retrite tamarnut (CIMR).",
      intro: "Asenduq n retrite nnec yeqqen ɣer bab n lexdma: CNSS i tmesxedmin tusligin, CMR i imuwaḍḍfen d iɛeskriyen, RCAR i imxeddmen s lɛaqd d aṭas n tmesxedmin n dawla. Retrite tamarnut (CIMR) tzemmer ad d-tarni.",
    },
    "aides-sociales": {
      title: "Tiwsa n dawla (RSU)",
      summary: "Ajjel deg RSU, tiwsa tusridt, tiwsa n uxxam.",
      intro: "Tiwsa n dawla ttɛeddant s RSU: ajjel n twacunt yettak-as amaṭṭaf yesbeyyanen ma tzemmer ad tawi tiwsa tusridt d AMO Tadamon. Ḥḍer zeg win ak-isutren idrimen ḥima ad k-yejjel: xdem s tisniwin tiɣelnawin kan.",
    },
    "eau-electricite": {
      title: "Aman d trisiti",
      summary: "Abonnement, abeddel n bab n abonnement, résiliation, tifaturin d ccekwa.",
      intro: "Asenfar n waman, n trisiti d tumsiḍt yettraḥ, tamnaḍt s tamnaḍt, ɣer tisharikin timnaḍin (SRM) i yeddan deg umkan n ONEE, n régies d tisharikin zik am Lydec. Deg kra n temdinin, amsenfar aqdim mazal d netta i k-yettqabalen: isem n umsenfar nnec yura x tfatura.",
    },
    assurances: {
      title: "Ttamin",
      summary: "Ttamin n tmubilt d lwajib, accident, ccekwa x tsharikt n ttamin.",
      intro: "Tisharikin n ttamin ttwaḥeḍrent s ACAPS. Ma temsenɣaḍ d tsharikt nnec, ari-as amezwaru ccekwa s tira; ma war tqebbleḍ tiririt nnes, ACAPS tqebbel ccekwat n imsaɣen n ttamin.",
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
    "orientation-postbac": {
      title: "Isutar mbeɛd bac (tinezmar, ṭṭib, CPGE)",
      body: [
        "Isutar ɣer tinezmar s ufran (ingénieurs, commerce, ṭṭib d pharmacie, EST, FST…) ttwagen deg tesna taɣelnawt Cursussup, s code Massar. Tifakultiyin tiṛẓmin jjelent inelmaden-nsent qbala.",
        "CPGE ɣer-s tasna nnes i isutar. Imezgura ttffɣen-d kul aseggwas: aru izmaz mlmi d-ffɣen.",
      ],
      prepare: ["Code Massar nnec", "Relevés n tinuḍin nnec"],
    },
    "etudes-france": {
      title: "Leqraya deg Fransa (Campus France, Parcoursup)",
      body: [
        "Aṭas n inelmaden imerrukiyen ttɛeddan s Campus France Maroc: abrid (tasna Études en France niɣ Parcoursup) yeqqen ɣer bac nnec d tɣuri i tebɣiḍ. Inelmaden n tesnawiyin tifransisin deg Lmeɣrib ttagen isutar-nsen s Parcoursup.",
        "Mbeɛd ma ttwaqbleḍ, visa n unelmad tettḍfar abrid i d-yenna Campus France.",
      ],
    },
    "amo-salaries": {
      title: "AMO n ixeddamen d win yxeddmen i yixef-nnes",
      body: [
        "Bab n lexdma yettjjel ixeddamen n tmesxedmin tusligin deg CNSS; win yxeddmen i yixef-nnes, tiwuriwin tilelliyin d auto-entrepreneurs jjelen ixef-nsen d xelleṣen tiwsa-nsen i CNSS.",
        "Ifuyla n tdawit ttwagen deg tnezmart niɣ deg internet. Senqed ma ttwajjlen wid yeqqnen ɣer-k (tameṭṭut niɣ argaz, tarwa).",
      ],
      prepare: ["CNIE nnec", "Uṭṭun n CNSS nnec"],
    },
    "amo-tadamon": {
      title: "AMO Tadamon (RAMED zik)",
      body: [
        "AMO Tadamon teddar deg umkan n RAMED: dawla txelleṣ tiwsa n wid war yzemmren ad xelleṣen. Ayen yesbeyyanen ma tzemmreḍ d amaṭṭaf n twacunt deg RSU; umbeɛd CNSS d nettat i yessegden asurif.",
        "Ma yuli umaṭṭaf nnec x tilist, AMO Achamil tettak-ak ad tjjleḍ deg CNSS s uxelleṣ n tiwsa s yixef-nnec.",
      ],
    },
    "amo-fonctionnaires": {
      title: "AMO n imuwaḍḍfen",
      body: [
        "Asurif n tdawit n imuwaḍḍfen n dawla yeqqen ɣer CNOPS d tmutualin n dawla. Lqanun 54-23 yettawi asegged-a ɣer CNSS: ar azemz n usiweḍ i d-ttinin yiḍrisen, ifuyla qqimen ɣer CNOPS. Ḍfer tinɣirin tiɣelnawin.",
      ],
    },
    "retraite-cnss": {
      title: "Retrite n ixeddamen n tmesxedmin tusligin (CNSS)",
      body: [
        "CNSS tettak retrite i ixeddamen n tmesxedmin tusligin; asuter yettwag ɣer-s mlmi yqerreb lɛemr n retrite. Lḥeqq d tmenni n retrite qqnen ɣer wussan i yettwajjlen: senqed kul mlmi ma k-yettjjel bab n lexdma.",
      ],
      prepare: ["CNIE nnec", "Uṭṭun n CNSS nnec", "RIB s yisem nnec"],
    },
    "retraite-public": {
      title: "Retrite n imuwaḍḍfen (CMR, RCAR)",
      body: [
        "Imuwaḍḍfen d iɛeskriyen xelleṣen i CMR. Imxeddmen s lɛaqd n dawla d tjmaɛtin, d imxeddmen n aṭas n tmesxedmin n dawla, qqnen ɣer RCAR, i yessegden CDG.",
        "Kul asenduq ɣer-s tasna deg internet ḥima ad tḍefreḍ amecwar nnec, ad tsutreḍ retrite niɣ retrite n wid yeqqimen (réversion).",
      ],
    },
    "retraite-complementaire": {
      title: "Retrite tamarnut (CIMR)",
      body: ["Ma bab n lexdma nnec yella deg CIMR, retrite tamarnut tarni x tin n CNSS. CIMR tettak daɣ aḥraz n retrite s yixef-nnec. Retrite tettwasuter ɣer-s mlmi tffɣeḍ ɣer retrite."],
    },
    "rsu-inscription": {
      title: "Ajjel deg RNP umbeɛd deg RSU",
      body: [
        "Kul yiwen deg twacunt yettjjel amezwaru deg RNP, i yettaken uṭṭun n internet. Umbeɛd, bab n twacunt yettjjel twacunt deg RSU, deg internet niɣ deg umkan n ujjel ɣer tjmaɛt niɣ lqiyada.",
        "RSU yettḥessab amaṭṭaf n twacunt. Ini kul abeddel (tlalit, abeddel n uxxam, idrimen) ḥima ad yeqqim d aṣeḥḥi.",
      ],
      prepare: ["Tikarḍiwin CNIE n imeqqranen n twacunt", "Lkunnac n twacunt niɣ rasm n tlalit n tarwa"],
    },
    "aide-sociale-directe": {
      title: "Asuter n tiwsa tusridt",
      body: [
        "Tiwsa tusridt tettwaxelleṣ kul ayyur i twacunin i ɣer yella lḥeqq s umaṭṭaf-nsent deg RSU: tiwsa n tarwa, n tɣuri-nsen d n tlalit, niɣ amur yuɣen i twacunt. Asuter yettwag deg internet mbeɛd ajjel n twacunt deg RSU.",
      ],
    },
    "aide-logement": {
      title: "Tiwsa tusridt i usɣa n uxxam",
      body: [
        "Ahil n tiwsa n uxxam yettak tiwsa tusridt i imerrukiyen, deg Lmeɣrib niɣ deg berra, war ɣer-sen axxam deg Lmeɣrib d ad aɣen axxam amaynu. Asuter yettwag deg internet uqbel tira n tzenzit; tiwsa tettwaxelleṣ ɣer notaire.",
        "Deg {brand}, senqed d umzenzu ma axxam yekcem deg wahil uqbel ad temsaɣeḍ.",
      ],
    },
    "energie-abonnement": {
      title: "Abonnement n waman d trisiti",
      body: [
        "Abonnement yettwasuter deg tnezmart niɣ deg tnezmart n internet n umsenfar n temdint nnec (SRM, amsenfar aqdim niɣ ONEE, s umkan). Axxam amaynu yexs amezwaru branchement, xdem-it uqbel ad tzedɣeḍ deg-s.",
      ],
      prepare: ["CNIE nnec", "Titre n tmilkit niɣ lɛaqd n lekra", "Uṭṭun n compteur, ma yella"],
    },
    "energie-gestion": {
      title: "Abeddel n bab n abonnement, résiliation, axelleṣ, ccekwa",
      body: [
        "Mlmi tbeddleḍ axxam, tzenzeḍ niɣ tekriḍ, suter abeddel n bab n abonnement niɣ résiliation, d aru index n compteur d wayeḍ: mala, ayen yettwaswen ad yeqqim s yisem nnec.",
        "Tifaturin ttwaẓrant d ttwaxelleṣent deg internet; ccekwa tettwag s tira ɣer umsenfar, ḥrez yiwet n nnusxa.",
      ],
    },
    "assurance-auto": {
      title: "Ttamin n tmubilt: lwajib d accident",
      body: [
        "Ttamin n responsabilité civile d lwajib i kul tamubilt i yteddun deg ubrid. Mbeɛd ma taɣeḍ tamubilt deg {brand}, ari lɛaqd n ttamin s yisem nnec uqbel ad tenhreḍ, d ḥrez attestation deg tmubilt.",
        "Ma tella accident, ari constat amiable d umenhar nniḍen, d ini accident i tsharikt nnec n ttamin deg wakud i yuran deg lɛaqd.",
      ],
    },
    "assurance-reclamation": {
      title: "Ccekwa x tsharikt n ttamin",
      body: [
        "Ari amezwaru ccekwa s tira i tsharikt nnec n ttamin niɣ i wemsiweḍ-nnes, d ḥrez ayen yesbeyyanen tuzna. Ma war d-tusi tiririt niɣ war tqebbleḍ-tt, ag ccekwa ɣer ACAPS deg tesna-nnes n internet.",
      ],
    },
    "id-service-militaire": {
      title: "Service militaire",
      body: [
        "Service militaire yeqqen ɣer iḥenjiren d tḥenjirin zeg 19 ar 25 n iseggwasen. Deg kul tamesrudt n uḥessab, wid yeqqnen ɣer-s ttarun takarḍa deg internet, umbeɛd ttawin-d convocation ma yexs. Dispense d report ttwasbeyyanen deg tesna taɣelnawt.",
      ],
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
    cursussup: "Isutar mbeɛd bac (Cursussup)",
    cpge: "Isutar ɣer CPGE",
    "campusfrance-procedures": "Iberdan n leqraya deg Fransa (Campus France Maroc)",
    parcoursup: "Tasna Parcoursup",
    cnops: "Tasna n CNOPS",
    rsu: "Ajjel aɣelnaw n twacunin (RSU)",
    rnp: "Ajjel aɣelnaw n yimezdaɣ (RNP)",
    asd: "Tiwsa tusridt",
    "daam-sakane": "Tiwsa tusridt n uxxam",
    cmr: "Asenduq amerruki n retrite (CMR)",
    "rcar-affiliation": "Ajjel d tiwsa n RCAR",
    "cimr-pension": "Retrite n CIMR",
    "srm-casablanca": "SRM Casablanca-Settat",
    "redal-particuliers": "Tasna n imsaɣen n Redal",
    "amendis-abonnement": "Branchement d abonnement (Amendis)",
    "amendis-gestion": "Asegged n abonnement (Amendis)",
    onee: "ONEE (trisiti d waman)",
    acaps: "ACAPS (aḥeḍḍar n ttamin)",
    "acaps-reclamation": "Ccekwa x tsharikt n ttamin (ACAPS)",
    tajnid: "Tasna n service militaire",
  },
};
