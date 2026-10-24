import type { TestApp } from './helpers';

type InjectResponse = Awaited<ReturnType<TestApp['app']['inject']>>;

/** The single Operator credential the tests set up and sign in with. */
export const OPERATOR = { username: 'operator', password: 'correct horse battery' };

/** Collects the Set-Cookie values from a response into a name→value jar. */
export function cookieJar(res: InjectResponse): Record<string, string> {
  const jar: Record<string, string> = {};
  for (const cookie of res.cookies) jar[cookie.name] = cookie.value;
  return jar;
}

/**
 * Completes first-run setup as {@link OPERATOR} and returns the session jar, so
 * a test starts from a signed-in Operator. Throws if setup doesn't take.
 */
export async function setupOperator(
  app: TestApp['app'],
): Promise<Record<string, string>> {
  const res = await app.inject({ method: 'POST', url: '/api/setup', payload: OPERATOR });
  if (res.statusCode !== 201) {
    throw new Error(`operator setup failed: ${res.statusCode} ${res.body}`);
  }
  return cookieJar(res);
}

/** Builds a `multipart/form-data` body: the field parts first, then one file. */
export function multipart(parts: {
  fields?: Record<string, string>;
  file?: { fieldname: string; filename: string; content: string | Buffer };
}): { payload: Buffer; headers: Record<string, string> } {
  const boundary = `----vctest${Math.random().toString(16).slice(2)}`;
  const chunks: Buffer[] = [];
  for (const [name, value] of Object.entries(parts.fields ?? {})) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ),
    );
  }
  if (parts.file) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${parts.file.fieldname}"; filename="${parts.file.filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
      Buffer.isBuffer(parts.file.content)
        ? parts.file.content
        : Buffer.from(parts.file.content),
      Buffer.from('\r\n'),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(chunks),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

/** Uploads a Video through the public upload route as the signed-in Operator. */
export function uploadVideo(
  app: TestApp['app'],
  jar: Record<string, string>,
  parts: Parameters<typeof multipart>[0],
): Promise<InjectResponse> {
  const { payload, headers } = multipart(parts);
  return app.inject({
    method: 'POST',
    url: '/api/videos',
    cookies: jar,
    headers,
    payload,
  });
}

/** Polls until a condition holds, so a test can await the async worker picking up a job. */
export async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
