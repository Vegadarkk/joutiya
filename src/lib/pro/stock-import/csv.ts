// CSV reader of the stock import (design concession/concession.md §4), pure: RFC 4180 quoting
// (doubled quotes, separators and line breaks inside quotes), a UTF-8 byte order mark dropped,
// CRLF or LF, and the separator guessed from the header (`;` as spreadsheets write it in French
// locales, `,` otherwise, or a tab). Blank lines are skipped; each record keeps its 1-based line
// in the file so errors point at what the dealer sees in their spreadsheet.

export interface CsvRecord {
  line: number;
  cells: string[];
}

export interface CsvTable {
  separator: "," | ";" | "\t";
  header: string[];
  records: CsvRecord[];
}

export class CsvError extends Error {
  constructor(
    readonly code: "empty" | "unclosed_quote" | "too_many_rows",
    readonly line: number,
  ) {
    super(`${code} at line ${line}`);
  }
}

/** The separator the header line uses most, outside quotes. */
export function guessSeparator(text: string): "," | ";" | "\t" {
  const end = text.search(/\r?\n/);
  const first = end === -1 ? text : text.slice(0, end);
  const counts = { ",": 0, ";": 0, "\t": 0 };
  let quoted = false;
  for (const char of first) {
    if (char === '"') quoted = !quoted;
    else if (!quoted && char in counts) counts[char as keyof typeof counts] += 1;
  }
  if (counts[";"] >= counts[","] && counts[";"] >= counts["\t"] && counts[";"] > 0) return ";";
  if (counts["\t"] > counts[","]) return "\t";
  return ",";
}

/** Parses the whole text; throws `CsvError` on an unclosed quote, an empty file or more than `maxRows` data lines. */
export function parseCsv(input: string, maxRows: number): CsvTable {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const separator = guessSeparator(text);
  const rows: CsvRecord[] = [];
  let cells: string[] = [];
  let cell = "";
  let quoted = false;
  let line = 1;
  let rowLine = 1;
  let quoteLine = 1;

  const endRow = () => {
    cells.push(cell);
    // A blank line (one empty cell) is no record.
    if (!(cells.length === 1 && cells[0]!.trim() === "")) {
      rows.push({ line: rowLine, cells });
      if (rows.length > maxRows + 1) throw new CsvError("too_many_rows", rowLine);
    }
    cells = [];
    cell = "";
  };

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else quoted = false;
      } else {
        if (char === "\n") line += 1;
        cell += char;
      }
      continue;
    }
    if (char === '"' && cell.trim() === "") {
      quoted = true;
      quoteLine = line;
      cell = "";
    } else if (char === separator) {
      cells.push(cell);
      cell = "";
    } else if (char === "\r" && text[i + 1] === "\n") {
      continue;
    } else if (char === "\n" || char === "\r") {
      endRow();
      line += 1;
      rowLine = line;
    } else {
      cell += char;
    }
  }
  if (quoted) throw new CsvError("unclosed_quote", quoteLine);
  if (cell !== "" || cells.length > 0) endRow();

  const [header, ...records] = rows;
  if (!header || records.length === 0) throw new CsvError("empty", 1);
  return { separator, header: header.cells.map((name) => name.trim()), records };
}

/**
 * A cell a spreadsheet would run as a formula (`=`, `+`, `-`, `@`, tab or carriage return first)
 * is prefixed with an apostrophe when the site writes a CSV (the template), never on reading.
 */
export function neutralizeFormula(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

/** One CSV line, quoted where needed, formulas neutralized. */
export function csvLine(values: readonly string[], separator: "," | ";" = ";"): string {
  return values
    .map((raw) => {
      const value = neutralizeFormula(raw);
      return /["\n\r,;]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
    })
    .join(separator);
}
