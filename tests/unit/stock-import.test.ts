import { describe, expect, it } from "vitest";
import { CsvError, csvLine, guessSeparator, neutralizeFormula, parseCsv } from "@/lib/pro/stock-import/csv";
import { diffFields, planImport, type StockEntry } from "@/lib/pro/stock-import/plan";
import { dayNumber } from "@/lib/listings/rental-availability";
import { mapColumns, parseInteger, parsePeriods, parseRows, type ParsedRow } from "@/lib/pro/stock-import/rows";
import { stockTemplateCsv } from "@/lib/pro/stock-import/template";
import { matchPhotos, photoNameParts } from "@/lib/pro/stock-import/photos";

// Stock import of the Concession pack (design concession/concession.md §4): the CSV reader, the
// line parser and the import plan, all pure.

const HEADER = "reference;categorie;titre;description;prix;ville;marque;modele;annee;kilometrage;carburant;boite";
const DESCRIPTION = "Dacia Duster entretenu chez le concessionnaire, carnet complet, deux clés, pneus neufs.";
const LINE = `DUS-041;Voitures;Dacia Duster 1.5 dCi;${DESCRIPTION};185 000;Casablanca;Dacia;Duster;2022;41 000 km;Diesel;Manuelle`;

const rowsOf = (text: string) => parseRows(parseCsv(text, 300), { pro: true });
const codes = (row: ParsedRow) => row.issues.map((issue) => issue.code);

