/** Thin client for the Operator auth API. All calls share the session cookie. */

export interface OperatorSummary {
  username: string;
  createdAt: number;
}

async function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(body),
  });
}

export async function getNeedsSetup(): Promise<boolean> {
  const res = await fetch('/api/setup', { credentials: 'same-origin' });
  const data = (await res.json()) as { needsSetup: boolean };
  return data.needsSetup;
}

/** Returns the signed-in Operator, or null when there is no valid session. */
export async function getMe(): Promise<OperatorSummary | null> {
  const res = await fetch('/api/me', { credentials: 'same-origin' });
  if (res.status === 401) return null;
  const data = (await res.json()) as { operator: OperatorSummary };
  return data.operator;
}

export async function setup(
  username: string,
  password: string,
): Promise<OperatorSummary> {
  const res = await postJson('/api/setup', { username, password });
  if (!res.ok) throw new Error('Setup failed');
  const data = (await res.json()) as { operator: OperatorSummary };
  return data.operator;
}

export async function signIn(
  username: string,
  password: string,
): Promise<OperatorSummary> {
  const res = await postJson('/api/session', { username, password });
  if (res.status === 401) throw new Error('Incorrect username or password');
  if (!res.ok) throw new Error('Sign-in failed');
  const data = (await res.json()) as { operator: OperatorSummary };
  return data.operator;
}

export async function signOut(): Promise<void> {
  await fetch('/api/session', { method: 'DELETE', credentials: 'same-origin' });
}
