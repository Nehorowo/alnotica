import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { type StaffRow, type TenantRow, staff, tenant } from '../schema.js';

export interface CreateTenantInput {
  readonly slug: string;
  readonly title: string;
  readonly kind: string;
  readonly timezone: string;
  readonly botId: string;
  readonly address?: string | null;
  readonly phone?: string | null;
}

/**
 * Tenant lookups that necessarily happen *before* a tenant context exists — by
 * slug from a deep link, or by the Telegram id of whoever is talking to the bot.
 * Everything else goes through `forTenant`.
 */
export function tenantRepo(db: Database) {
  return {
    async create(input: CreateTenantInput): Promise<TenantRow> {
      const [row] = await db
        .insert(tenant)
        .values({
          slug: input.slug,
          title: input.title,
          kind: input.kind,
          timezone: input.timezone,
          botId: input.botId,
          address: input.address ?? null,
          phone: input.phone ?? null,
        })
        .returning();
      if (!row) throw new Error('insert into tenant returned nothing');
      return row;
    },

    async byId(id: string): Promise<TenantRow | null> {
      const [row] = await db.select().from(tenant).where(eq(tenant.id, id)).limit(1);
      return row ?? null;
    },

    async bySlug(slug: string): Promise<TenantRow | null> {
      const [row] = await db.select().from(tenant).where(eq(tenant.slug, slug)).limit(1);
      return row ?? null;
    },

    async slugTaken(slug: string): Promise<boolean> {
      const [row] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(tenant)
        .where(eq(tenant.slug, slug));
      return (row?.n ?? 0) > 0;
    },

    /**
     * Every tenant this Telegram user works for. A person can be an owner in one
     * salon and a staff member in another, so this returns a list, not a row.
     */
    async membershipsOf(telegramId: bigint): Promise<{ tenant: TenantRow; staff: StaffRow }[]> {
      const rows = await db
        .select({ tenant, staff })
        .from(staff)
        .innerJoin(tenant, eq(tenant.id, staff.tenantId))
        .where(and(eq(staff.telegramId, telegramId), eq(staff.isActive, true)));
      return rows;
    },

    async listActive(): Promise<TenantRow[]> {
      return db.select().from(tenant).where(eq(tenant.isActive, true));
    },

    async update(id: string, patch: Partial<TenantRow>): Promise<TenantRow | null> {
      const [row] = await db.update(tenant).set(patch).where(eq(tenant.id, id)).returning();
      return row ?? null;
    },
  };
}

export type TenantRepo = ReturnType<typeof tenantRepo>;
