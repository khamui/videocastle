import { desc, eq } from 'drizzle-orm';
import type { Database } from '../db/client';
import { folders, type Folder } from '../db/schema';

/**
 * Data access for Folders. Mirrors {@link VideoRepo}: Drizzle builds the SQL,
 * the surface is small and intention-revealing, and an insert is followed by a
 * read-back (the sqlite-proxy driver is used without RETURNING).
 */
export class FolderRepo {
  constructor(private readonly db: Database) {}

  /** Creates a Folder with its unguessable slug and returns it. */
  async create(input: {
    slug: string;
    name: string;
    createdAt: number;
  }): Promise<Folder> {
    await this.db.insert(folders).values({
      slug: input.slug,
      name: input.name,
      createdAt: input.createdAt,
    });
    const created = await this.findBySlug(input.slug);
    if (!created) throw new Error('Folder creation did not persist');
    return created;
  }

  /** All Folders, newest first. */
  async list(): Promise<Folder[]> {
    return this.db.select().from(folders).orderBy(desc(folders.id));
  }

  async findBySlug(slug: string): Promise<Folder | undefined> {
    const rows = await this.db
      .select()
      .from(folders)
      .where(eq(folders.slug, slug))
      .limit(1);
    return rows[0];
  }

  async findById(id: number): Promise<Folder | undefined> {
    const rows = await this.db
      .select()
      .from(folders)
      .where(eq(folders.id, id))
      .limit(1);
    return rows[0];
  }

  /**
   * Sets or clears a Folder's password. Pass a scrypt hash to protect the `/f/`
   * gallery, or `null` to make it open again. Mirrors {@link VideoRepo.setPasswordHash}:
   * the caller owns hashing; the repo just persists the value.
   */
  async setPasswordHash(id: number, passwordHash: string | null): Promise<void> {
    await this.db.update(folders).set({ passwordHash }).where(eq(folders.id, id));
  }

  /**
   * Sets or clears a Folder's Share Link expiry (epoch milliseconds, or `null`
   * to never expire). Mirrors {@link VideoRepo.setExpiresAt}: the same call
   * extends or re-enables an expired gallery by moving the instant forward; the
   * Clock-aware caller decides expired/not-expired.
   */
  async setExpiresAt(id: number, expiresAt: number | null): Promise<void> {
    await this.db.update(folders).set({ expiresAt }).where(eq(folders.id, id));
  }

  /**
   * Removes a Folder row. The caller must first clear every Video's reference to
   * it — by deleting those Videos or moving them to the Library root — since a
   * Video's `folderId` is a foreign key (deletion is enforced ON in the DB).
   */
  async delete(id: number): Promise<void> {
    await this.db.delete(folders).where(eq(folders.id, id));
  }
}
