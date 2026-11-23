// Enkripsi rahasia (kunci API LLM, token X) yang disimpan di basis data, agar dump/cadangan basis data saja tidak cukup untuk
// membocorkannya, dan sebaliknya .env saja tidak membocorkan kunci. Kunci enkripsi diturunkan dari ADMIN_TOKEN_SECRET
// (HKDF) dan dipakai untuk AES-256-GCM. Bila secret itu berubah, nilai tersimpan tidak terbaca dan harus diisi ulang.

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { AppError } from "../errors";

const PREFIX = "v1";
export const SECRET_MIN_LENGTH = 16;

export class SecretBox {
  private key: Buffer | null;

  constructor(secret: string | undefined) {
    this.key = secret && secret.length >= SECRET_MIN_LENGTH ? Buffer.from(hkdfSync("sha256", secret, "", "ntd-server-secrets", 32)) : null;
  }

  /** Apakah rahasia dapat disimpan (ADMIN_TOKEN_SECRET diisi dan cukup panjang)? */
  get available(): boolean {
    return this.key !== null;
  }

  seal(plain: string): string {
    if (!this.key) throw new AppError("CONFLICT", `Kunci tidak dapat disimpan: isi ADMIN_TOKEN_SECRET di .env backend (minimal ${SECRET_MIN_LENGTH} karakter) lalu restart backend.`);
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, iv);
    const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
    return [PREFIX, iv.toString("base64"), c.getAuthTag().toString("base64"), ct.toString("base64")].join(":");
  }

  /** Null bila tidak dapat dibuka (secret berubah atau data rusak). */
  open(blob: string): string | null {
    if (!this.key) return null;
    const [v, iv, tag, ct] = blob.split(":");
    if (v !== PREFIX || !iv || !tag || !ct) return null;
    try {
      const d = createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64"));
      d.setAuthTag(Buffer.from(tag, "base64"));
      return Buffer.concat([d.update(Buffer.from(ct, "base64")), d.final()]).toString("utf8");
    } catch {
      return null;
    }
  }
}

/** Petunjuk aman untuk ditampilkan: empat karakter terakhir. */
export const keyHint = (k: string) => `…${k.slice(-4)}`;
