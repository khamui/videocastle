import { randomBytes } from 'node:crypto';
import type {
  FastifyInstance,
  FastifyPluginOptions,
  FastifyReply,
  FastifyRequest,
  preHandlerHookHandler,
} from 'fastify';
import type { Clock } from '../ports/clock';
import type { Operator } from '../db/schema';
import { hashPassword, verifyPassword } from './password';
import { OperatorAlreadyExistsError, type OperatorRepo } from './operator-repo';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the requireOperator guard once a request is authenticated. */
    operator?: Operator;
  }
}

export interface AuthRouteOptions extends FastifyPluginOptions {
  repo: OperatorRepo;
  clock: Clock;
  cookieSecure: boolean;
}

const SESSION_COOKIE = 'vc_session';
const MIN_PASSWORD_LENGTH = 8;

interface Credentials {
  username: string;
  password: string;
}

export async function registerAuthRoutes(
  app: FastifyInstance,
  options: AuthRouteOptions,
): Promise<void> {
  const { repo, clock, cookieSecure } = options;

  // A throwaway hash verified on the unknown-username path so sign-in spends the
  // same scrypt time whether or not the username exists — closing the timing
  // oracle that would otherwise let valid usernames be probed.
  const decoyHash = await hashPassword(randomBytes(32).toString('hex'));

  const cookieOptions = {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: cookieSecure,
  } as const;

  /** Issues the signed, httpOnly session cookie for an Operator. */
  function startSession(reply: FastifyReply, operator: Operator): void {
    reply.setCookie(SESSION_COOKIE, String(operator.id), {
      ...cookieOptions,
      signed: true,
    });
  }

  /**
   * Resolves the authenticated Operator from a signed session cookie, or
   * undefined when the cookie is absent, unsigned/tampered, or no longer maps to
   * the current Operator.
   */
  async function currentOperator(
    request: FastifyRequest,
  ): Promise<Operator | undefined> {
    const raw = request.cookies[SESSION_COOKIE];
    if (!raw) return undefined;

    const unsigned = request.unsignCookie(raw);
    if (!unsigned.valid || unsigned.value === null) return undefined;

    const operator = await repo.get();
    if (!operator || String(operator.id) !== unsigned.value) return undefined;
    return operator;
  }

  /** preHandler that gates Operator-only routes, rejecting anyone unauthenticated. */
  const requireOperator: preHandlerHookHandler = async (request, reply) => {
    const operator = await currentOperator(request);
    if (!operator) {
      return reply.code(401).send({ error: 'unauthenticated' });
    }
    request.operator = operator;
  };

  // Reports whether first-run setup is still needed, so the SPA can show the
  // setup screen on a fresh instance.
  app.get('/api/setup', async () => {
    return { needsSetup: !(await repo.exists()) };
  });

  // First-run setup: create the single Operator credential and sign in. Refuses
  // once an Operator already exists so the credential can't be silently replaced.
  app.post('/api/setup', async (request, reply) => {
    const creds = parseCredentials(request.body);
    if (!creds) {
      return reply.code(400).send({ error: 'invalid_credentials_format' });
    }

    try {
      const operator = await repo.create({
        username: creds.username,
        passwordHash: await hashPassword(creds.password),
        createdAt: clock.now(),
      });
      startSession(reply, operator);
      return reply.code(201).send({ operator: serializeOperator(operator) });
    } catch (err) {
      if (err instanceof OperatorAlreadyExistsError) {
        return reply.code(409).send({ error: 'already_setup' });
      }
      throw err;
    }
  });

  // Sign in: verify credentials and issue a session cookie. Unknown username and
  // wrong password are answered identically so neither can be probed.
  app.post('/api/session', async (request, reply) => {
    const creds = parseCredentials(request.body);
    if (!creds) {
      return reply.code(401).send({ error: 'invalid_credentials' });
    }

    const operator = await repo.findByUsername(creds.username);
    // Always verify against a hash (the decoy when the username is unknown) so
    // the response time doesn't reveal whether the username exists.
    const ok = await verifyPassword(
      creds.password,
      operator?.passwordHash ?? decoyHash,
    );
    if (!operator || !ok) {
      return reply.code(401).send({ error: 'invalid_credentials' });
    }

    startSession(reply, operator);
    return reply.code(200).send({ operator: serializeOperator(operator) });
  });

  // Sign out: clear the session cookie.
  app.delete('/api/session', async (_request, reply) => {
    reply.clearCookie(SESSION_COOKIE, cookieOptions);
    return reply.code(204).send();
  });

  // Operator-only: the authenticated Operator's own details. Doubles as the
  // session check the SPA uses to decide whether to show the Dashboard.
  app.get('/api/me', { preHandler: requireOperator }, async (request) => {
    return { operator: serializeOperator(request.operator!) };
  });
}

function serializeOperator(operator: Operator): {
  username: string;
  createdAt: number;
} {
  return { username: operator.username, createdAt: operator.createdAt };
}

/**
 * Validates a credentials payload. Returns the trimmed credentials, or
 * undefined when the shape is wrong, the username is blank, or the password is
 * shorter than the minimum length.
 */
function parseCredentials(body: unknown): Credentials | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const { username, password } = body as Record<string, unknown>;
  if (typeof username !== 'string' || typeof password !== 'string') {
    return undefined;
  }
  const trimmed = username.trim();
  if (trimmed.length === 0 || password.length < MIN_PASSWORD_LENGTH) {
    return undefined;
  }
  return { username: trimmed, password };
}
