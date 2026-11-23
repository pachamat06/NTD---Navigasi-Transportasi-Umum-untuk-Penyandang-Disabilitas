// Sumber postingan yang dapat dikonfigurasi admin tanpa restart: token X API (terenkripsi di server_config) menggantikan
// environment bila diisi. Sumber "fixture" (berkas JSON, untuk uji) tetap dari environment.

import { z } from "zod";
import type { Config } from "../../config";
import type { ServerConfigRepository } from "../../store/types";
import { keyHint, SecretBox } from "../secrets";
import { FixturePostSource, XApiPostSource, type PostSource } from "./PostSource";

export const X_CONFIG_KEY = "ai.x";

/** Sumber postingan bagi agent pembaca: selalu membaca konfigurasi terkini. */
export interface PostSourceProvider {
  source(): Promise<PostSource | null>;
}

interface Stored {
  /** Token terenkripsi (SecretBox). */
  token?: string;
  tokenHint?: string;
}

export const xTokenInput = z.object({
  xBearerToken: z.string().trim().min(20).max(500).regex(/^\S+$/, "token tidak boleh memuat spasi").optional(),
  clearXToken: z.boolean().optional(),
});
export type XTokenInput = z.infer<typeof xTokenInput>;

export interface XTokenView {
  kind: "none" | "x" | "fixture";
  configured: boolean;
  token: { set: boolean; source: "admin" | "env" | null; hint: string | null; problem: string | null };
  canStoreToken: boolean;
  updatedAt: Date | null;
  updatedBy: string | null;
}

export class PostSourceService implements PostSourceProvider {
  private cached?: { sig: string; source: PostSource | null };

  constructor(
    private env: Config["serviceInfo"],
    private repo: ServerConfigRepository,
    private box: SecretBox,
    private opts: { /** Untuk pengujian: pembuat sumber X pengganti. */ xFactory?: (token: string) => PostSource; /** Untuk pengujian: sumber tetap. */ fixed?: PostSource | null } = {},
  ) {}

  private async resolveToken() {
    const entry = await this.repo.get<Stored>(X_CONFIG_KEY);
    const s = entry?.value;
    const admin = s?.token ? this.box.open(s.token) : null;
    const token = admin ?? this.env.xBearerToken ?? null;
    return { token, source: (admin ? "admin" : this.env.xBearerToken ? "env" : null) as "admin" | "env" | null, unreadable: !!s?.token && !admin, hint: s?.tokenHint ?? null, entry };
  }

  async source(): Promise<PostSource | null> {
    if (this.opts.fixed !== undefined) return this.opts.fixed;
    if (this.env.source === "fixture") {
      if (!this.env.fixtureFile) return null;
      if (this.cached?.sig !== "fixture") this.cached = { sig: "fixture", source: FixturePostSource.fromFile(this.env.fixtureFile) };
      return this.cached.source;
    }
    const { token } = await this.resolveToken();
    if (!token) return null;
    const sig = `x:${token}`;
    if (this.cached?.sig !== sig) {
      this.cached = { sig, source: this.opts.xFactory ? this.opts.xFactory(token) : new XApiPostSource({ bearerToken: token, baseUrl: this.env.xBaseUrl, timeoutMs: this.env.timeoutMs }) };
    }
    return this.cached.source;
  }

  async view(): Promise<XTokenView> {
    const r = await this.resolveToken();
    const src = await this.source();
    return {
      kind: src?.kind ?? "none",
      configured: !!src,
      token: {
        set: !!r.token,
        source: r.source,
        hint: r.source === "admin" ? r.hint : r.token ? keyHint(r.token) : null,
        problem: r.unreadable ? "Token tersimpan tidak dapat dibaca (ADMIN_TOKEN_SECRET berubah?). Isi ulang token." : null,
      },
      canStoreToken: this.box.available,
      updatedAt: r.entry?.updatedAt ?? null,
      updatedBy: r.entry?.updatedBy ?? null,
    };
  }

  async update(input: XTokenInput, by: string): Promise<XTokenView> {
    const next: Stored = { ...((await this.repo.get<Stored>(X_CONFIG_KEY))?.value ?? {}) };
    if (input.clearXToken) {
      delete next.token;
      delete next.tokenHint;
    }
    if (input.xBearerToken) {
      next.token = this.box.seal(input.xBearerToken);
      next.tokenHint = keyHint(input.xBearerToken);
    }
    if (input.clearXToken || input.xBearerToken) {
      await this.repo.put(X_CONFIG_KEY, next, by);
      this.cached = undefined;
    }
    return this.view();
  }
}
