export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    public details?: unknown,
  ) {
    super(code);
  }
}
export function requireThat(
  ok: unknown,
  status: number,
  code: string,
): asserts ok {
  if (!ok) throw new ApiError(status, code);
}
