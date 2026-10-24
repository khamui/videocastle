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
}
