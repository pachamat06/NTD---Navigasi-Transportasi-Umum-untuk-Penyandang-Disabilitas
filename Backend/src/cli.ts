// Perintah pemeliharaan:
//   npm run migrate                                  menerapkan migrasi basis data
//   NEW_ADMIN_PASSWORD=... npm run admin:create -- email@contoh.id "Nama" admin
//   NEW_ADMIN_PASSWORD=... npm run admin:reset-password -- email@contoh.id

import { Pool } from "pg";
import { hashPassword, PASSWORD_MIN } from "./admin/auth";
import { loadConfig } from "./config";
import { createPgStore, migrate } from "./store/pg";

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const config = loadConfig();
  if (!config.databaseUrl) throw new Error("DATABASE_URL wajib diisi.");
  const pool = new Pool({ connectionString: config.databaseUrl });
  try {
    const applied = await migrate(pool, console.log);
    if (cmd === "migrate") {
      console.log(applied.length ? `${applied.length} migrasi diterapkan.` : "Skema sudah terbaru.");
      return;
    }
    const store = createPgStore(pool);
    const password = process.env.NEW_ADMIN_PASSWORD ?? "";
    if (cmd === "admin:create") {
      const [email, name = "Administrator", role = "admin"] = args;
      if (!email) throw new Error('Pemakaian: admin:create <email> ["Nama"] [admin|editor]');
      if (role !== "admin" && role !== "editor") throw new Error("Peran harus admin atau editor.");
      if (password.length < PASSWORD_MIN) throw new Error(`Isi NEW_ADMIN_PASSWORD (minimal ${PASSWORD_MIN} karakter).`);
      if (await store.admins.byEmail(email)) throw new Error("Email sudah terdaftar.");
      await store.admins.create({ email, name, role, passwordHash: await hashPassword(password), active: true });
      console.log(`Admin ${email} (${role}) dibuat.`);
    } else if (cmd === "admin:reset-password") {
      const [email] = args;
      const u = email ? await store.admins.byEmail(email) : null;
      if (!u) throw new Error("Admin tidak ditemukan.");
      if (password.length < PASSWORD_MIN) throw new Error(`Isi NEW_ADMIN_PASSWORD (minimal ${PASSWORD_MIN} karakter).`);
      await store.admins.update(u.id, { passwordHash: await hashPassword(password), active: true });
      console.log(`Kata sandi ${email} diganti.`);
    } else {
      throw new Error(`Perintah tidak dikenal: ${cmd ?? "(kosong)"}`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