describe("parseCsv", () => {
  it("reads quotes, separators inside quotes, CRLF, a byte order mark and skips blank lines", () => {
    const table = parseCsv('﻿a;b;c\r\n1;"x;y";"say ""hi"""\r\n\r\n2;"multi\nline";3\n', 10);
    expect(table.separator).toBe(";");
    expect(table.header).toEqual(["a", "b", "c"]);
    expect(table.records).toEqual([
      { line: 2, cells: ["1", "x;y", 'say "hi"'] },
      { line: 4, cells: ["2", "multi\nline", "3"] },
    ]);
  });

  it("guesses the separator from the header", () => {
    expect(guessSeparator("a,b,c\n1;2;3")).toBe(",");
    expect(guessSeparator("a;b,c;d")).toBe(";");
    expect(guessSeparator("a\tb\tc")).toBe("\t");
    expect(guessSeparator('"a;b",c,d')).toBe(",");
  });

  it("refuses an empty file, an unclosed quote and too many lines", () => {
    const error = (text: string, max = 10) => {
      try {
        parseCsv(text, max);
      } catch (caught) {
        return caught instanceof CsvError ? { code: caught.code, line: caught.line } : caught;
      }
      return null;
    };
    expect(error("")).toEqual({ code: "empty", line: 1 });
    expect(error("a;b\n")).toEqual({ code: "empty", line: 1 });
    expect(error('a;b\n1;"open\n2;3')).toEqual({ code: "unclosed_quote", line: 2 });
    expect(error("a\n1\n2\n3", 2)).toEqual({ code: "too_many_rows", line: 4 });
  });

  it("neutralizes spreadsheet formulas only when writing", () => {
    expect(neutralizeFormula("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(neutralizeFormula("-5")).toBe("'-5");
    expect(neutralizeFormula("Duster")).toBe("Duster");
    expect(csvLine(["=1+1", 'a "b"', "c;d", "e"])).toBe(`'=1+1;"a ""b""";"c;d";e`);
    // Reading keeps what the dealer wrote.
    expect(parseCsv("a\n=1+1", 10).records[0]!.cells).toEqual(["=1+1"]);
  });
});

describe("parseRows", () => {
  it("maps French headers, labels and spellings to the listing fields", () => {
    const { rows, ignoredColumns } = rowsOf(`${HEADER};Couleur préférée\n${LINE};bleu`);
    expect(ignoredColumns).toEqual(["Couleur préférée"]);
    const [row] = rows;
    expect(row!.issues).toEqual([]);
    expect(row!.subcategoryId).toBe("voitures");
    expect(row!.fields).toEqual({
      title: "Dacia Duster 1.5 dCi",
      description: DESCRIPTION,
      price: 185000,
      priceNegotiable: false,
      condition: null,
      attributes: { "stock-ref": "DUS-041", "car-brand": "dacia", model: "Duster", year: 2022, mileage: 41000, fuel: "diesel", gearbox: "manuelle" },
      location: { regionCode: expect.any(String), citySlug: "casablanca" },
    });
  });

  it("reads criterion ids, Arabic labels, booleans and multiple choices", () => {
    const { rows } = rowsOf(
      "reference,car-brand,model,year,mileage,fuel,gearbox,ville,prix,vehicle-warranty,warranty-months,trade-in,car-equipment\n" + "R1,dacia,Logan,2020,90000,essence,automatique,rabat,99000,constructeur,24,oui,gps | camera-recul",
    );
    expect(rows[0]!.fields.attributes).toMatchObject({ "vehicle-warranty": "constructeur", "warranty-months": 24, "trade-in": true, "car-equipment": ["gps", "camera-recul"] });
    expect(codes(rows[0]!)).toEqual(["title_generated", "description_short"]);
    expect(rows[0]!.fields.title).toContain("Logan");
  });

  it("reports each problem by column, keeping warnings apart", () => {
    const { rows } = rowsOf(`${HEADER}\n;Voitures;T;court;abc;Atlantis;Dacia;Duster;2022;41000;Charbon;Manuelle\nok;Bateaux;Bateau;${DESCRIPTION};1000;Rabat;;;;;;`);
    expect(codes(rows[0]!)).toEqual(expect.arrayContaining(["ref_required", "value_unknown", "required", "description_short", "price_invalid", "city_unknown"]));
    expect(rows[0]!.issues.find((issue) => issue.code === "value_unknown")).toMatchObject({ column: "carburant", value: "Charbon" });
    // Only subcategories with a stock reference import (vehicles).
    expect(codes(rows[1]!)).toContain("category_unknown");
  });

  it("drops a dependent criterion the line does not open", () => {
    const { rows } = rowsOf(`${HEADER};garantie;duree garantie\n${LINE};aucune;12`);
    expect(rows[0]!.fields.attributes["warranty-months"]).toBeUndefined();
    expect(codes(rows[0]!)).toEqual(["column_ignored"]);
  });

  it("parses the usual number spellings", () => {
    expect(parseInteger("41 000")).toBe(41000);
    expect(parseInteger("41.000 km")).toBe(41000);
    expect(parseInteger("185 000,00 MAD")).toBe(185000);
    expect(parseInteger("deux")).toBeUndefined();
  });

  it("ignores a column mapped twice", () => {
    expect(mapColumns(["reference", "ref", "prix"]).ignored).toEqual(["ref"]);
  });
});

function entry(row: ParsedRow, overrides: Partial<StockEntry> = {}): StockEntry {
  return { id: `id-${row.ref}`, ref: row.ref, title: row.fields.title, status: "published", photoCount: 3, slugId: `slug-${row.ref}`, subcategoryId: row.subcategoryId, fields: structuredClone(row.fields), ...overrides };
}

describe("planImport", () => {
  const second = LINE.replace("DUS-041", "DUS-042").replace("185 000", "175 000");

  it("creates new references, updates changed ones, skips identical ones", () => {
    const { rows } = rowsOf(`${HEADER}\n${LINE}\n${second}`);
    const stock = [entry(rows[0]!), entry(rows[1]!, { fields: { ...structuredClone(rows[1]!.fields), price: 180000 } })];
    const fresh = rowsOf(`${HEADER}\n${LINE}\n${second}\n${LINE.replace("DUS-041", "DUS-043")}`).rows;
    const plan = planImport(fresh, stock, 10);
    expect(plan.results.map((result) => result.action)).toEqual(["unchanged", "update", "create"]);
    expect(plan.updates[0]).toMatchObject({ listingId: "id-DUS-042", patch: { price: 175000 } });
    expect(plan.results[1]!.changes).toEqual(["price"]);
    expect(plan.creates.map((row) => row.ref)).toEqual(["DUS-043"]);
    expect(plan.absent).toEqual([]);
  });

  it("refuses duplicates, locked listings and lines over the quota, and lists absent references", () => {
    const { rows } = rowsOf(`${HEADER}\n${LINE}\n${second}`);
    const sold = entry(rows[0]!, { status: "sold" });
    const away = entry(rowsOf(`${HEADER}\n${LINE.replace("DUS-041", "OLD-1")}`).rows[0]!);
    const fresh = rowsOf(`${HEADER}\n${LINE}\n${second}\n${second.replace("DUS-042", "dus-042")}\n${LINE.replace("DUS-041", "NEW-2")}`).rows;
    const plan = planImport(fresh, [sold, away], 1);
    expect(plan.results.map((result) => [result.action, result.issues.map((issue) => issue.code)])).toEqual([
      ["error", ["status_locked"]],
      ["create", []],
      ["error", ["ref_duplicate"]],
      ["error", ["quota"]],
    ]);
    expect(plan.absent.map((listing) => listing.ref)).toEqual(["OLD-1"]);
  });

  it("keeps what the site holds when the file leaves it out", () => {
    const { rows } = rowsOf(`reference;marque;modele;annee;kilometrage;carburant;boite;ville;prix\nDUS-041;Dacia;Duster;2022;45000;Diesel;Manuelle;Casablanca;185000`);
    const site = entry(rows[0]!, {
      title: "Duster du showroom",
      fields: { ...structuredClone(rows[0]!.fields), title: "Duster du showroom", description: DESCRIPTION, attributes: { ...rows[0]!.fields.attributes, mileage: 41000, "car-equipment": ["gps"] } },
    });
    const { patch, changes } = diffFields(rows[0]!, site);
    // No title column (generated title) and no description: the site's stay.
    expect(changes).toEqual(["attributes"]);
    expect(patch.attributes).toMatchObject({ mileage: 45000, "car-equipment": ["gps"] });
  });
});

describe("stock template", () => {
  it("parses back without a single issue, every column mapped", () => {
    const { rows, ignoredColumns } = rowsOf(stockTemplateCsv());
    expect(ignoredColumns).toEqual([]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.issues).toEqual([]);
    expect(rows[0]!.fields.attributes).toMatchObject({
      "stock-ref": "DUS-041",
      "body-type": "suv-4x4",
      "vehicle-papers": ["carte-grise", "visite-technique", "libre-de-gage"],
      "vehicle-warranty": "vendeur",
      "warranty-months": 6,
      "car-equipment": ["climatisation", "gps", "camera-recul", "carplay-android-auto"],
    });
    expect(rows[0]!.fields.location).toMatchObject({ citySlug: "casablanca", district: "Aïn Sebaâ" });
  });
});

describe("car rental fleet lines", () => {
  const TODAY = dayNumber("2026-10-28");
  const fleetOf = (text: string) => parseRows(parseCsv(text, 300), { pro: true, today: TODAY });

  it("parses the rental template: terms, the mileage policy and the blocked periods", () => {
    const { rows, ignoredColumns } = fleetOf(stockTemplateCsv("rental"));
    expect(ignoredColumns).toEqual([]);
    expect(rows[0]!.issues).toEqual([]);
    expect(rows[0]!.subcategoryId).toBe("location-voitures");
    expect(rows[0]!.fields.attributes).toMatchObject({
      "stock-ref": "LOG-01",
      "rental-class": "berline",
      "mileage-policy": "illimite",
      "rental-insurance": "tous-risques-franchise",
      "insurance-excess": 5000,
      "vehicle-handover": ["agence", "aeroport"],
      "rate-7-days": 260,
      "fleet-units": 3,
    });
    expect(rows[0]!.fields.unavailable).toEqual([{ from: "2026-12-20", to: "2027-01-03" }]);
  });

  it("reads periods and single days, merges them and drops the past", () => {
    expect(parsePeriods("2026-11-02/2026-11-05; 2026-11-06, 2026-12-24 au 2026-12-26", TODAY)).toEqual([
      { from: "2026-11-02", to: "2026-11-06" },
      { from: "2026-12-24", to: "2026-12-26" },
    ]);
    expect(parsePeriods("2026-10-20/2026-10-29", TODAY)).toEqual([{ from: "2026-10-28", to: "2026-10-29" }]);
    expect(parsePeriods("aucune", TODAY)).toEqual([]);
    expect(parsePeriods("02/11/2026", TODAY)).toBeUndefined();
    expect(parsePeriods("2026-11-05/2026-11-02", TODAY)).toBeUndefined();
    expect(parsePeriods("2028-01-01", TODAY)).toBeUndefined();
  });

  it("refuses unreadable periods and ignores them outside car rentals", () => {
    const header = "reference;categorie;titre;description;prix;ville;gamme;marque;modele;boite;carburant;indisponible";
    const rental = `LOG-02;Location de voitures;Clio 5 essence;${DESCRIPTION};250;Rabat;Citadine;Renault;Clio;Manuelle;Essence`;
    const [bad] = fleetOf(`${header}\n${rental};du 2 au 5 novembre`).rows;
    expect(codes(bad!)).toEqual(["periods_invalid"]);
    const [sale] = fleetOf(`${HEADER};indisponible\n${LINE};2026-11-02`).rows;
    expect(codes(sale!)).toEqual(["periods_ignored"]);
    expect(sale!.fields.unavailable).toBeUndefined();
  });

  it("plans a change of periods alone as an update, and the same periods as unchanged", () => {
    const [row] = fleetOf(stockTemplateCsv("rental")).rows;
    const same = entry(row!, { subcategoryId: "location-voitures", fields: { ...row!.fields } });
    expect(planImport([row!], [same], 10).results[0]!.action).toBe("unchanged");
    const before = entry(row!, { subcategoryId: "location-voitures", fields: { ...row!.fields, unavailable: [] } });
    const plan = planImport([row!], [before], 10);
    expect(plan.results[0]).toMatchObject({ action: "update", changes: ["unavailable"] });
    expect(plan.updates[0]).toMatchObject({ patch: {}, unavailable: [{ from: "2026-12-20", to: "2027-01-03" }] });
    // A file without the column leaves the periods as they are.
    const { unavailable: _ignored, ...withoutPeriods } = row!.fields;
    expect(diffFields({ ...row!, fields: withoutPeriods }, before).changes).toEqual([]);
  });
});

describe("matchPhotos", () => {
  const stock = [
    { id: "a", ref: "DUS-041" },
    { id: "b", ref: "CLIO5" },
  ];

  it("files each photo under its reference, ordered by number", () => {
    const files = ["dus-041-2.jpg", "DUS-041.jpg", "DUS-041_10.JPEG", "DUS-041 (3).png", "CLIO5-1.webp", "vacances.jpg", "DUS-04.jpg"].map((name) => ({ name }));
    const { byListing, unmatched } = matchPhotos(files, stock);
    expect(byListing.get("a")!.map((file) => file.name)).toEqual(["DUS-041.jpg", "dus-041-2.jpg", "DUS-041 (3).png", "DUS-041_10.JPEG"]);
    expect(byListing.get("b")!.map((file) => file.name)).toEqual(["CLIO5-1.webp"]);
    expect(unmatched.map((file) => file.name)).toEqual(["vacances.jpg", "DUS-04.jpg"]);
  });

  it("reads the reference and position of a name", () => {
    expect(photoNameParts("DUS-041-2.jpg")).toEqual({ base: "DUS-041", position: 2 });
    expect(photoNameParts("DUS-041.jpg")).toEqual({ base: "DUS-041", position: 0 });
    expect(photoNameParts("R1 (4).png")).toEqual({ base: "R1", position: 4 });
  });
});

describe("shop lines: variants and stock (catalogue §2)", () => {
  const SHOP = "reference;categorie;titre;description;prix;etat;ville;pour qui;type de vetement;variante_1;variante_2;stock";
  const SHIRT = "Chemise en lin lavé, broderie faite main dans notre atelier de Fès, coupe droite.";
  const first = `CHM-LIN;Vêtements;Chemise en lin brodée main;${SHIRT};250;Neuf avec étiquette;Fès;Homme;Haut & t-shirt;Taille : M;Couleur : Bleu;4`;

  it("reads the shop template as one shirt in sizes and colours, with its stock and a price of its own", () => {
    const { rows, ignoredColumns } = rowsOf(stockTemplateCsv("shop"));
    expect(ignoredColumns).toEqual([]);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row!.issues).toEqual([]);
    expect(row!.subcategoryId).toBe("vetements");
    // The size axis takes over the size criterion; the reference is the listing's.
    expect(row!.fields.attributes).toEqual({ "stock-ref": "CHM-LIN", audience: "homme", "clothing-type": "haut" });
    expect(row!.fields.variants).toEqual({
      axes: [
        { id: "clothing-size", values: ["m", "l", "xl"] },
        { id: "color", values: ["bleu", "noir"] },
      ],
      items: [
        { key: "m|bleu", stock: 4 },
        { key: "l|bleu", stock: 2 },
        { key: "xl|noir", stock: 0, price: 290 },
      ],
    });
  });

  it("takes a free axis as written, and a stock alone without variants", () => {
    const honey = "reference;categorie;titre;description;prix;ville;numero onssa;type de miel;variante_1;stock";
    const text = `${honey}\nMIEL-T;Miel;Miel de thym d'Imouzzer;Miel de thym récolté à Imouzzer, extraction à froid, pot en verre.;120;Fès;ONSSA-12345;Thym;Contenance : 500 g;10\nmiel-t;;;;220;;;;Contenance : 1 kg;\nAML-1;Amlou & pâtes à tartiner;Amlou maison;Amlou aux amandes grillées et huile d'argan, préparé chaque semaine.;90;Fès;ONSSA-12345;;;7`;
    const { rows } = rowsOf(text);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.fields.variants).toEqual({ axes: [{ id: "free-1", label: "Contenance", values: ["500 g", "1 kg"] }], items: [{ key: "500 g", stock: 10 }, { key: "1 kg", price: 220 }] });
    expect(rows[1]!.fields.stock).toBe(7);
    expect(rows[1]!.fields.variants).toBeUndefined();
  });

  it("refuses an unreadable cell, other axes, a repeated combination and a bad stock, with their lines", () => {
    const text = [SHOP, first, "CHM-LIN;;;;;;;;;Taille : M;Couleur : Bleu;2", "CHM-LIN;;;;;;;;;Couleur : Noir;;1", "CHM-LIN;;;;;;;;;Taille M;Couleur : Noir;1", "CHM-LIN;;;;;;;;;Taille : L;Couleur : Noir;beaucoup"].join("\n");
    const [row] = rowsOf(text).rows;
    expect(row!.fields.variants).toBeUndefined();
    expect(row!.issues).toEqual(
      expect.arrayContaining([
        { column: "variante_1", code: "variant_duplicate", value: "m / bleu", line: 3 },
        { column: "variante_1", code: "variant_axes", line: 4 },
        { column: "variante_1", code: "variant_invalid", value: "Taille M", line: 5 },
        { column: "stock", code: "stock_invalid", value: "beaucoup", line: 6 },
      ]),
    );
  });

  it("updates the variants it changes and keeps the references set on the site", () => {
    const [row] = rowsOf([SHOP, first, "CHM-LIN;;;;;;;;;Taille : L;Couleur : Bleu;0"].join("\n")).rows;
    const entry: Pick<StockEntry, "subcategoryId" | "fields"> = {
      subcategoryId: "vetements",
      fields: {
        ...row!.fields,
        variants: { axes: [{ id: "clothing-size", values: ["m", "l"] }, { id: "color", values: ["bleu"] }], items: [{ key: "m|bleu", stock: 4, ref: "CHM-M-B" }, { key: "l|bleu", stock: 2 }] },
      },
    };
    const { patch, changes } = diffFields(row!, entry);
    expect(changes).toEqual(["variants"]);
    expect(patch.variants?.items).toEqual([{ key: "m|bleu", stock: 4, ref: "CHM-M-B" }, { key: "l|bleu", stock: 0 }]);
    expect(diffFields(rowsOf([SHOP, first, "CHM-LIN;;;;;;;;;Taille : L;Couleur : Bleu;2"].join("\n")).rows[0]!, entry).changes).toEqual([]);
  });
});
