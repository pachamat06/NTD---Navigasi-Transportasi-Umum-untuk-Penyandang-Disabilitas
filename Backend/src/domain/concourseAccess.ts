// Akses peron yang diturunkan dari concourse: bila ruas concourse → peron sudah diisi (lift, eskalator, ramp, ...),
// informasi itu otomatis menjadi informasi akses peron yang bersangkutan, tanpa diisi dua kali. Isian tim pada data
// peron (dan dataset) selalu menang per field; turunan hanya mengisi field yang masih kosong, dan peron ditandai
// `accessFromConcourse` agar jelas mana yang otomatis.

import type { AmenityDetailStatus, Concourse, ConcoursePlatformLink, EscalatorGroup, LiftInfo, Platform, PlatformDerivedField } from "./models";

const STATUS_ORDER: Record<AmenityDetailStatus, number> = { out_of_service: 0, absent: 1, unknown: 2, available: 3 };

/** Status terbaik di antara beberapa ruas: ada satu jalur yang berfungsi berarti peron itu punya fasilitasnya. */
const best = (list: AmenityDetailStatus[]): AmenityDetailStatus => list.reduce((a, b) => (STATUS_ORDER[b] > STATUS_ORDER[a] ? b : a));

const label = (c: Concourse) => `concourse ${c.name ?? c.code}`;

interface Link {
  c: Concourse;
  l: ConcoursePlatformLink;
}

/** Lift pada ruas: tercantum di `means` atau dicatat jumlahnya; jumlah 0 berarti tidak ada (tidak diturunkan). */
const hasLift = (l: ConcoursePlatformLink) => l.lift?.count !== 0 && (l.means.includes("lift") || (l.lift?.count ?? 0) > 0);

const liftStatus = (l: ConcoursePlatformLink): AmenityDetailStatus => l.lift?.status ?? "available";

const escalatorStatus = (l: ConcoursePlatformLink): AmenityDetailStatus => {
  const groups = l.escalators ?? [];
  if (!groups.length || groups.some((g) => !g.status || g.status === "available")) return "available";
  return best(groups.map((g) => g.status!));
};

/** Satu peron: field yang dapat diturunkan dari ruas concourse yang menuju ke sana. */
interface Derived {
  amenities: Partial<Record<"lift" | "eskalator" | "ramp", AmenityDetailStatus>>;
  lift?: LiftInfo;
  escalators?: EscalatorGroup[];
  from: NonNullable<Platform["accessFromConcourse"]>["from"];
}

/**
 * Hanya fakta yang dicatat yang diturunkan: lift/eskalator/ramp yang tercantum pada ruas. Ruas yang tidak mencantumkan
 * lift tidak berarti peron tidak punya lift (bisa ada jalur lain), jadi tidak pernah menghasilkan "tidak ada".
 */
function derive(links: Link[]): Derived | undefined {
  if (!links.length) return undefined;
  const out: Derived = { amenities: {}, from: links.map(({ c, l }) => ({ concourse: c.code, ...(c.name ? { name: c.name } : {}), means: l.means })) };

  const lifts = links.filter(({ l }) => hasLift(l));
  if (lifts.length) {
    out.amenities.lift = best(lifts.map(({ l }) => liftStatus(l)));
    const counted = lifts.filter(({ l }) => l.lift && l.lift.count > 0);
    if (counted.length) {
      const connects = counted.map(({ c, l }) => l.lift!.connects ?? `${label(c)} – peron`).join("; ");
      out.lift = { count: counted.reduce((n, { l }) => n + l.lift!.count, 0), connects, status: best(counted.map(({ l }) => liftStatus(l))) };
    }
  }

  const escs = links.filter(({ l }) => l.means.includes("eskalator"));
  if (escs.length) {
    out.amenities.eskalator = best(escs.map(({ l }) => escalatorStatus(l)));
    const groups = escs.flatMap(({ c, l }) => (l.escalators ?? []).map((g) => ({ ...g, connects: g.connects ?? `${label(c)} – peron` })));
    if (groups.length) out.escalators = groups;
  }

  if (links.some(({ l }) => l.means.includes("ramp"))) out.amenities.ramp = "available";
  return out;
}

/** Ruas concourse yang menuju peron `code`, dari semua concourse stasiun. */
const linksTo = (concourses: Concourse[], code: string): Link[] => concourses.flatMap((c) => c.platformLinks.filter((l) => l.platform === code).map((l) => ({ c, l })));

/**
 * Melengkapi peron dengan akses dari concourse. Field yang sudah terisi (dataset atau tim) tidak diubah. Peron yang
 * hanya disebut di concourse dan belum ada di data dibuat kosong supaya aksesnya tetap tampil.
 */
export function applyConcourseAccess(platforms: Platform[], concourses: Concourse[]): Platform[] {
  if (!concourses.length) return platforms;
  const codes = [...new Set(concourses.flatMap((c) => c.platformLinks.map((l) => l.platform)))];
  if (!codes.length) return platforms;
  const known = new Set(platforms.map((p) => p.code));
  const all: Platform[] = [...platforms, ...codes.filter((c) => !known.has(c)).map((code): Platform => ({ code, serves: [], amenities: {}, source: "ntd" }))];
  const byCode = new Map(codes.map((code) => [code, derive(linksTo(concourses, code))] as const));
  const out = all.map((p) => {
    const d = byCode.get(p.code);
    if (!d) return p;
    const fields: PlatformDerivedField[] = [];
    const amenities = { ...p.amenities };
    for (const k of ["lift", "eskalator", "ramp"] as const) {
      if (d.amenities[k] && !amenities[k]) {
        amenities[k] = d.amenities[k];
        fields.push(k);
      }
    }
    // Jumlah dan lokasi lift hanya diturunkan bila isian peron tidak menyatakan lift tidak ada/tidak berfungsi.
    const liftOk = !p.amenities.lift || p.amenities.lift === "available";
    const lift = !p.lift && d.lift && liftOk ? d.lift : p.lift;
    if (lift !== p.lift) fields.push("liftInfo");
    const escalators = !p.escalators?.length && d.escalators && (!p.amenities.eskalator || p.amenities.eskalator === "available") ? d.escalators : p.escalators;
    if (escalators !== p.escalators) fields.push("escalators");
    if (!fields.length) return p;
    return { ...p, amenities, ...(lift ? { lift } : {}), ...(escalators ? { escalators } : {}), accessFromConcourse: { fields, from: d.from } };
  });
  return out.sort((a, b) => a.code.localeCompare(b.code, "id", { numeric: true }));
}
