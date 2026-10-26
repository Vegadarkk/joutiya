import type { HelpLocaleContent } from "./catalog";

// Help centre, French (design phase-5 D25). Facts follow the code: placeholders `{name}` come from
// helpValues (src/content/help/index.ts). Describe only what is live: no phone display, no
// WhatsApp contact, no payment between users, no paid offer.

export const HELP_FR: HelpLocaleContent = {
  categories: {
    compte: { title: "Compte et connexion", description: "Créer un compte, se connecter, changer de mot de passe." },
    annonces: { title: "Déposer et gérer une annonce", description: "Dépôt, photos, modification, pause, renouvellement." },
    recherche: { title: "Rechercher", description: "Filtres, favoris, recherches enregistrées et alertes." },
    messagerie: { title: "Messagerie", description: "Écrire à un vendeur, répondre, bloquer quelqu'un." },
    securite: { title: "Sécurité", description: "Reconnaître une arnaque et s'en protéger." },
    moderation: { title: "Signalements et décisions", description: "Signaler un contenu, comprendre une décision, la contester." },
    donnees: { title: "Données et rôle de Joutiya", description: "Vos données, notre rôle d'hébergeur, l'Assistant Joutiya." },
  },
  articles: {
    "creer-un-compte": {
      title: "Créer un compte",
      summary: "Un compte gratuit, avec une adresse e-mail ou un compte Google, pour déposer des annonces et écrire aux vendeurs.",
      blocks: [
        "Consulter les annonces ne demande aucun compte. Il en faut un pour déposer une annonce, écrire à un vendeur, enregistrer des favoris ou des recherches.",
        {
          steps: [
            "Ouvrez la page d'inscription et choisissez votre méthode : adresse e-mail et mot de passe, ou compte Google.",
            "Avec une adresse e-mail, ouvrez le lien de confirmation reçu par e-mail : votre compte est activé dès que l'adresse est confirmée.",
            "Votre nom affiché apparaît sur vos annonces et dans la messagerie ; vous le modifiez dans « Mes paramètres ».",
          ],
        },
        "Le compte est gratuit. Utilisez un mot de passe que vous n'utilisez nulle part ailleurs : un mot de passe trop court, trop courant ou tiré de votre nom est refusé.",
      ],
      keywords: ["inscription", "s'inscrire", "ouvrir un compte", "e-mail de confirmation", "google", "activer"],
    },
    "connexion-et-mot-de-passe": {
      title: "Connexion et mot de passe",
      summary: "Se connecter, retrouver l'accès à son compte et changer de mot de passe.",
      blocks: [
        "Connectez-vous avec la méthode choisie à l'inscription : adresse e-mail et mot de passe, ou compte Google.",
        {
          list: [
            "Mot de passe oublié : demandez un lien de réinitialisation depuis la page « Mot de passe oublié ». Le lien arrive par e-mail ; vérifiez aussi vos courriers indésirables.",
            "Changer de mot de passe : « Mes paramètres », rubrique « Mot de passe ».",
            "Compte créé avec Google : il n'a pas de mot de passe. Pour en ajouter un, demandez un lien de réinitialisation à votre adresse e-mail.",
          ],
        },
        "Après plusieurs mots de passe erronés, la connexion est bloquée quelques minutes pour protéger le compte, et une vérification anti-robots peut vous être demandée.",
        { note: "Joutiya ne vous demandera jamais votre mot de passe, ni un code reçu par SMS ou par e-mail, par message ou par téléphone." },
      ],
      keywords: ["mot de passe oublié", "réinitialiser", "se connecter", "connexion impossible", "bloqué", "déconnexion"],
    },
    "deposer-une-annonce": {
      title: "Déposer une annonce",
      summary: "Le dépôt se fait en quelques étapes, gratuitement ; l'annonce reste en ligne {ttlDays} jours.",
      blocks: [
        "Le dépôt d'une annonce est gratuit. Il faut un compte dont l'adresse e-mail est confirmée.",
        {
          steps: [
            "Cliquez sur « Déposer une annonce » et choisissez la catégorie.",
            "Décrivez l'article : titre, description, critères de la catégorie, prix en dirhams ou don.",
            "Ajoutez au moins une photo : la première sert de couverture.",
            "Indiquez la ville ; le quartier est facultatif et votre adresse n'est jamais demandée.",
            "Relisez, puis publiez.",
          ],
        },
        "Votre brouillon est enregistré au fil de la saisie : vous pouvez reprendre plus tard. Vous pouvez garder jusqu'à {maxDrafts} brouillons ; un brouillon sans modification pendant {draftPurgeDays} jours est supprimé.",
        "En général, l'annonce est en ligne dès sa publication. Certaines sont relues par un modérateur avant leur mise en ligne, en général sous 24 heures ; un e-mail vous prévient.",
        "Une annonce reste en ligne {ttlDays} jours. Vous êtes responsable de ce que vous vendez au regard de la loi marocaine. Les objets et services interdits sur Joutiya sont listés dans la page « Objets interdits ».",
        "Les koumiyas et poignards décoratifs d'artisanat se déposent uniquement dans la catégorie « Koumiyas & poignards décoratifs » (Maison & Jardin), réservée aux personnes majeures : vous attestez que l'objet est décoratif et que vous le vendrez à une personne majeure, chaque annonce est vérifiée par un modérateur avant sa mise en ligne, et le contact passe uniquement par la messagerie.",
      ],
      keywords: ["publier", "vendre", "poster", "mettre en ligne", "nouvelle annonce", "brouillon", "gratuit", "relecture", "koumiya", "poignard"],
    },
    "photos-d-une-annonce": {
      title: "Les photos d'une annonce",
      summary: "Jusqu'à {maxPhotos} photos de {photoMb} Mo chacune, prises par vous et fidèles à l'article.",
      blocks: [
        {
          list: [
            "Jusqu'à {maxPhotos} photos par annonce, de {photoMb} Mo chacune au plus.",
            "Formats acceptés : JPEG, PNG, WebP et HEIC (les photos d'iPhone sont converties sur votre appareil).",
            "Au moins une photo pour publier ; la première est la couverture. Faites glisser les photos pour changer leur ordre.",
          ],
        },
        "Montrez l'article réellement vendu, net, à la lumière du jour et sous plusieurs angles. Une photo prise sur internet ou montrant un autre objet trompe les acheteurs.",
        "Les photos de nudité ou à caractère sexuel sont refusées. Évitez de montrer des visages ou des documents personnels : une photo avec un visage peut faire passer l'annonce en relecture.",
      ],
      keywords: ["image", "taille", "format", "heic", "iphone", "photo refusée", "couverture", "ordre des photos"],
    },
    "gerer-mes-annonces": {
      title: "Gérer mes annonces",
      summary: "Modifier, mettre en pause, marquer comme vendue, renouveler ou supprimer une annonce depuis « Mes annonces ».",
      blocks: [
        "Toutes vos annonces se trouvent dans « Mes annonces », classées par état : en ligne, en relecture, en pause, terminées.",
        {
          list: [
            "Modifier : certaines modifications sont relues par notre équipe avant d'être visibles.",
            "Mettre en pause : l'annonce disparaît des résultats ; vous la remettez en ligne tant qu'elle n'a pas expiré.",
            "Marquer comme vendue : l'annonce quitte les résultats et reste visible en lecture seule dans votre compte.",
            "Renouveler : possible dans les {renewDays} derniers jours, ou après l'expiration ; l'annonce repart pour {ttlDays} jours.",
            "Supprimer : l'annonce est retirée définitivement.",
          ],
        },
        "Le nombre d'annonces actives est limité par compte. Une fois la limite atteinte, mettez en pause ou supprimez une annonce pour en publier une nouvelle.",
      ],
      keywords: ["modifier", "pause", "vendu", "renouveler", "supprimer", "expirée", "mes annonces", "limite"],
    },
    "rechercher-une-annonce": {
      title: "Rechercher une annonce",
      summary: "Mots-clés, catégorie, prix, ville et tri pour trouver une annonce ; les favoris pour la garder.",
      blocks: [
        "Tapez quelques mots dans la barre de recherche, en français, en arabe ou en darija. Affinez ensuite avec les filtres : catégorie, prix, ville et critères propres à la catégorie.",
        "Triez les résultats par pertinence, par date (plus récentes), par prix croissant ou décroissant, ou par distance.",
        "Le cœur d'une annonce l'ajoute à vos favoris, que vous retrouvez dans « Mes favoris » une fois connecté.",
        "La page « Référencement et classement des annonces » explique l'ordre des résultats.",
      ],
      keywords: ["chercher", "trouver", "filtre", "trier", "prix", "ville", "favori", "cœur", "darija"],
    },
    "recherches-et-alertes": {
      title: "Recherches enregistrées et alertes",
      summary: "Enregistrez jusqu'à {savedMax} recherches et recevez chaque jour un e-mail avec les nouvelles annonces.",
      blocks: [
        "Depuis une page de résultats, enregistrez la recherche avec ses filtres. Vous pouvez en garder jusqu'à {savedMax}.",
        "Pour chaque recherche, choisissez une alerte quotidienne par e-mail avec les nouvelles annonces, ou aucune alerte. Chaque e-mail contient un lien pour arrêter l'alerte.",
        "Retrouvez, renommez ou supprimez vos recherches dans « Mes recherches ».",
      ],
      keywords: ["alerte", "notification", "e-mail quotidien", "sauvegarder", "recherche enregistrée", "désabonner"],
    },
    "contacter-un-vendeur": {
      title: "Contacter un vendeur",
      summary: "La messagerie Joutiya est le seul moyen de contacter un vendeur ; elle demande un compte confirmé.",
      blocks: [
        "Pour écrire à un vendeur, ouvrez son annonce et cliquez sur le bouton de contact. Il faut être connecté avec un compte dont l'adresse e-mail est confirmée. Une vérification anti-robots est demandée au premier message d'une conversation.",
        "La messagerie est aujourd'hui le seul moyen de contact entre acheteurs et vendeurs : le numéro de téléphone des vendeurs n'est pas affiché.",
        {
          list: [
            "Messages en texte seul, de {messageMax} caractères au plus.",
            "Les liens ne sont pas transmis : ils apparaissent masqués.",
            "Un avertissement s'affiche quand un message parle de paiement à l'avance ou contient des coordonnées bancaires.",
            "Vous pouvez archiver une conversation ou la supprimer de votre messagerie ; l'autre personne garde la sienne.",
            "Pour une annonce réservée aux majeurs (koumiyas et poignards décoratifs), vous confirmez avoir 18 ans ou plus avant votre premier message.",
          ],
        },
        "Votre adresse e-mail n'est jamais montrée à l'autre personne : seul votre nom affiché apparaît.",
      ],
      keywords: ["message", "écrire", "contacter", "téléphone", "numéro", "whatsapp", "appeler", "répondre", "conversation"],
    },
    "bloquer-un-utilisateur": {
      title: "Bloquer quelqu'un",
      summary: "Bloquer une personne empêche tout échange avec elle, dans toutes les conversations.",
      blocks: [
        "Dans une conversation, ouvrez le menu des actions et choisissez « Bloquer ». Vous ne pourrez plus vous écrire, dans aucune conversation.",
        "La personne bloquée voit seulement qu'elle ne peut plus vous écrire. Vous pouvez la débloquer à tout moment depuis la même conversation.",
        "Bloquer ne prévient pas la modération. Si un message est illégal ou contraire à nos règles (menace, harcèlement, arnaque), signalez-le aussi.",
      ],
      keywords: ["bloquer", "débloquer", "harcèlement", "indésirable", "spam", "insultes"],
    },
    "eviter-les-arnaques": {
      title: "Éviter les arnaques",
      summary: "Ne payez jamais avant d'avoir vu l'article, et restez sur la messagerie Joutiya.",
      blocks: [
        { note: "Ne payez jamais un acompte, des frais de livraison ou un article avant de l'avoir vu et vérifié." },
        "Signes d'arnaque fréquents :",
        {
          list: [
            "un paiement à l'avance demandé par virement, mandat ou transfert d'argent ;",
            "une demande de RIB, de numéro de carte ou d'un code reçu par SMS, présentée comme nécessaire pour « recevoir » un paiement ;",
            "une invitation à continuer la discussion ailleurs, sur une autre application ou par un lien ;",
            "un prix très bas, une urgence inventée, un vendeur qui ne peut jamais montrer l'article.",
          ],
        },
        "Rencontrez le vendeur dans un lieu public, en journée, et vérifiez l'article avant de payer. N'ouvrez pas les liens envoyés par des inconnus.",
        "Joutiya ne prend jamais part au paiement entre acheteur et vendeur et ne propose aucune livraison : un message qui prétend le contraire est une arnaque. Signalez-le. Si vous avez été victime d'une arnaque, portez plainte auprès de la police ou de la Gendarmerie royale, ou signalez-la sur e-blagh.ma, la plateforme de la Sûreté nationale.",
      ],
      keywords: ["arnaque", "escroquerie", "fraude", "acompte", "virement", "rib", "iban", "code sms", "lien", "faux vendeur", "livraison"],
    },
    "signaler-un-contenu": {
      title: "Signaler un contenu",
      summary: "Une annonce, un profil ou un message illégal ou contraire à nos règles se signale en quelques clics.",
      blocks: [
        "Utilisez le lien « Signaler » d'une annonce ou d'un profil, ou le menu d'une conversation pour un message. Choisissez le motif, puis décrivez les faits.",
        {
          list: [
            "Sans compte, indiquez votre nom et votre adresse e-mail pour être informé de la décision. Pour les motifs les plus graves (protection des mineurs, terrorisme, menace pour la vie ou la sécurité), vous pouvez signaler sans vous identifier.",
            "Signaler un message demande d'être connecté et de participer à la conversation.",
            "La personne concernée ne connaît pas votre identité.",
          ],
        },
        "Chaque signalement reçoit une référence. Les cas urgents sont traités dans l'heure ; les autres sous 24 heures, 3 jours ou 7 jours selon leur gravité. La décision vous est envoyée par e-mail.",
        "Signalez de bonne foi : des signalements manifestement infondés et répétés peuvent entraîner la suspension de vos signalements.",
        { note: "En cas de danger immédiat, appelez la police (19) ou la Gendarmerie royale (177)." },
      ],
      keywords: ["signaler", "signalement", "dénoncer", "contenu illégal", "abus", "dsa", "police", "urgence"],
    },
    "decisions-et-recours": {
      title: "Décisions et recours",
      summary: "Chaque décision de modération est motivée et peut être contestée pendant 6 mois.",
      blocks: [
        "Quand la modération retire ou restreint un contenu, ou sanctionne un compte, vous recevez un e-mail qui explique la décision : les faits, la règle appliquée et la façon de la contester. Toutes vos décisions se trouvent dans « Décisions et recours ».",
        {
          steps: [
            "Ouvrez la décision dans « Décisions et recours », ou le lien de recours reçu par e-mail (aucun compte n'est nécessaire avec ce lien).",
            "Expliquez pourquoi la décision vous paraît injustifiée, en restant factuel.",
            "Envoyez le recours : il est examiné par un autre modérateur que celui qui a décidé, en principe sous {appealDays} jours.",
          ],
        },
        "Un recours se dépose dans les 6 mois qui suivent la décision. Si le recours est accepté, le contenu est rétabli ou la sanction levée. Vous gardez dans tous les cas la possibilité de saisir le tribunal compétent.",
      ],
      keywords: ["recours", "contester", "décision", "annonce retirée", "refusée", "motif", "appel", "injuste"],
    },
    "suspension-de-compte": {
      title: "Avertissement, suspension et bannissement",
      summary: "Les sanctions sont progressives : avertissement, suspension de 7 jours, puis de 30 jours, puis bannissement.",
      blocks: [
        "Quand un compte enfreint nos règles à plusieurs reprises, les sanctions augmentent par étapes :",
        { steps: ["un avertissement ;", "une suspension de 7 jours ;", "une suspension de 30 jours ;", "le bannissement du compte."] },
        "Une infraction très grave peut entraîner un bannissement immédiat. Chaque sanction est motivée par e-mail.",
        "Pendant une suspension, vous pouvez lire vos conversations et contester la décision, mais vous ne pouvez plus envoyer de message ni publier d'annonce.",
        "Si votre recours est accepté, la sanction est levée et votre compte redescend d'une étape.",
      ],
      keywords: ["suspendu", "suspension", "banni", "bannissement", "compte bloqué", "avertissement", "sanction"],
    },
    "donnees-personnelles": {
      title: "Vos données personnelles",
      summary: "Ce que nous collectons, pourquoi, combien de temps, et comment exercer vos droits : tout est dans la politique de confidentialité.",
      blocks: [
        "La politique de confidentialité décrit les données traitées, leurs finalités, leurs durées de conservation et vos droits (accès, rectification, effacement, opposition, portabilité). Elle indique aussi comment exercer ces droits.",
        "Les autres utilisateurs ne voient que votre nom affiché et vos annonces. Votre adresse e-mail n'est jamais publiée.",
        "Ne publiez pas les données personnelles d'autres personnes (nom, téléphone, adresse, photo) dans une annonce ou un message.",
        "La page « Gestion des cookies » explique les cookies utilisés et vos choix.",
      ],
      keywords: ["données", "vie privée", "rgpd", "cndp", "supprimer mes données", "cookies", "confidentialité", "droits"],
    },
    "role-de-joutiya": {
      title: "Le rôle de Joutiya",
      summary: "Joutiya héberge les annonces de ses utilisateurs : elle n'est ni vendeur, ni acheteur, ni partie aux ventes.",
      blocks: [
        "Joutiya met en relation acheteurs et vendeurs. Les annonces sont écrites et publiées par leurs auteurs, qui en sont responsables.",
        "Joutiya n'intervient pas dans la vente : elle n'encaisse aucun paiement entre utilisateurs, ne livre rien, ne garantit pas les articles et n'arbitre pas les litiges entre acheteur et vendeur.",
        "En cas de désaccord, cherchez d'abord une solution à l'amiable avec l'autre personne. Entre particuliers, la vente relève du Dahir formant Code des obligations et des contrats (DOC) ; quand un professionnel vend à un consommateur, la loi n° 31-08 sur la protection du consommateur s'applique aussi. À défaut d'accord, vous pouvez saisir le tribunal compétent. En cas d'escroquerie ou d'infraction, portez plainte auprès de la police, de la Gendarmerie royale ou du procureur du Roi, et signalez le contenu sur Joutiya.",
      ],
      keywords: ["litige", "remboursement", "garantie", "hébergeur", "responsabilité", "médiation", "conflit", "vendeur malhonnête"],
    },
    "assistant-joutiya": {
      title: "L'Assistant Joutiya",
      summary: "Un assistant d'intelligence artificielle qui répond à vos questions à partir des articles de ce centre d'aide.",
      blocks: [
        "L'Assistant Joutiya est une intelligence artificielle, pas une personne. Il répond à partir des articles du centre d'aide et indique ceux qu'il a utilisés.",
        "Il peut se tromper : vérifiez dans l'article cité. Il n'a pas accès à votre compte et ne peut faire aucune action à votre place (modifier une annonce, traiter un signalement, lever une sanction).",
        "Ne lui donnez aucune donnée personnelle : nom, téléphone, adresse e-mail, adresse, mot de passe ou code.",
        "Quand le service n'est pas disponible, l'assistant affiche les articles du centre d'aide qui correspondent à votre question.",
      ],
      keywords: ["assistant", "ia", "intelligence artificielle", "robot", "chatbot", "aide"],
    },
  },
};
