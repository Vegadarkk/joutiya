// Message risk keywords (architecture §7 step 7, design phase-5 D5). Local rules only, never AI:
// a hit flags the message and shows a warning banner to its recipient; nothing is blocked. Terms
// go through `normalizeText` and the token matcher of src/lib/moderation/keywords.ts (accents and
// apostrophes dropped, "l'avance" matches "avance", Arabic و/ف/ب/ل/ك and ال prefixes folded, a
// Latin plural -s/-x folded). French, Arabic, darija in Arabic script and in arabizi (3 = ع,
// 7 = ح, 9 = ق). Client-safe (no dependency).

/**
 * Advance payment and money transfer vocabulary: the classic scam asks for a deposit or a transfer
 * through a cash network before the buyer sees the item.
 */
export const PAYMENT_KEYWORDS: readonly string[] = [
  // French
  "acompte", "avance", "virement", "mandat", "mandat cash", "western union", "westernunion", "moneygram", "money gram",
  "cash plus", "cashplus", "wafacash", "wafa cash", "barid cash", "baridcash", "damane cash", "chaabi cash", "paypal",
  "transfert d'argent", "envoi d'argent", "frais de dedouanement", "payer avant", "paiement avant",
  // Arabic and darija (Arabic script)
  "تحويل", "حوالة", "عربون", "تسبيق", "دفعة مسبقة", "ويسترن يونيون", "وفاكاش", "وفا كاش", "كاش بلوس", "موني غرام",
  // Darija (arabizi)
  "tsbi9", "tasbi9", "tesbi9", "tsbiq", "tasbiq", "ttsbi9", "3arboun", "3arbon", "3erboun", "l3arboun", "l3arbon", "arboun",
  "7awala", "hawala", "ta7wil", "tahwil", "virma",
];

/**
 * Mentions of an outside messaging app. Alone they are normal (D5: a phone number or WhatsApp is
 * how people meet in Morocco); with a payment keyword they make `contact_with_payment_kw`.
 */
export const CONTACT_APP_KEYWORDS: readonly string[] = [
  "whatsapp", "whatsap", "whats app", "watsap", "watsapp", "wattsap", "wtsp", "telegram", "telegrame", "viber",
  "واتساب", "واتس اب", "واتس", "تيليغرام", "تلغرام", "تليجرام",
];
