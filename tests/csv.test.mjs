import test from "node:test";
import assert from "node:assert/strict";
import { csvCell, csvRow, csvDocument } from "../lib/csv.js";

test("quotes every cell and escapes embedded quotes", () => {
  assert.equal(csvCell("plain"), '"plain"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell("a,b"), '"a,b"');
  assert.equal(csvCell("line1\nline2"), '"line1\nline2"');
});

test("renders empty-ish values without crashing", () => {
  assert.equal(csvCell(null), '""');
  assert.equal(csvCell(undefined), '""');
  assert.equal(csvCell(0), '"0"');
});

test("neutralizes spreadsheet formula injection", () => {
  // A video title or note reaching the export from outside must never become
  // a live formula when the admin opens the CSV.
  for (const payload of ["=1+1", "+1", "-1", "@SUM(A1)", "=HYPERLINK(\"http://evil\")"]) {
    const cell = csvCell(payload);
    assert.ok(cell.startsWith(`"'`), `expected ${payload} to be prefixed as text, got ${cell}`);
  }
});

test("does not mangle ordinary values that merely contain an operator", () => {
  assert.equal(csvCell("a=b"), '"a=b"');
  assert.equal(csvCell("first-last"), '"first-last"');
});

test("rows and documents join correctly", () => {
  assert.equal(csvRow(["a", "b"]), '"a","b"');
  assert.equal(csvDocument([["h1"], ["v1"]]), '"h1"\r\n"v1"');
});
