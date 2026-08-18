export function detailError(status: number, detail: string): Response {
  return Response.json({ detail }, { status });
}
