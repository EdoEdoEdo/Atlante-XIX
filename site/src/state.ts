// Stato dell'esploratore e sincronizzazione con l'indirizzo della pagina

import { AULA, D, type Aula } from "./data.js";
import { fromIso, iso } from "./util.js";

export type View = "hemi" | "map" | "vote";
export type Lens = "groups" | "presence" | "dissent" | "cross" | "changes" | "sim";
export type Base = "cont" | "all";
export type Filter = "all" | "cont" | "finale" | "fiducia" | "segreta" | "respinta" | "stretto";
export type Card =
  | { type: "home" }
  | { type: "dep"; i: number }
  | { type: "vote"; v: number }
  | { type: "day"; d: number }
  | { type: "cmp"; a: number; b: number }
  | { type: "group"; g: string }
  | { type: "list"; kicker: string; title: string; sub: string; items: ListItem[] }
  | { type: "simpick" };
export interface ListItem {
  act: string;
  data: string;
  label: string;
  small: string;
  dot?: string;
}

export interface State {
  mode: "loading" | "intro" | "app";
  view: View;
  lens: Lens;
  base: Base;
  period: [string, string] | null; // AAAAMMGG inclusi
  vote: number | null;
  dep: number | null;
  cmp: [number, number] | null;
  filter: Filter;
  hl: Set<number> | null;
  hlLabel: string;
  panel: "stage" | "table";
  pick: "cmp" | "sim" | null;
  card: Card;
  hist: Card[];
}

export const S: State = {
  mode: "loading", view: "map", lens: "groups", base: "cont", period: null, vote: null, dep: null, cmp: null,
  filter: "all", hl: null, hlLabel: "", panel: "stage", pick: null, card: { type: "home" }, hist: [],
};

const VIEW_IT: Record<View, string> = { hemi: "emiciclo", map: "mappa", vote: "voto" };
const LENS_IT: Record<Lens, string> = { groups: "gruppi", presence: "presenza", dissent: "dissenso", cross: "trasversalita", changes: "cambi", sim: "somiglianza" };
const inv = <K extends string>(o: Record<K, string>): Record<string, K> =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [v, k])) as Record<string, K>;
const VIEW_FROM = inv(VIEW_IT);
const LENS_FROM = inv(LENS_IT);
const FILTERS: Filter[] = ["all", "cont", "finale", "fiducia", "segreta", "respinta", "stretto"];

export function stateQuery(): string {
  const q = new URLSearchParams();
  if (AULA === "senato") q.set("aula", "senato");
  q.set("vista", VIEW_IT[S.view]);
  if (S.lens !== "groups") q.set("lente", LENS_IT[S.lens]);
  if (S.base !== "cont") q.set("base", "tutte");
  if (S.period) {
    q.set("da", iso(S.period[0]));
    q.set("a", iso(S.period[1]));
  }
  if (S.filter !== "all") q.set("f", S.filter);
  if (S.vote != null) q.set("v", D.votes[S.vote].id);
  if (S.cmp) q.set("confronto", `${D.deputies[S.cmp[0]].id},${D.deputies[S.cmp[1]].id}`);
  else if (S.dep != null) q.set("d", D.deputies[S.dep].id);
  return q.toString();
}

export function syncURL(): void {
  if (S.mode !== "app") return;
  try {
    history.replaceState(null, "", `${location.pathname}?${stateQuery()}`);
  } catch {
    /* indirizzo non modificabile: nessun problema */
  }
}

export function shareURL(): string {
  return `${location.origin}${location.pathname}?${stateQuery()}`;
}

/** legge lo stato dall'indirizzo; restituisce true se c'era uno stato da ripristinare */
/** aula chiesta dall'indirizzo (?aula=senato) */
export function urlAula(): Aula {
  try {
    return new URLSearchParams(location.search).get("aula") === "senato" ? "senato" : "camera";
  } catch {
    return "camera";
  }
}

export function readURL(): boolean {
  let q: URLSearchParams;
  try {
    q = new URLSearchParams(location.search);
  } catch {
    return false;
  }
  if (!["aula", "vista", "d", "v", "confronto", "lente"].some((k) => q.has(k))) return false;
  const vista = q.get("vista");
  if (vista && VIEW_FROM[vista]) S.view = VIEW_FROM[vista];
  const lente = q.get("lente");
  if (lente && LENS_FROM[lente]) S.lens = LENS_FROM[lente];
  if (q.get("base") === "tutte") S.base = "all";
  const f = q.get("f") as Filter | null;
  if (f && FILTERS.includes(f)) S.filter = f;
  const da = q.get("da"), a = q.get("a");
  if (da && a && /^\d{4}-\d{2}-\d{2}$/.test(da) && /^\d{4}-\d{2}-\d{2}$/.test(a)) S.period = [fromIso(da), fromIso(a)];
  const v = q.get("v");
  if (v && D.vById.has(v)) {
    S.vote = D.vById.get(v)!;
    S.card = { type: "vote", v: S.vote };
  }
  const byId = (id: string) => D.deputies.findIndex((d) => d.id === id);
  const cf = (q.get("confronto") || "").split(",").map(byId);
  if (cf.length === 2 && cf[0] >= 0 && cf[1] >= 0) {
    S.cmp = [cf[0], cf[1]];
    S.dep = cf[0];
    S.card = { type: "cmp", a: cf[0], b: cf[1] };
  } else {
    const d = q.get("d");
    const i = d ? byId(d) : -1;
    if (i >= 0) {
      S.dep = i;
      S.card = { type: "dep", i };
    }
  }
  return true;
}
