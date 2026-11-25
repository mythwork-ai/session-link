import { BODY_MAX_BYTES } from "./safety/limits";

export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

export const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export function errorResponse(err: unknown): Response {
  if (err instanceof HttpError) return json({ error: { code: err.code, message: err.message } }, err.status);
  console.error(JSON.stringify({ msg: "unhandled error", error: String(err), stack: err instanceof Error ? err.stack : undefined }));
  return json({ error: { code: "internal_error", message: "internal error" } }, 500);
}

/**
 * Reads the body and rejects it over the cap. A declared Content-Length over the cap is refused
 * before reading; otherwise the body is read (the platform already bounds request size) and checked.
 */
export async function readText(req: Request, max = BODY_MAX_BYTES): Promise<string> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > max) throw new HttpError(413, "too_large", `body over ${max} bytes`);
  const text = await req.text();
  if (text.length > max) throw new HttpError(413, "too_large", `body over ${max} bytes`);
  return text;
}

export async function readJson(req: Request): Promise<unknown> {
  const text = await readText(req);
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "invalid_json", "body must be valid JSON");
  }
}

export const log = (msg: string, fields: Record<string, unknown> = {}): void =>
  console.log(JSON.stringify({ msg, ...fields }));
