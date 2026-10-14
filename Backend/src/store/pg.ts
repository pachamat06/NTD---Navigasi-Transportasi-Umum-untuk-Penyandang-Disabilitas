import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import type {
  AdminRepository,
  AdminUser,
  AuditRepository,
  CacheRepository,
  ContentItem,
  ContentKind,
  ContentRepository,
  Store,
  TestCase,
  TestRepository,
  TestRun,
} from "./types";

export const MIGRATIONS_DIR = path.resolve(__dirname, "../../migrations");

/** Menjalankan migrasi SQL yang belum diterapkan, berurutan menurut nama file. */
export async function migrate(pool: Pool, log: (m: string) => void = () => {}): Promise<string[]> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(424242)");
    await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    const done = new Set((await client.query("SELECT version FROM schema_migrations")).rows.map((r) => r.version as string));
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
    const applied: string[] = [];
    for (const f of files) {
      if (done.has(f)) continue;
      await client.query("BEGIN");
      try {
        await client.query(readFileSync(path.join(MIGRATIONS_DIR, f), "utf8"));
        await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [f]);
        await client.query("COMMIT");
        applied.push(f);
        log(`migrasi diterapkan: ${f}`);
      } catch (e) {
        await client.query("ROLLBACK");
        throw new Error(`Migrasi ${f} gagal: ${(e as Error).message}`);
      }
    }
    return applied;
  } finally {
    await client.query("SELECT pg_advisory_unlock(424242)").catch(() => {});
    client.release();
  }
}

type Q = <R extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]) => Promise<R[]>;

const json = (v: unknown) => (v === undefined || v === null ? null : JSON.stringify(v));

function rowToContent(r: QueryResultRow): ContentItem {
  return {
    id: r.id,
    kind: r.kind,
    stationId: r.station_id,
    draft: r.draft,
    published: r.published,
    draftDeleted: r.draft_deleted,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    publishedAt: r.published_at,
    updatedBy: r.updated_by,
  };
}

function rowToAdmin(r: QueryResultRow): AdminUser {
  return {
    id: r.id,
    email: r.email,
    name: r.name,
    role: r.role,
    passwordHash: r.password_hash,
    active: r.active,
    createdAt: r.created_at,
    lastLoginAt: r.last_login_at,
  };
}

function rowToCase(r: QueryResultRow): TestCase {
  return { id: r.id, name: r.name, request: r.request, expect: r.expect, enabled: r.enabled, createdAt: r.created_at, updatedAt: r.updated_at };
}

function rowToRun(r: QueryResultRow): TestRun {
  return {
    id: r.id,
    mode: r.mode,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    passed: r.passed,
    failed: r.failed,
    results: r.results,
    triggeredBy: r.triggered_by,
  };
}

