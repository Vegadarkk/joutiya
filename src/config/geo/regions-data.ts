// Generated from scripts/data/regions-cities.json by scripts/gen-regions.mjs. Do not edit by hand.
// Coordinates: Wikidata P625 rounded to 4 decimals; populations: Wikidata P1082 latest (mostly the 2024
// census). Region order = décret 2.15.40 (codes 01-12). Arabic names are the Wikidata labels, hyphenated
// and without the leading "جهة". Licence: CC0 (Wikidata).

export interface RegionData {
  code: string;
  slug: string;
  nameFr: string;
  nameAr: string;
  /** Slug of the chef-lieu city. */
  chefLieu: string;
  /** Wikidata P625 of the region item: a representative point, not a geometric centroid. */
  centroid: { lat: number; lng: number };
}

export interface CityData {
  slug: string;
  nameFr: string;
  nameAr: string;
  regionCode: string;
  lat: number;
  lng: number;
  /** Shown first in the city picker (large cities and region capitals). */
  major: boolean;
  /** Latest Wikidata population (census or communal figure). */
  population: number;
  /** Local spellings the city picker also matches ("Laaroui" for Al Aaroui); never displayed. */
  aliases?: readonly string[];
}

export const REGIONS_DATA: readonly RegionData[] = [
  { code: "01", slug: "tanger-tetouan-al-hoceima", nameFr: "Tanger-Tétouan-Al Hoceïma", nameAr: "طنجة-تطوان-الحسيمة", chefLieu: "tanger", centroid: { lat: 35.2029, lng: -5.551 } },
  { code: "02", slug: "oriental", nameFr: "L'Oriental", nameAr: "الشرق", chefLieu: "oujda", centroid: { lat: 34.6833, lng: -1.9 } },
  { code: "03", slug: "fes-meknes", nameFr: "Fès-Meknès", nameAr: "فاس-مكناس", chefLieu: "fes", centroid: { lat: 34.0333, lng: -5 } },
  { code: "04", slug: "rabat-sale-kenitra", nameFr: "Rabat-Salé-Kénitra", nameAr: "الرباط-سلا-القنيطرة", chefLieu: "rabat", centroid: { lat: 34.0333, lng: -6.8333 } },
  { code: "05", slug: "beni-mellal-khenifra", nameFr: "Béni Mellal-Khénifra", nameAr: "بني ملال-خنيفرة", chefLieu: "beni-mellal", centroid: { lat: 32.46, lng: -6.35 } },
  { code: "06", slug: "casablanca-settat", nameFr: "Casablanca-Settat", nameAr: "الدار البيضاء-سطات", chefLieu: "casablanca", centroid: { lat: 33.5333, lng: -7.5833 } },
  { code: "07", slug: "marrakech-safi", nameFr: "Marrakech-Safi", nameAr: "مراكش-آسفي", chefLieu: "marrakech", centroid: { lat: 31.3771, lng: -8.2782 } },
  { code: "08", slug: "draa-tafilalet", nameFr: "Drâa-Tafilalet", nameAr: "درعة-تافيلالت", chefLieu: "errachidia", centroid: { lat: 30.9, lng: -5.6 } },
  { code: "09", slug: "souss-massa", nameFr: "Souss-Massa", nameAr: "سوس-ماسة", chefLieu: "agadir", centroid: { lat: 30.08, lng: -8.48 } },
  { code: "10", slug: "guelmim-oued-noun", nameFr: "Guelmim-Oued Noun", nameAr: "كلميم-واد نون", chefLieu: "guelmim", centroid: { lat: 28.45, lng: -10.11 } },
  { code: "11", slug: "laayoune-sakia-el-hamra", nameFr: "Laâyoune-Sakia El Hamra", nameAr: "العيون-الساقية الحمراء", chefLieu: "laayoune", centroid: { lat: 26.44, lng: -12.55 } },
  { code: "12", slug: "dakhla-oued-ed-dahab", nameFr: "Dakhla-Oued Ed-Dahab", nameAr: "الداخلة-وادي الذهب", chefLieu: "dakhla", centroid: { lat: 23, lng: -15 } },
];

