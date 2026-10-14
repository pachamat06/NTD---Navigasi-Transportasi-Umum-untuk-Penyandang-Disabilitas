// Autentikasi admin: kata sandi di-hash dengan scrypt, token bertanda tangan HMAC-SHA256 (stateless,
// sesuai backend tanpa status sesi pada Subbab 3.7). Tidak memerlukan dependensi tambahan.

import { createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { AdminRepository, AdminRole, AdminUser } from "../store/types";

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, saltB64, hashB64] = stored.split("$");
  if (alg !== "scrypt" || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, "base64");
  const actual = await scrypt(password, Buffer.from(saltB64, "base64"), expected.length);
  return timingSafeEqual(actual, expected);
}

export const PASSWORD_MIN = 10;

export interface TokenPayload {
  sub: string;
  role: AdminRole;
  /** epoch detik */
  exp: number;
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

export class AuthService {
  private secret: Buffer;

  constructor(
    private admins: AdminRepository,
    secret: string | undefined,
    private ttlMinutes: number,
  ) {
    this.secret = secret ? Buffer.from(secret) : randomBytes(32);
  }

  sign(user: Pick<AdminUser, "id" | "role">, now = Date.now()): { token: string; expiresAt: string } {
    const exp = Math.floor(now / 1000) + this.ttlMinutes * 60;
    const payload = b64url(JSON.stringify({ sub: user.id, role: user.role, exp } satisfies TokenPayload));
    const sig = b64url(createHmac("sha256", this.secret).update(payload).digest());
    return { token: `${payload}.${sig}`, expiresAt: new Date(exp * 1000).toISOString() };
  }

  /** Memverifikasi tanda tangan dan masa berlaku, lalu memastikan akun masih aktif. */
  async verify(token: string): Promise<AdminUser | null> {
    const [payload, sig] = token.split(".");
    if (!payload || !sig) return null;
    const expected = createHmac("sha256", this.secret).update(payload).digest();
    const given = Buffer.from(sig, "base64url");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    let data: TokenPayload;
    try {
      data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    } catch {
      return null;
    }
    if (typeof data.exp !== "number" || data.exp * 1000 < Date.now()) return null;
    const user = await this.admins.byId(data.sub);
    return user?.active ? user : null;
  }

  async login(email: string, password: string): Promise<AdminUser | null> {
    const user = await this.admins.byEmail(email);
    // Tetap menghitung hash bila akun tidak ada agar waktu respons tidak membocorkan keberadaan email.
    const ok = await verifyPassword(password, user?.passwordHash ?? "scrypt$AAAAAAAAAAAAAAAAAAAAAA==$" + "A".repeat(86) + "==");
    if (!user || !ok || !user.active) return null;
    await this.admins.update(user.id, { lastLoginAt: new Date() });
    return user;
  }

  /** Membuat admin pertama dari environment variable bila belum ada admin sama sekali. */
  async bootstrap(email?: string, password?: string, log: (m: string) => void = () => {}): Promise<void> {
    if (!email || !password) return;
    if ((await this.admins.count()) > 0) return;
    if (password.length < PASSWORD_MIN) throw new Error(`ADMIN_BOOTSTRAP_PASSWORD minimal ${PASSWORD_MIN} karakter.`);
    await this.admins.create({ email, name: "Administrator", role: "admin", passwordHash: await hashPassword(password), active: true });
    log(`admin awal dibuat: ${email}`);
  }
}

export function publicUser(u: AdminUser) {
  return { id: u.id, email: u.email, name: u.name, role: u.role, active: u.active, createdAt: u.createdAt, lastLoginAt: u.lastLoginAt };
}
