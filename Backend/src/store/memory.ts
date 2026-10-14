import { randomUUID } from "node:crypto";
import type {
  AdminRepository,
  AdminUser,
  AuditEntry,
  AuditRepository,
  CacheEntry,
  CacheRepository,
  ContentItem,
  ContentRepository,
  Store,
  TestCase,
  TestRepository,
  TestRun,
} from "./types";

const clone = <T>(v: T): T => (v === null || v === undefined ? v : structuredClone(v));

class MemoryCache implements CacheRepository {
  private m = new Map<string, CacheEntry>();
  async get<T>(key: string) {
    const e = this.m.get(key);
    return e ? ({ ...e, value: clone(e.value) } as CacheEntry<T>) : null;
  }
  async put<T>(key: string, value: T, ttlSeconds: number) {
    const now = new Date();
    this.m.set(key, { value: clone(value), storedAt: now, expiresAt: new Date(now.getTime() + ttlSeconds * 1000) });
  }
  async purge(prefix?: string) {
    let n = 0;
    for (const k of [...this.m.keys()]) if (!prefix || k.startsWith(prefix)) n += Number(this.m.delete(k));
    return n;
  }
  async stats() {
    const now = Date.now();
    return { entries: this.m.size, expired: [...this.m.values()].filter((e) => e.expiresAt.getTime() <= now).length };
  }
}

class MemoryContent implements ContentRepository {
  private m = new Map<string, ContentItem>();
  private ver = 0;
  async list(filter: { kind?: string; stationId?: string } = {}) {
    return [...this.m.values()]
      .filter((i) => (!filter.kind || i.kind === filter.kind) && (!filter.stationId || i.stationId === filter.stationId))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map(clone);
  }
  async get(id: string) {
    return clone(this.m.get(id) ?? null);
  }
  async saveDraft(input: Parameters<ContentRepository["saveDraft"]>[0]) {
    const now = new Date();
    const existing = input.id ? this.m.get(input.id) : undefined;
    const item: ContentItem = existing
      ? { ...existing, draft: clone(input.data), draftDeleted: false, stationId: input.stationId, updatedAt: now, updatedBy: input.by }
      : {
          id: input.id ?? randomUUID(),
          kind: input.kind,
          stationId: input.stationId,
          draft: clone(input.data),
          published: null,
          draftDeleted: false,
          createdAt: now,
          updatedAt: now,
          publishedAt: null,
          updatedBy: input.by,
        };
    this.m.set(item.id, item);
    return clone(item);
  }
  async markDeleted(id: string, by: string) {
    const it = this.m.get(id);
    if (!it) return null;
    if (it.published === null) {
      this.m.delete(id);
      return null;
    }
    Object.assign(it, { draftDeleted: true, draft: null, updatedAt: new Date(), updatedBy: by });
    return clone(it);
  }
  async discardDraft(id: string) {
    const it = this.m.get(id);
    if (!it) return null;
    if (it.published === null) {
      this.m.delete(id);
      return null;
    }
    Object.assign(it, { draft: null, draftDeleted: false });
    return clone(it);
  }
  async pending() {
    return (await this.list()).filter((i) => i.draft !== null || i.draftDeleted);
  }
  async publish(ids: string[] | "all", by: string) {
    let published = 0;
    let deleted = 0;
    const now = new Date();
    for (const it of [...this.m.values()]) {
      if (ids !== "all" && !ids.includes(it.id)) continue;
      if (it.draftDeleted) {
        this.m.delete(it.id);
        deleted++;
      } else if (it.draft !== null) {
        Object.assign(it, { published: it.draft, draft: null, publishedAt: now, updatedBy: by });
        published++;
      }
    }
    if (published || deleted) this.ver++;
    return { published, deleted };
  }
  async version() {
    return this.ver;
  }
}

class MemoryAdmins implements AdminRepository {
  private m = new Map<string, AdminUser>();
  async count() {
    return this.m.size;
  }
  async list() {
    return [...this.m.values()].map(clone);
  }
  async byEmail(email: string) {
    return clone([...this.m.values()].find((u) => u.email === email.toLowerCase()) ?? null);
  }
  async byId(id: string) {
    return clone(this.m.get(id) ?? null);
  }
  async create(u: Omit<AdminUser, "id" | "createdAt" | "lastLoginAt">) {
    if (await this.byEmail(u.email)) throw new Error("duplicate email");
    const user: AdminUser = { ...u, email: u.email.toLowerCase(), id: randomUUID(), createdAt: new Date(), lastLoginAt: null };
    this.m.set(user.id, user);
    return clone(user);
  }
  async update(id: string, patch: Parameters<AdminRepository["update"]>[1]) {
    const u = this.m.get(id);
    if (!u) return null;
    Object.assign(u, patch);
    return clone(u);
  }
}

class MemoryTests implements TestRepository {
  private cases = new Map<string, TestCase>();
  private runs: TestRun[] = [];
  async listCases() {
    return [...this.cases.values()].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).map(clone);
  }
  async getCase(id: string) {
    return clone(this.cases.get(id) ?? null);
  }
  async saveCase(input: Parameters<TestRepository["saveCase"]>[0]) {
    const now = new Date();
    const prev = input.id ? this.cases.get(input.id) : undefined;
    const c: TestCase = {
      id: prev?.id ?? input.id ?? randomUUID(),
      name: input.name,
      request: clone(input.request),
      expect: clone(input.expect),
      enabled: input.enabled,
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
    };
    this.cases.set(c.id, c);
    return clone(c);
  }
  async deleteCase(id: string) {
    return this.cases.delete(id);
  }
  async addRun(run: Omit<TestRun, "id">) {
    const r = { ...clone(run), id: randomUUID() };
    this.runs.unshift(r);
    return clone(r);
  }
  async listRuns(limit: number) {
    return this.runs.slice(0, limit).map(clone);
  }
}

class MemoryAudit implements AuditRepository {
  private rows: AuditEntry[] = [];
  async add(e: { actor: string; action: string; target?: string | null; detail?: unknown }) {
    this.rows.unshift({ id: this.rows.length + 1, at: new Date(), actor: e.actor, action: e.action, target: e.target ?? null, detail: clone(e.detail ?? null) });
  }
  async list(limit: number) {
    return this.rows.slice(0, limit).map(clone);
  }
}

export function createMemoryStore(): Store {
  return {
    kind: "memory",
    cache: new MemoryCache(),
    content: new MemoryContent(),
    admins: new MemoryAdmins(),
    tests: new MemoryTests(),
    audit: new MemoryAudit(),
    ping: async () => true,
    close: async () => {},
  };
}
