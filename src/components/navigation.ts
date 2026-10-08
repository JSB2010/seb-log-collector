export const views = [
  ["fleet", "Fleet"],
  ["logs", "Log catalog"],
  ["enrollment", "Enrollment"],
  ["requests", "Requests"],
  ["audit", "Audit"],
  ["admins", "Admins"],
] as const;
export type View = (typeof views)[number][0];
export function viewFromPath(path: string): View {
  return views.find(([v]) => path === `/${v}`)?.[0] ?? "fleet";
}
export function safeReturnTo(value: unknown) {
  if (
    typeof value !== "string" ||
    value.length > 2048 ||
    /[\x00-\x1f\x7f]/.test(value) ||
    !/^\/(fleet|logs|enrollment|requests|audit|admins)(\?|$)/.test(value)
  )
    return "/fleet";
  return value;
}
