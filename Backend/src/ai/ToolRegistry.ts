// Tool Registry (Tabel 3.8): definisi tool yang terlihat oleh agen/LLM dan penyalurannya ke layanan domain.
// NavigationAgent hanya mengakses layanan domain lewat registry ini.

import type { RequestContext } from "../context";
import type { AlternativeService } from "../domain/AlternativeService";
import type { ContentSnapshot } from "../domain/content";
import type { FacilityAnalysisService } from "../domain/FacilityAnalysisService";
import type { Alternative, Hub, Mode, Route, Station, StationAssessment, TransferNeed } from "../domain/models";
import { WALK_WEIGHT, type RoutePlannerService } from "../domain/RoutePlannerService";
import type { StationService } from "../domain/StationService";

export interface ToolSpec {
  name: string;
  description: string;
  input_schema: { type: "object"; properties: Record<string, unknown>; required: string[]; additionalProperties: false };
}

interface Tools {
  cari_stasiun: { in: { query: string }; out: Station[] };
  ambil_rute: { in: { fromId: string; toId: string; viaId?: string; at?: string; avoidModes?: Mode[]; needs?: TransferNeed[] }; out: Route | null };
  lengkapi_rute: { in: { route: Route; at?: string }; out: Route };
  cek_fasilitas: { in: { stationId: string }; out: Awaited<ReturnType<FacilityAnalysisService["assess"]>> };
  cari_alternatif: {
    in: { originId: string; destinationId: string; route: Route; assessments: Map<string, StationAssessment>; hubs: Hub[]; avoid?: string[]; at?: string; needs?: TransferNeed[] };
    out: Alternative[];
  };
}

export type ToolName = keyof Tools;

export class ToolRegistry {
  constructor(
    private deps: { stations: StationService; planner: RoutePlannerService; facilities: FacilityAnalysisService; alternatives: AlternativeService },
  ) {}

  /** Definisi tool (format JSON Schema) untuk LLM bila kelak agen memakai tool calling langsung. */
  specs(): ToolSpec[] {
    const obj = (properties: Record<string, unknown>, required: string[]): ToolSpec["input_schema"] => ({ type: "object", properties, required, additionalProperties: false });
    return [
      { name: "cari_stasiun", description: "Mencari stasiun menurut nama atau kode.", input_schema: obj({ query: { type: "string" } }, ["query"]) },
      {
        name: "ambil_rute",
        description: "Mengambil rute dari dataset antara dua stasiun beserta moda, jarak, waktu tempuh, dan tarif tiap ruas.",
        input_schema: obj(
          {
            fromId: { type: "string" },
            toId: { type: "string" },
            viaId: { type: "string" },
            avoidModes: { type: "array", items: { type: "string", enum: ["RAIL", "SUBWAY", "TRAM", "BUS", "MONORAIL"] } },
          },
          ["fromId", "toId"],
        ),
      },
      {
        name: "lengkapi_rute",
        description:
          "Melengkapi rute: jarak dan petunjuk jalan kaki saat pindah, lin paralel yang bisa dinaiki pada ruas yang sama, dan frekuensi kendaraan bila jadwal tidak tersedia (bukan jadwal).",
        input_schema: obj({ at: { type: "string" } }, []),
      },
      {
        name: "cek_fasilitas",
        description: "Memeriksa fasilitas aksesibilitas sebuah stasiun dan menghitung skornya.",
        input_schema: obj({ stationId: { type: "string" } }, ["stationId"]),
      },
      {
        name: "cari_alternatif",
        description: "Mencari transfer alternatif dalam hub yang sama bila titik transfer tidak memadai.",
        input_schema: obj({ originId: { type: "string" }, destinationId: { type: "string" } }, ["originId", "destinationId"]),
      },
    ];
  }

  async call<N extends ToolName>(name: N, input: Tools[N]["in"], ctx: RequestContext, snap: ContentSnapshot): Promise<Tools[N]["out"]> {
    const d = this.deps;
    switch (name) {
      case "cari_stasiun":
        return (await d.stations.search((input as Tools["cari_stasiun"]["in"]).query, ctx)) as Tools[N]["out"];
      case "ambil_rute": {
        const i = input as Tools["ambil_rute"]["in"];
        const route = i.viaId
          ? d.planner.getRouteVia(i.fromId, i.viaId, i.toId, ctx, i.at)
          : i.avoidModes?.length
            ? d.planner.getRouteAvoiding(i.fromId, i.toId, i.avoidModes, ctx, i.at, i.needs?.length ? WALK_WEIGHT.SLOW : WALK_WEIGHT.AVERAGE)
            : d.planner.getRoute(i.fromId, i.toId, ctx, i.at);
        return (await route) as Tools[N]["out"];
      }
      case "lengkapi_rute": {
        const i = input as Tools["lengkapi_rute"]["in"];
        return (await d.planner.annotate(i.route, ctx, i.at)) as Tools[N]["out"];
      }
      case "cek_fasilitas":
        return (await d.facilities.assess((input as Tools["cek_fasilitas"]["in"]).stationId, ctx, snap)) as Tools[N]["out"];
      case "cari_alternatif":
        return (await d.alternatives.suggest(input as Tools["cari_alternatif"]["in"], ctx, snap)) as Tools[N]["out"];
      default:
        throw new Error(`tool tidak dikenal: ${String(name)}`);
    }
  }
}
