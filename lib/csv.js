// CSV serialisation for the admin export.
//
// Two separate concerns, deliberately handled in one place:
//
//  1. CSV QUOTING — wrap in double quotes and double any embedded quote, so
//     commas, quotes and newlines in a video title can't shift columns.
//  2. FORMULA INJECTION — a spreadsheet treats a cell starting with =, +, -,
//     @, tab or CR as a formula. Video titles and recipient emails reach
//     this file from outside (Bunny library metadata, admin-typed input), so
//     a title like `=HYPERLINK("http://evil","click")` would become a live
//     formula in Excel or Sheets the moment the admin opens the export. We
//     prefix those cells with a single quote, the standard "treat as text"
//     marker, BEFORE quoting.
const FORMULA_PREFIX = /^[=+\-@\t\r]/;

export function csvCell(value) {
  if (value === null || value === undefined) return '""';
  let text = String(value);
  if (FORMULA_PREFIX.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export function csvRow(values) {
  return values.map(csvCell).join(",");
}

// Joins with CRLF, which is what RFC 4180 specifies and what Excel expects.
export function csvDocument(rows) {
  return rows.map(csvRow).join("\r\n");
}
