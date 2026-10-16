# Modèles locaux du worker (nudité, visages)

Phase 3, décision D7. Le worker contrôle chaque photo avec deux modèles ONNX exécutés sur le CPU
(`onnxruntime-node` 1.30.0, un thread intra-op, sessions créées une fois par processus). Aucune
image ne quitte le serveur : c'est ce qui remplace Google Vision (~42 USD/mois au volume de
référence). Les fichiers ne sont jamais dans Git : `models/MANIFEST.json` fixe l'URL, la révision et
le sha256 de chacun, `node scripts/fetch-models.ts` les télécharge et vérifie l'empreinte (il saute
un fichier déjà présent et valide ; `--check` vérifie sans télécharger), et le Dockerfile fait la
même chose à la construction de l'image `worker` (étape `models`, réseau nécessaire à ce moment-là
uniquement ; l'image `web` ne les contient pas). Dans le conteneur : `/app/models`,
`MEDIA_MODELS_DIR=/app/models`. En local : `./models` par défaut.

Sans les fichiers, `createImageClassifier` utilise un classifieur factice (score 0, aucun visage) en
développement seulement. Hors développement, chaque contrôle échoue : le job média réessaie, puis
l'envoi finit refusé (`expired`) et une alerte P1 part (une par heure au plus). Aucune photo n'est
publiée sans les deux contrôles (nudité et visages).

## Tableau

| Modèle | Fichier | Source (URL épinglée) | Révision | sha256 | Licence | Taille | Entrée | Sortie |
|---|---|---|---|---|---|---|---|---|
| Nudité : Marqo/nsfw-image-detection-384 (timm `vit_tiny_patch16_384`, 5,6 M paramètres), export ONNX opset 17 reproductible par ICIJ | `nsfw-marqo-384.onnx` | https://huggingface.co/ICIJ/nsfw-image-detection-384-onnx/resolve/4f63fac119fb24a9d98393e57549b1427530ca52/marqo-nsfw-384.onnx | `4f63fac119fb24a9d98393e57549b1427530ca52` (poids d'origine : Marqo rév. `0c26ec22111b83f106d72a55f611ec35962bcb65`) | `50256dde930a4ceeb8953246ba7345158e02cc0a201a173402ab3e6e3a76f40a` | Apache-2.0 (modèle et export) | 22 450 955 octets | `pixel_values` `[1,3,384,384]` float32, RGB, image écrasée (sans recadrage) à 384×384, `(x/255 − 0,5)/0,5` | `logits` `[1,2]` ; softmax côté code ; indice 0 = NSFW, indice 1 = SFW |
| Visages : YuNet 2023mar (OpenCV Zoo, d'après ShiqiYu/libfacedetection.train) | `yunet-2023mar.onnx` | https://huggingface.co/opencv/face_detection_yunet/resolve/3cc26e7f1014a5ee5d74a42acee58bafc9d0a310/face_detection_yunet_2023mar.onnx | `3cc26e7f1014a5ee5d74a42acee58bafc9d0a310` | `8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4` | MIT (© 2020 Shiqi Yu) | 232 589 octets | `input` `[1,3,640,640]` float32, **BGR**, 0–255 sans normalisation, image écrasée à 640×640 | 12 tenseurs `cls_s`, `obj_s`, `bbox_s`, `kps_s` pour s ∈ {8, 16, 32} ; score = √(cls × obj) ; boîte = (décalages cx, cy en cellules, log w, log h) × s ; NMS (IoU 0,3) côté code |

Empreintes recalculées sur les fichiers téléchargés le 2026-10-16 (identiques aux valeurs publiées).
Les deux exports ONNX ont été chargés avec ORT 1.30 ; sur une image unie et un dégradé générés
par sharp, P(NSFW) < 0,5 et aucun visage (test `tests/unit/media-classify.test.ts`, exécuté
seulement quand les fichiers sont présents).

## Seuils (`src/config/ai.ts`, surchargeables plus tard par Firestore `config/ai`)

- Nudité : P(NSFW) ≥ 0,85 → photo rejetée à l'envoi (`rejectReason: nsfw`), jamais l'annonce ;
  ≥ 0,60 → drapeau `nsfw_review` (annonce en `needs_review`).
- Visages : un visage de confiance ≥ 0,60 → drapeau `face`.
- Ces valeurs sont des points de départ : à calibrer sur un jeu de photos du site (sous-vêtements,
  maillots, bébés, plage) avant d'être considérées comme fiables. Aucune évaluation de précision des
  exports ONNX sur des photos réelles n'a été faite.

## Pré-traitement (`src/lib/media/classify.ts`)

Les deux modèles reçoivent la variante `l` (WebP ≤ 1600 px) déjà produite par sharp, pas
l'original : orientation EXIF appliquée, transparence aplatie sur blanc, espace sRGB, redimensionnement
`fit: "fill"` (écrasement, aucun bord perdu), tenseur NCHW float32 planaire. Nudité : RGB,
`x/127,5 − 1`. Visages : BGR, 0–255. Options de session : `executionProviders: ["cpu"]`,
`intraOpNumThreads: 1`, `interOpNumThreads: 1`, `graphOptimizationLevel: "all"`,
`enableCpuMemArena: false`, `enableMemPattern: false`, `logSeverityLevel: 3`.

Latences mesurées (x86-64, un thread, pas d'arm64) : nudité 150–310 ms, visages 30–190 ms,
chargement des sessions 20–230 ms, +26 à 101 MB de RSS par session.

## Vérifier et renouveler

1. `node scripts/fetch-models.ts --check` : présence et sha256 (code de sortie 1 sinon).
2. Changer de modèle = nouvelle entrée dans `models/MANIFEST.json` (URL épinglée sur un commit,
   sha256 recalculé localement avec `sha256sum`), mise à jour de `MODEL_FILES` dans `classify.ts`,
   de ce document et du test de cohérence (`media-classify.test.ts`).
3. La CI (job `image`) ouvre une session ORT sur le modèle de visages dans l'image `worker` : les
   binaires arm64 et la présence des fichiers sont ainsi prouvés à chaque PR qui touche l'image.

## Points ouverts

- Les licences couvrent les poids ; les conditions des jeux d'entraînement (WIDER FACE pour YuNet,
  jeu propriétaire de 220 k images pour Marqo) n'ont pas été examinées : à faire valider par le
  propriétaire (critère de sortie « licences vérifiées »).
- Les deux fichiers sont des conversions tierces (ICIJ, OpenCV Zoo). Alternative : ré-exporter les
  poids Marqo une fois et héberger le fichier sur R2.
- Aucune mesure sur Oracle A1 (arm64) : vérifier la latence et la mémoire du worker en staging
  (limite 384 Mo) avant d'augmenter la concurrence.