export const CITIES_DATA: readonly CityData[] = [
  { slug: "tanger", nameFr: "Tanger", nameAr: "طنجة", regionCode: "01", lat: 35.7695, lng: -5.8045, major: true, population: 1275428 },
  { slug: "tetouan", nameFr: "Tétouan", nameAr: "تطوان", regionCode: "01", lat: 35.5697, lng: -5.3758, major: true, population: 422757 },
  { slug: "al-hoceima", nameFr: "Al Hoceïma", nameAr: "الحسيمة", regionCode: "01", lat: 35.245, lng: -3.9313, major: false, population: 50225 },
  { slug: "larache", nameFr: "Larache", nameAr: "العرائش", regionCode: "01", lat: 35.1951, lng: -6.154, major: false, population: 133731 },
  { slug: "ksar-el-kebir", nameFr: "Ksar El Kébir", nameAr: "القصر الكبير", regionCode: "01", lat: 34.9991, lng: -5.8998, major: false, population: 124701 },
  { slug: "assilah", nameFr: "Assilah", nameAr: "أصيلة", regionCode: "01", lat: 35.4618, lng: -6.0377, major: false, population: 36039 },
  { slug: "chefchaouen", nameFr: "Chefchaouen", nameAr: "شفشاون", regionCode: "01", lat: 35.1688, lng: -5.2683, major: false, population: 46168 },
  { slug: "ouezzane", nameFr: "Ouezzane", nameAr: "وزان", regionCode: "01", lat: 34.7979, lng: -5.5819, major: false, population: 57737 },
  { slug: "fnideq", nameFr: "Fnideq", nameAr: "الفنيدق", regionCode: "01", lat: 35.8392, lng: -5.3614, major: false, population: 77250 },
  { slug: "mdiq", nameFr: "M'diq", nameAr: "المضيق", regionCode: "01", lat: 35.6834, lng: -5.3232, major: false, population: 67599 },
  { slug: "martil", nameFr: "Martil", nameAr: "مرتيل", regionCode: "01", lat: 35.6174, lng: -5.2742, major: false, population: 95896 },
  { slug: "oujda", nameFr: "Oujda", nameAr: "وجدة", regionCode: "02", lat: 34.6867, lng: -1.9114, major: true, population: 506224 },
  { slug: "nador", nameFr: "Nador", nameAr: "الناظور", regionCode: "02", lat: 35.1739, lng: -2.9292, major: true, population: 158202 },
  { slug: "berkane", nameFr: "Berkane", nameAr: "بركان", regionCode: "02", lat: 34.9167, lng: -2.3167, major: false, population: 99069 },
  { slug: "taourirt", nameFr: "Taourirt", nameAr: "تاوريرت", regionCode: "02", lat: 34.41, lng: -2.89, major: false, population: 100402 },
  { slug: "guercif", nameFr: "Guercif", nameAr: "جرسيف", regionCode: "02", lat: 34.23, lng: -3.36, major: false, population: 80703 },
  { slug: "jerada", nameFr: "Jerada", nameAr: "جرادة", regionCode: "02", lat: 34.31, lng: -2.16, major: false, population: 41014 },
  { slug: "driouch", nameFr: "Driouch", nameAr: "الدريوش", regionCode: "02", lat: 34.9769, lng: -3.391, major: false, population: 15661 },
  { slug: "figuig", nameFr: "Figuig", nameAr: "فجيج", regionCode: "02", lat: 32.1167, lng: -1.2269, major: false, population: 10449 },
  { slug: "saidia", nameFr: "Saïdia", nameAr: "السعيدية", regionCode: "02", lat: 35.085, lng: -2.2392, major: false, population: 10514 },
  { slug: "ahfir", nameFr: "Ahfir", nameAr: "أحفير", regionCode: "02", lat: 34.9514, lng: -2.1025, major: false, population: 16310 },
  { slug: "zaio", nameFr: "Zaïo", nameAr: "زايو", regionCode: "02", lat: 34.9419, lng: -2.7342, major: false, population: 36766 },
  { slug: "al-aaroui", nameFr: "Al Aaroui", nameAr: "العروي", regionCode: "02", lat: 35.0102, lng: -3.0123, major: false, population: 46540, aliases: ["Al Aroui", "Laaroui", "Laroui", "El Aroui", "Aroui", "Aarouit"] },
  { slug: "beni-ensar", nameFr: "Beni Ensar", nameAr: "بني انصار", regionCode: "02", lat: 35.2597, lng: -2.9336, major: false, population: 50508, aliases: ["Beni Ansar", "Bni Ansar", "Beni Nsar", "Bni Nsar", "بني أنصار"] },
  { slug: "zeghanghane", nameFr: "Zeghanghane", nameAr: "أزغنغان", regionCode: "02", lat: 35.1549, lng: -3.0046, major: false, population: 31431, aliases: ["Zghanghan", "Azghanghan", "Zeghanghan", "Izeghenghan", "ازغنغان"] },
  { slug: "selouane", nameFr: "Selouane", nameAr: "سلوان", regionCode: "02", lat: 35.0728, lng: -2.9417, major: false, population: 29628, aliases: ["Slouane", "Slwan", "Sélouane"] },
  { slug: "fes", nameFr: "Fès", nameAr: "فاس", regionCode: "03", lat: 34.0433, lng: -5.0033, major: true, population: 1167842 },
  { slug: "meknes", nameFr: "Meknès", nameAr: "مكناس", regionCode: "03", lat: 33.8833, lng: -5.55, major: true, population: 551503 },
  { slug: "taza", nameFr: "Taza", nameAr: "تازة", regionCode: "03", lat: 34.2144, lng: -4.0088, major: true, population: 150763 },
  { slug: "sefrou", nameFr: "Sefrou", nameAr: "صفرو", regionCode: "03", lat: 33.83, lng: -4.83, major: false, population: 86903 },
  { slug: "ifrane", nameFr: "Ifrane", nameAr: "إفران", regionCode: "03", lat: 33.5333, lng: -5.1167, major: false, population: 13558 },
  { slug: "azrou", nameFr: "Azrou", nameAr: "أزرو", regionCode: "03", lat: 33.4362, lng: -5.2218, major: false, population: 57657 },
  { slug: "el-hajeb", nameFr: "El Hajeb", nameAr: "الحاجب", regionCode: "03", lat: 33.6928, lng: -5.3711, major: false, population: 41359 },
  { slug: "taounate", nameFr: "Taounate", nameAr: "تاونات", regionCode: "03", lat: 34.5358, lng: -4.64, major: false, population: 39114 },
  { slug: "missour", nameFr: "Missour", nameAr: "ميسور", regionCode: "03", lat: 33.05, lng: -3.9908, major: false, population: 28408 },
  { slug: "moulay-yacoub", nameFr: "Moulay Yacoub", nameAr: "مولاي يعقوب", regionCode: "03", lat: 34.0875, lng: -5.1794, major: false, population: 4545 },
  { slug: "rabat", nameFr: "Rabat", nameAr: "الرباط", regionCode: "04", lat: 34.0211, lng: -6.8414, major: true, population: 515619 },
  { slug: "sale", nameFr: "Salé", nameAr: "سلا", regionCode: "04", lat: 34.05, lng: -6.8167, major: true, population: 945101 },
  { slug: "temara", nameFr: "Témara", nameAr: "تمارة", regionCode: "04", lat: 33.9234, lng: -6.9076, major: true, population: 297098 },
  { slug: "skhirate", nameFr: "Skhirate", nameAr: "الصخيرات", regionCode: "04", lat: 33.85, lng: -7.03, major: false, population: 122705 },
  { slug: "kenitra", nameFr: "Kénitra", nameAr: "القنيطرة", regionCode: "04", lat: 34.25, lng: -6.5833, major: true, population: 507736 },
  { slug: "khemisset", nameFr: "Khémisset", nameAr: "الخميسات", regionCode: "04", lat: 33.81, lng: -6.06, major: false, population: 125834 },
  { slug: "tiflet", nameFr: "Tiflet", nameAr: "تيفلت", regionCode: "04", lat: 33.9, lng: -6.33, major: false, population: 103850 },
  { slug: "sidi-kacem", nameFr: "Sidi Kacem", nameAr: "سيدي قاسم", regionCode: "04", lat: 34.2267, lng: -5.7167, major: false, population: 75037 },
  { slug: "sidi-slimane", nameFr: "Sidi Slimane", nameAr: "سيدي سليمان", regionCode: "04", lat: 34.26, lng: -5.93, major: false, population: 95114 },
  { slug: "sidi-yahya-el-gharb", nameFr: "Sidi Yahya El Gharb", nameAr: "سيدي يحيى الغرب", regionCode: "04", lat: 34.3058, lng: -6.3058, major: false, population: 39946 },
  { slug: "beni-mellal", nameFr: "Béni Mellal", nameAr: "بني ملال", regionCode: "05", lat: 32.3394, lng: -6.3608, major: true, population: 209594 },
  { slug: "khouribga", nameFr: "Khouribga", nameAr: "خريبكة", regionCode: "05", lat: 32.88, lng: -6.9, major: true, population: 191807 },
  { slug: "khenifra", nameFr: "Khénifra", nameAr: "خنيفرة", regionCode: "05", lat: 32.93, lng: -5.66, major: false, population: 123738 },
  { slug: "fquih-ben-salah", nameFr: "Fquih Ben Salah", nameAr: "الفقيه بن صالح", regionCode: "05", lat: 32.5071, lng: -6.6886, major: false, population: 97380 },
  { slug: "kasba-tadla", nameFr: "Kasba Tadla", nameAr: "قصبة تادلة", regionCode: "05", lat: 32.6, lng: -6.26, major: false, population: 48172 },
  { slug: "azilal", nameFr: "Azilal", nameAr: "أزيلال", regionCode: "05", lat: 31.96, lng: -6.56, major: false, population: 48138 },
  { slug: "oued-zem", nameFr: "Oued Zem", nameAr: "وادي زم", regionCode: "05", lat: 32.8619, lng: -6.5711, major: false, population: 93776 },
  { slug: "souk-sebt-oulad-nemma", nameFr: "Souk Sebt Oulad Nemma", nameAr: "سوق السبت أولاد النمة", regionCode: "05", lat: 32.2948, lng: -6.7007, major: false, population: 60293 },
  { slug: "casablanca", nameFr: "Casablanca", nameAr: "الدار البيضاء", regionCode: "06", lat: 33.5992, lng: -7.62, major: true, population: 3215935 },
  { slug: "mohammedia", nameFr: "Mohammédia", nameAr: "المحمدية", regionCode: "06", lat: 33.6833, lng: -7.3833, major: true, population: 194358 },
  { slug: "el-jadida", nameFr: "El Jadida", nameAr: "الجديدة", regionCode: "06", lat: 33.2342, lng: -8.5228, major: true, population: 235681 },
  { slug: "settat", nameFr: "Settat", nameAr: "سطات", regionCode: "06", lat: 33.0023, lng: -7.6198, major: true, population: 171556 },
  { slug: "berrechid", nameFr: "Berrechid", nameAr: "برشيد", regionCode: "06", lat: 33.27, lng: -7.5872, major: true, population: 168687 },
  { slug: "benslimane", nameFr: "Benslimane", nameAr: "بن سليمان", regionCode: "06", lat: 33.6122, lng: -7.1211, major: false, population: 67317 },
  { slug: "bouskoura", nameFr: "Bouskoura", nameAr: "بوسكورة", regionCode: "06", lat: 33.4489, lng: -7.6486, major: false, population: 200359 },
  { slug: "nouaceur", nameFr: "Nouaceur", nameAr: "النواصر", regionCode: "06", lat: 33.3611, lng: -7.6114, major: false, population: 36326 },
  { slug: "dar-bouazza", nameFr: "Dar Bouazza", nameAr: "دار بوعزة", regionCode: "06", lat: 33.5217, lng: -7.8164, major: false, population: 302970 },
  { slug: "mediouna", nameFr: "Médiouna", nameAr: "مديونة", regionCode: "06", lat: 33.4556, lng: -7.5208, major: false, population: 29972 },
  { slug: "sidi-bennour", nameFr: "Sidi Bennour", nameAr: "سيدي بنور", regionCode: "06", lat: 32.655, lng: -8.4292, major: false, population: 56201 },
  { slug: "azemmour", nameFr: "Azemmour", nameAr: "أزمور", regionCode: "06", lat: 33.2833, lng: -8.3333, major: false, population: 42098 },
  { slug: "marrakech", nameFr: "Marrakech", nameAr: "مراكش", regionCode: "07", lat: 31.6295, lng: -7.9811, major: true, population: 1002697 },
  { slug: "safi", nameFr: "Safi", nameAr: "آسفي", regionCode: "07", lat: 32.2833, lng: -9.2333, major: true, population: 367249 },
  { slug: "essaouira", nameFr: "Essaouira", nameAr: "الصويرة", regionCode: "07", lat: 31.513, lng: -9.7687, major: false, population: 82962 },
  { slug: "el-kelaa-des-sraghna", nameFr: "El Kelâa des Sraghna", nameAr: "قلعة السراغنة", regionCode: "07", lat: 32.05, lng: -7.4, major: false, population: 106418 },
  { slug: "ben-guerir", nameFr: "Ben Guerir", nameAr: "ابن جرير", regionCode: "07", lat: 32.23, lng: -7.95, major: false, population: 114872 },
  { slug: "youssoufia", nameFr: "Youssoufia", nameAr: "اليوسفية", regionCode: "07", lat: 32.25, lng: -8.53, major: false, population: 65669 },
  { slug: "chichaoua", nameFr: "Chichaoua", nameAr: "شيشاوة", regionCode: "07", lat: 31.5333, lng: -8.7667, major: false, population: 38452 },
  { slug: "tahannaout", nameFr: "Tahannaout", nameAr: "تحناوت", regionCode: "07", lat: 31.3514, lng: -7.9508, major: false, population: 16236 },
  { slug: "amizmiz", nameFr: "Amizmiz", nameAr: "أمزميز", regionCode: "07", lat: 31.21, lng: -8.25, major: false, population: 13840 },
  { slug: "errachidia", nameFr: "Errachidia", nameAr: "الرشيدية", regionCode: "08", lat: 31.9319, lng: -4.4244, major: true, population: 97687 },
  { slug: "ouarzazate", nameFr: "Ouarzazate", nameAr: "ورزازات", regionCode: "08", lat: 30.9167, lng: -6.9167, major: false, population: 79218 },
  { slug: "midelt", nameFr: "Midelt", nameAr: "ميدلت", regionCode: "08", lat: 32.68, lng: -4.74, major: false, population: 62648 },
  { slug: "tinghir", nameFr: "Tinghir", nameAr: "تنغير", regionCode: "08", lat: 31.5147, lng: -5.5328, major: false, population: 44239 },
  { slug: "zagora", nameFr: "Zagora", nameAr: "زاكورة", regionCode: "08", lat: 30.3316, lng: -5.8376, major: false, population: 42294 },
  { slug: "erfoud", nameFr: "Erfoud", nameAr: "أرفود", regionCode: "08", lat: 31.4361, lng: -4.2328, major: false, population: 28912 },
  { slug: "rissani", nameFr: "Rissani", nameAr: "الريصاني", regionCode: "08", lat: 31.2842, lng: -4.2642, major: false, population: 4353 },
  { slug: "kelaat-mgouna", nameFr: "Kelâat M'Gouna", nameAr: "قلعة مكونة", regionCode: "08", lat: 31.2414, lng: -6.1283, major: false, population: 17737 },
  { slug: "agadir", nameFr: "Agadir", nameAr: "أكادير", regionCode: "09", lat: 30.4214, lng: -9.5831, major: true, population: 504768 },
  { slug: "inezgane", nameFr: "Inezgane", nameAr: "إنزكان", regionCode: "09", lat: 30.3492, lng: -9.5528, major: false, population: 137512 },
  { slug: "ait-melloul", nameFr: "Aït Melloul", nameAr: "أيت ملول", regionCode: "09", lat: 30.3342, lng: -9.4972, major: true, population: 210870 },
  { slug: "taroudant", nameFr: "Taroudant", nameAr: "تارودانت", regionCode: "09", lat: 30.4711, lng: -8.8778, major: false, population: 83496 },
  { slug: "tiznit", nameFr: "Tiznit", nameAr: "تزنيت", regionCode: "09", lat: 29.7, lng: -9.7269, major: true, population: 196348 },
  { slug: "biougra", nameFr: "Biougra", nameAr: "بيوكرة", regionCode: "09", lat: 30.2144, lng: -9.3708, major: false, population: 50626 },
  { slug: "oulad-teima", nameFr: "Oulad Teïma", nameAr: "أولاد تايمة", regionCode: "09", lat: 30.4, lng: -9.21, major: false, population: 100284 },
  { slug: "taghazout", nameFr: "Taghazout", nameAr: "تغازوت", regionCode: "09", lat: 30.5448, lng: -9.7092, major: false, population: 4861 },
  { slug: "tata", nameFr: "Tata", nameAr: "طاطا", regionCode: "09", lat: 29.7428, lng: -7.9725, major: false, population: 19544 },
  { slug: "guelmim", nameFr: "Guelmim", nameAr: "كلميم", regionCode: "10", lat: 28.9833, lng: -10.0667, major: true, population: 126729 },
  { slug: "tan-tan", nameFr: "Tan-Tan", nameAr: "طانطان", regionCode: "10", lat: 28.4333, lng: -11.1, major: false, population: 76134 },
  { slug: "sidi-ifni", nameFr: "Sidi Ifni", nameAr: "سيدي إفني", regionCode: "10", lat: 29.3798, lng: -10.173, major: false, population: 22696 },
  { slug: "assa", nameFr: "Assa", nameAr: "آسا", regionCode: "10", lat: 28.6086, lng: -9.4269, major: false, population: 15601 },
  { slug: "laayoune", nameFr: "Laâyoune", nameAr: "العيون", regionCode: "11", lat: 27.15, lng: -13.2, major: true, population: 262791 },
  { slug: "boujdour", nameFr: "Boujdour", nameAr: "بوجدور", regionCode: "11", lat: 26.1333, lng: -14.4667, major: false, population: 57360 },
  { slug: "es-semara", nameFr: "Es-Semara", nameAr: "السمارة", regionCode: "11", lat: 26.7394, lng: -11.6703, major: false, population: 56607 },
  { slug: "tarfaya", nameFr: "Tarfaya", nameAr: "طرفاية", regionCode: "11", lat: 27.9133, lng: -12.9317, major: false, population: 11030 },
  { slug: "el-marsa", nameFr: "El Marsa", nameAr: "المرسى", regionCode: "11", lat: 27.0979, lng: -13.4145, major: false, population: 28848 },
  { slug: "dakhla", nameFr: "Dakhla", nameAr: "الداخلة", regionCode: "12", lat: 23.7167, lng: -15.95, major: true, population: 165463 },
  { slug: "aousserd", nameFr: "Aousserd", nameAr: "أوسرد", regionCode: "12", lat: 22.5364, lng: -14.2858, major: false, population: 3855 },
  { slug: "bir-gandouz", nameFr: "Bir Gandouz", nameAr: "بئر كندوز", regionCode: "12", lat: 21.6157, lng: -16.4687, major: false, population: 9183 },
];
