export function parseRoster(text: string) {
  if (text.length > 240000)
    throw new Error(
      "CSV is too large. Split into batches of at most 400 devices.",
    );
  const rows: string[][] = [];
  let row: string[] = [],
    cell = "",
    quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else quoted = !quoted;
    } else if (c === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((c === "\n" || c === "\r") && !quoted) {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      if (row.some(Boolean)) rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (quoted) throw new Error("Unclosed CSV quote.");
  row.push(cell);
  if (row.some(Boolean)) rows.push(row);
  const headers =
    rows.shift()?.map((s) =>
      s
        .trim()
        .replace(/^\uFEFF/, "")
        .toLowerCase(),
    ) ?? [];
  if (!headers.includes("serial"))
    throw new Error(
      "CSV must have a serial column. Optional columns: assignedLabel, schoolEmail, jamfId.",
    );
  if (!rows.length || rows.length > 400)
    throw new Error("Use 1 to 400 devices per batch.");
  return rows.map((r) =>
    Object.fromEntries(
      ["serial", "assignedLabel", "schoolEmail", "jamfId"].map((k) => [
        k,
        r[headers.indexOf(k.toLowerCase())]?.trim() ?? "",
      ]),
    ),
  );
}
export function csvCell(value: unknown) {
  const s = String(value ?? "");
  return '"' + (/^[=+@\-\t\r]/.test(s) ? "'" + s : s).replace(/"/g, '""') + '"';
}
