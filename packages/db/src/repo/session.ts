import { eq } from 'drizzle-orm';
import type { Database } from '../client.js';
import { session } from '../schema.js';

/**
 * grammY `StorageAdapter` backed by Postgres.
 *
 * The in-memory default loses every half-finished dialogue on restart — a master
 * three steps into registration would silently start over on every deploy.
 */
export interface StorageAdapter<T> {
  read(key: string): Promise<T | undefined>;
  write(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
}

export function pgSessionStorage<T>(db: Database): StorageAdapter<T> {
  return {
    async read(key: string): Promise<T | undefined> {
      const [row] = await db.select().from(session).where(eq(session.key, key)).limit(1);
      // jsonb round-tripped through our own writer; grammY's session middleware
      // owns the shape and re-initialises anything it cannot use.
      return row ? (row.data as T) : undefined;
    },

    async write(key: string, value: T): Promise<void> {
      await db
        .insert(session)
        .values({ key, data: value as never, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: session.key,
          set: { data: value as never, updatedAt: new Date() },
        });
    },

    async delete(key: string): Promise<void> {
      await db.delete(session).where(eq(session.key, key));
    },
  };
}
