import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Database } from '../db/client';
import { operators, appConfig, type Operator } from '../db/schema';

const SESSION_SECRET_KEY = 'session_secret';

/**
 * Data access for the single Operator credential and instance config.
 * Exclusive-single-Operator is enforced here: `create` refuses a second one.
 */
export class OperatorRepo {
  constructor(private readonly db: Database) {}

  async get(): Promise<Operator | undefined> {
    const rows = await this.db.select().from(operators).limit(1);
    return rows[0];
  }

  async findByUsername(username: string): Promise<Operator | undefined> {
    const rows = await this.db
      .select()
      .from(operators)
      .where(eq(operators.username, username))
      .limit(1);
    return rows[0];
  }

  /** True once an Operator credential exists (i.e. first-run setup is done). */
  async exists(): Promise<boolean> {
    return (await this.get()) !== undefined;
  }

  /**
   * Creates the single Operator. Throws if one already exists, so the first-run
   * setup route can surface a clear conflict instead of minting a second
   * credential.
   */
  async create(input: {
    username: string;
    passwordHash: string;
    createdAt: number;
  }): Promise<Operator> {
    if (await this.exists()) {
      throw new OperatorAlreadyExistsError();
    }
    await this.db.insert(operators).values(input);
    const created = await this.findByUsername(input.username);
    if (!created) {
      throw new Error('Operator creation did not persist');
    }
    return created;
  }

  /**
   * Resolves the session-signing secret. An env override always wins and is not
   * persisted (the env stays the source of truth). Otherwise the secret is read
   * from the database, or generated and persisted on first run so that sessions
   * survive restarts.
   */
  async resolveSessionSecret(override: string | undefined): Promise<string> {
    if (override) return override;

    const rows = await this.db
      .select()
      .from(appConfig)
      .where(eq(appConfig.key, SESSION_SECRET_KEY))
      .limit(1);
    const existing = rows[0];
    if (existing) return existing.value;

    const generated = randomBytes(32).toString('hex');
    await this.db
      .insert(appConfig)
      .values({ key: SESSION_SECRET_KEY, value: generated });
    return generated;
  }
}

export class OperatorAlreadyExistsError extends Error {
  constructor() {
    super('An Operator already exists for this instance');
    this.name = 'OperatorAlreadyExistsError';
  }
}
