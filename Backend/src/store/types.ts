// Kontrak penyimpanan. Dua implementasi: PostgreSQL (pg.ts, dipakai di deployment) dan memori
// (memory.ts, untuk pengujian dan demo tanpa basis data; data hilang saat server berhenti).

export interface CacheEntry<T = unknown> {
  value: T;
  storedAt: Date;
  expiresAt: Date;
}

/** CacheRepository (Tabel 3.8): penyimpanan sementara ber-TTL untuk data Commute Data API. */
export interface CacheRepository {
  get<T>(key: string): Promise<CacheEntry<T> | null>;
  put<T>(key: string, value: T, ttlSeconds: number): Promise<void>;
  purge(prefix?: string): Promise<number>;
  stats(): Promise<{ entries: number; expired: number }>;
}

/**
 * Konten yang dikelola tim NTD lewat halaman admin. Setiap item punya salinan "draft" (sedang disunting,
 * hanya terlihat di mode pratinjau admin) dan "published" (terlihat oleh pengguna). Publikasi menyalin
 * draft ke published, sehingga perubahan dapat diuji coba lebih dulu sebelum sampai ke pengguna.
 */
export type ContentKind = "facility" | "entrance" | "notice" | "station_info" | "settings";

export interface ContentItem<T = unknown> {
  id: string;
  kind: ContentKind;
  stationId: string | null;
  draft: T | null;
  published: T | null;
  draftDeleted: boolean;
  createdAt: Date;
  updatedAt: Date;
  publishedAt: Date | null;
  updatedBy: string | null;
}

export interface ContentRepository {
  list(filter?: { kind?: ContentKind; stationId?: string }): Promise<ContentItem[]>;
  get(id: string): Promise<ContentItem | null>;
  /** Membuat item baru (atau mengganti draft item yang sudah ada dengan id sama). */
  saveDraft(input: { id?: string; kind: ContentKind; stationId: string | null; data: unknown; by: string }): Promise<ContentItem>;
  /** Menandai item untuk dihapus saat publikasi; item yang belum pernah terbit langsung dihapus. */
  markDeleted(id: string, by: string): Promise<ContentItem | null>;
  discardDraft(id: string): Promise<ContentItem | null>;
  /** Item dengan perubahan yang belum terbit. */
  pending(): Promise<ContentItem[]>;
  publish(ids: string[] | "all", by: string): Promise<{ published: number; deleted: number }>;
  /** Naik setiap kali konten terbit berubah; dipakai untuk invalidasi snapshot. */
  version(): Promise<number>;
}

export type AdminRole = "admin" | "editor";

export interface AdminUser {
  id: string;
  email: string;
  name: string;
  role: AdminRole;
  passwordHash: string;
  active: boolean;
  createdAt: Date;
  lastLoginAt: Date | null;
}

export interface AdminRepository {
  count(): Promise<number>;
  list(): Promise<AdminUser[]>;
  byEmail(email: string): Promise<AdminUser | null>;
  byId(id: string): Promise<AdminUser | null>;
  create(u: Omit<AdminUser, "id" | "createdAt" | "lastLoginAt">): Promise<AdminUser>;
  update(id: string, patch: Partial<Pick<AdminUser, "name" | "role" | "passwordHash" | "active" | "lastLoginAt">>): Promise<AdminUser | null>;
}

export interface TestCase {
  id: string;
  name: string;
  request: unknown;
  expect: unknown;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface TestRun {
  id: string;
  mode: "preview" | "published";
  startedAt: Date;
  finishedAt: Date;
  passed: number;
  failed: number;
  results: unknown;
  triggeredBy: string;
}

export interface TestRepository {
  listCases(): Promise<TestCase[]>;
  getCase(id: string): Promise<TestCase | null>;
  saveCase(input: { id?: string; name: string; request: unknown; expect: unknown; enabled: boolean }): Promise<TestCase>;
  deleteCase(id: string): Promise<boolean>;
  addRun(run: Omit<TestRun, "id">): Promise<TestRun>;
  listRuns(limit: number): Promise<TestRun[]>;
}

export interface AuditEntry {
  id: number;
  at: Date;
  actor: string;
  action: string;
  target: string | null;
  detail: unknown;
}

export interface AuditRepository {
  add(e: { actor: string; action: string; target?: string | null; detail?: unknown }): Promise<void>;
  list(limit: number): Promise<AuditEntry[]>;
}

export interface Store {
  readonly kind: "postgres" | "memory";
  cache: CacheRepository;
  content: ContentRepository;
  admins: AdminRepository;
  tests: TestRepository;
  audit: AuditRepository;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}
