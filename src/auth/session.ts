import type {
  FastifyReply,
  FastifyRequest,
  preHandlerHookHandler,
} from 'fastify';
import type { Operator } from '../db/schema';
import type { OperatorRepo } from './operator-repo';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the requireOperator guard once a request is authenticated. */
    operator?: Operator;
  }
}

const SESSION_COOKIE = 'vc_session';

/**
 * Owns the Operator session: issuing, clearing, and resolving the signed
 * httpOnly session cookie, plus the `requireOperator` preHandler that gates
 * Operator-only routes. Built once in {@link buildApp} and shared by every
 * plugin that needs the guard (auth routes and video routes alike), so the
 * session rules live in exactly one place.
 *
 * `request.unsignCookie` is provided by `@fastify/cookie`, registered on the
 * root app, so the guard works regardless of the plugin scope it runs in.
 */
export interface SessionManager {
  startSession(reply: FastifyReply, operator: Operator): void;
  clear(reply: FastifyReply): void;
  currentOperator(request: FastifyRequest): Promise<Operator | undefined>;
  requireOperator: preHandlerHookHandler;
}

export function createSessionManager(opts: {
  repo: OperatorRepo;
  cookieSecure: boolean;
}): SessionManager {
  const { repo, cookieSecure } = opts;

  const cookieOptions = {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: cookieSecure,
  } as const;

  function startSession(reply: FastifyReply, operator: Operator): void {
    reply.setCookie(SESSION_COOKIE, String(operator.id), {
      ...cookieOptions,
      signed: true,
    });
  }

  function clear(reply: FastifyReply): void {
    reply.clearCookie(SESSION_COOKIE, cookieOptions);
  }

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

  const requireOperator: preHandlerHookHandler = async (request, reply) => {
    const operator = await currentOperator(request);
    if (!operator) {
      return reply.code(401).send({ error: 'unauthenticated' });
    }
    request.operator = operator;
  };

  return { startSession, clear, currentOperator, requireOperator };
}
