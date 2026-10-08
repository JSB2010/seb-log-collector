export function csvCell(value: unknown) {
  const s = String(value ?? "");
  return '"' + (/^[=+@\-\t\r]/.test(s) ? "'" + s : s).replace(/"/g, '""') + '"';
}