export function createPgStore(pool: Pool): Store {
  const q: Q = async (text, params) => (await pool.query(text, params as unknown[])).rows;
  const tx = async <T>(fn: (c: PoolClient) => Promise<T>) => {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      const out = await fn(c);
      await c.query("COMMIT");
      return out;
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  };

  const cache: CacheRepository = {
    async get<T>(key: string) {
      const [r] = await q("SELECT value, stored_at, expires_at FROM cache_entries WHERE key = $1", [key]);
      return r ? { value: r.value as T, storedAt: r.stored_at, expiresAt: r.expires_at } : null;
    },
    async put(key, value, ttlSeconds) {
      await q(
        `INSERT INTO cache_entries (key, value, stored_at, expires_at) VALUES ($1, $2, now(), now() + make_interval(secs => $3))
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, stored_at = EXCLUDED.stored_at, expires_at = EXCLUDED.expires_at`,
        [key, json(value), ttlSeconds],
      );
    },
    async purge(prefix) {
      const rows = prefix
        ? await q("DELETE FROM cache_entries WHERE starts_with(key, $1) RETURNING key", [prefix])
        : await q("DELETE FROM cache_entries RETURNING key");
      return rows.length;
    },
    async stats() {
      const [r] = await q("SELECT count(*)::int AS entries, count(*) FILTER (WHERE expires_at <= now())::int AS expired FROM cache_entries");
      return { entries: r.entries, expired: r.expired };
    },
  };

  const content: ContentRepository = {
    async list(filter = {}) {
      const where: string[] = [];
      const params: unknown[] = [];
      if (filter.kind) where.push(`kind = $${params.push(filter.kind)}`);
      if (filter.stationId) where.push(`station_id = $${params.push(filter.stationId)}`);
      const rows = await q(`SELECT * FROM content_items ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at, id`, params);
      return rows.map(rowToContent);
    },
    async get(id) {
      const [r] = await q("SELECT * FROM content_items WHERE id = $1", [id]);
      return r ? rowToContent(r) : null;
    },
    async saveDraft({ id, kind, stationId, data, by }) {
      const [r] = await q(
        `INSERT INTO content_items (id, kind, station_id, draft, updated_by) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO UPDATE SET draft = EXCLUDED.draft, station_id = EXCLUDED.station_id, draft_deleted = false,
           updated_at = now(), updated_by = EXCLUDED.updated_by
         RETURNING *`,
        [id ?? randomUUID(), kind satisfies ContentKind, stationId, json(data), by],
      );
      return rowToContent(r);
    },
    async markDeleted(id, by) {
      await q("DELETE FROM content_items WHERE id = $1 AND published IS NULL", [id]);
      const [r] = await q(
        "UPDATE content_items SET draft_deleted = true, draft = NULL, updated_at = now(), updated_by = $2 WHERE id = $1 RETURNING *",
        [id, by],
      );
      return r ? rowToContent(r) : null;
    },
    async discardDraft(id) {
      await q("DELETE FROM content_items WHERE id = $1 AND published IS NULL", [id]);
      const [r] = await q("UPDATE content_items SET draft = NULL, draft_deleted = false WHERE id = $1 RETURNING *", [id]);
      return r ? rowToContent(r) : null;
    },
    async pending() {
      const rows = await q("SELECT * FROM content_items WHERE draft IS NOT NULL OR draft_deleted ORDER BY updated_at");
      return rows.map(rowToContent);
    },
    async publish(ids, by) {
      return tx(async (c) => {
        const all = ids === "all";
        const del = await c.query("DELETE FROM content_items WHERE draft_deleted AND ($1 OR id = ANY($2)) RETURNING id", [all, all ? [] : ids]);
        const pub = await c.query(
          `UPDATE content_items SET published = draft, draft = NULL, published_at = now(), updated_by = $3
           WHERE draft IS NOT NULL AND ($1 OR id = ANY($2)) RETURNING id`,
          [all, all ? [] : ids, by],
        );
        const out = { published: pub.rowCount ?? 0, deleted: del.rowCount ?? 0 };
        if (out.published || out.deleted) await c.query("UPDATE content_meta SET version = version + 1");
        return out;
      });
    },
    async version() {
      const [r] = await q("SELECT version FROM content_meta");
      return Number(r.version);
    },
  };

  const admins: AdminRepository = {
    async count() {
      const [r] = await q("SELECT count(*)::int AS n FROM admins");
      return r.n;
    },
    async list() {
      return (await q("SELECT * FROM admins ORDER BY created_at")).map(rowToAdmin);
    },
    async byEmail(email) {
      const [r] = await q("SELECT * FROM admins WHERE email = $1", [email.toLowerCase()]);
      return r ? rowToAdmin(r) : null;
    },
    async byId(id) {
      const [r] = await q("SELECT * FROM admins WHERE id = $1", [id]);
      return r ? rowToAdmin(r) : null;
    },
    async create(u) {
      const [r] = await q(
        "INSERT INTO admins (id, email, name, role, password_hash, active) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *",
        [randomUUID(), u.email.toLowerCase(), u.name, u.role, u.passwordHash, u.active],
      );
      return rowToAdmin(r);
    },
    async update(id, patch) {
      const cols: Record<string, string> = { name: "name", role: "role", passwordHash: "password_hash", active: "active", lastLoginAt: "last_login_at" };
      const sets: string[] = [];
      const params: unknown[] = [id];
      for (const [k, v] of Object.entries(patch)) if (v !== undefined && cols[k]) sets.push(`${cols[k]} = $${params.push(v)}`);
      if (!sets.length) return this.byId(id);
      const [r] = await q(`UPDATE admins SET ${sets.join(", ")} WHERE id = $1 RETURNING *`, params);
      return r ? rowToAdmin(r) : null;
    },
  };

  const tests: TestRepository = {
    async listCases() {
      return (await q("SELECT * FROM api_test_cases ORDER BY created_at")).map(rowToCase);
    },
    async getCase(id) {
      const [r] = await q("SELECT * FROM api_test_cases WHERE id = $1", [id]);
      return r ? rowToCase(r) : null;
    },
    async saveCase({ id, name, request, expect, enabled }) {
      const [r] = await q(
        `INSERT INTO api_test_cases (id, name, request, expect, enabled) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, request = EXCLUDED.request, expect = EXCLUDED.expect,
           enabled = EXCLUDED.enabled, updated_at = now()
         RETURNING *`,
        [id ?? randomUUID(), name, json(request), json(expect), enabled],
      );
      return rowToCase(r);
    },
    async deleteCase(id) {
      return (await q("DELETE FROM api_test_cases WHERE id = $1 RETURNING id", [id])).length > 0;
    },
    async addRun(run) {
      const [r] = await q(
        `INSERT INTO api_test_runs (id, mode, started_at, finished_at, passed, failed, results, triggered_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [randomUUID(), run.mode, run.startedAt, run.finishedAt, run.passed, run.failed, json(run.results), run.triggeredBy],
      );
      return rowToRun(r);
    },
    async listRuns(limit) {
      return (await q("SELECT * FROM api_test_runs ORDER BY started_at DESC LIMIT $1", [limit])).map(rowToRun);
    },
  };

  const audit: AuditRepository = {
    async add(e) {
      await q("INSERT INTO audit_log (actor, action, target, detail) VALUES ($1, $2, $3, $4)", [e.actor, e.action, e.target ?? null, json(e.detail)]);
    },
    async list(limit) {
      const rows = await q("SELECT * FROM audit_log ORDER BY at DESC, id DESC LIMIT $1", [limit]);
      return rows.map((r) => ({ id: Number(r.id), at: r.at, actor: r.actor, action: r.action, target: r.target, detail: r.detail }));
    },
  };

  return {
    kind: "postgres",
    cache,
    content,
    admins,
    tests,
    audit,
    ping: async () => {
      try {
        await q("SELECT 1");
        return true;
      } catch {
        return false;
      }
    },
    close: () => pool.end(),
  };
}

export async function connectPgStore(databaseUrl: string, log?: (m: string) => void): Promise<Store> {
  // Mode TLS diatur lewat parameter sslmode pada DATABASE_URL (dibaca langsung oleh driver pg).
  const pool = new Pool({ connectionString: databaseUrl, max: 10 });
  await migrate(pool, log);
  return createPgStore(pool);
}
