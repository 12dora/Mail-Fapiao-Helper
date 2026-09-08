/**
 * 把 fetch 风格的 RequestInit.body 物化成可跨 redirect 复用的字节。
 *
 * FormData 每次序列化都会生成新的随机 boundary；必须只物化一次，并把
 * `new Response(formData)` 产生的 Content-Type 一并带出，否则 http.request
 * 会发出「有 multipart 字节、无 Content-Type」的请求。
 */

export interface PreparedRequestBody {
  buffer: Buffer | undefined;
  /** 由 body 推导的 Content-Type；调用方已提供时不得覆盖。 */
  contentType: string | undefined;
}

function headerPresent(headers: Record<string, string>, name: string): boolean {
  const needle = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === needle) return true;
  }
  return false;
}

/** 调用方未给对应头时，补上推导出的 Content-Type / Content-Length。 */
export function applyPreparedBodyHeaders(
  headers: Record<string, string>,
  prepared: PreparedRequestBody,
): void {
  if (prepared.contentType && !headerPresent(headers, 'content-type')) {
    headers['content-type'] = prepared.contentType;
  }
  if (prepared.buffer && !headers['content-length'] && !headers['Content-Length']) {
    headers['content-length'] = String(prepared.buffer.length);
  }
}

async function fromWebBody(body: never): Promise<PreparedRequestBody> {
  const res = new Response(body);
  return {
    buffer: Buffer.from(await res.arrayBuffer()),
    contentType: res.headers.get('content-type') || undefined,
  };
}

export async function prepareRequestBody(
  body: RequestInit['body'] | undefined,
): Promise<PreparedRequestBody> {
  if (body === null || body === undefined) {
    return { buffer: undefined, contentType: undefined };
  }
  if (Buffer.isBuffer(body)) return { buffer: body, contentType: undefined };
  if (body instanceof ArrayBuffer) return { buffer: Buffer.from(body), contentType: undefined };
  if (ArrayBuffer.isView(body)) {
    return {
      buffer: Buffer.from(body.buffer, body.byteOffset, body.byteLength),
      contentType: undefined,
    };
  }
  if (typeof body === 'string') return { buffer: Buffer.from(body), contentType: undefined };
  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
    return {
      buffer: Buffer.from(body.toString()),
      contentType: 'application/x-www-form-urlencoded;charset=UTF-8',
    };
  }
  if (typeof Blob !== 'undefined' && body instanceof Blob) {
    return {
      buffer: Buffer.from(await body.arrayBuffer()),
      contentType: body.type || undefined,
    };
  }
  if (typeof body === 'object' && body !== null && 'getReader' in (body as object)) {
    return fromWebBody(body as never);
  }
  if (typeof FormData !== 'undefined' && body instanceof FormData) {
    return fromWebBody(body as never);
  }
  throw new Error('safe_fetch_unsupported_body');
}
