// Caricamento e strutture derivate dei dati

import type { Day, Deputy, DeputyFile, Group, Intro, MapData, Meta, MonthFile, MonthlyMetrics, Vote } from "./types.js";
import { decodeEntities, hex2rgb, nz, ymdMs } from "./util.js";

// ---------------------------------------------------------------- le due aule

export type Aula = "camera" | "senato";
/** aula attiva: tutte le funzioni lavorano sui suoi dati */
export let AULA: Aula = "camera";
const store: Partial<Record<Aula, Data>> = {};
export const isLoaded = (a: Aula): boolean => !!store[a];
/** rende attiva un'aula già caricata */
export function useAula(a: Aula): void {
  const d = store[a];
  if (!d) throw new Error(`Dati di ${a} non caricati`);
  AULA = a;
  D = d;
}

/** le parole che cambiano tra Camera e Senato */
export interface Words {
  aula: string;
  aulaLunga: string;
  membro: string;
  membri: string;
  Membro: string;
  Membri: string;
  membroF: string;
  MembroF: string;
  presidente: string;
  dellaAula: string;
  atto: string;
  attoLungo: string;
  missione: string;
  missioni: string;
  fonte: string;
  sito: string;
}
export const WORDS: Record<Aula, Words> = {
  camera: {
    aula: "Camera", aulaLunga: "Camera dei Deputati", membro: "deputato", membri: "deputati", Membro: "Deputato", Membri: "Deputati",
    membroF: "deputata", MembroF: "Deputata", presidente: "Presidente della Camera", dellaAula: "della Camera", atto: "AC", attoLungo: "Atto Camera",
    missione: "In missione", missioni: "missioni", fonte: "Camera dei Deputati — dati.camera.it", sito: "dati.camera.it",
  },
  senato: {
    aula: "Senato", aulaLunga: "Senato della Repubblica", membro: "senatore", membri: "senatori", Membro: "Senatore", Membri: "Senatori",
    membroF: "senatrice", MembroF: "Senatrice", presidente: "Presidente del Senato", dellaAula: "del Senato", atto: "S.", attoLungo: "Atto Senato",
    missione: "In congedo o missione", missioni: "congedi e missioni", fonte: "Senato della Repubblica — dati.senato.it", sito: "dati.senato.it",
  },
};
export const W = (): Words => WORDS[AULA];
/** come ha votato, da un carattere della matrice */
export function codeLabel(ch: string): string {
  const sen = AULA === "senato";
  const L: Record<string, string> = {
    F: "Favorevole", C: "Contrario", A: "Astensione", V: "Presente non votante", N: sen ? "Assente" : "Non ha partecipato",
    M: W().missione, P: "Presidente di turno", "-": "Non in carica", S: "Voto segreto",
  };
  return L[ch] ?? "";
}
/** "deputato" o "deputata", "senatore" o "senatrice" */
export const memberWord = (d: Deputy, cap = false): string =>
  d.genere === "F" || d.genere === "female" ? (cap ? W().MembroF : W().membroF) : cap ? W().Membro : W().membro;

export interface Data {
  meta: Meta;
  groups: Group[];
  G: Record<string, Group>;
  vgroups: string[]; // ordine dei gruppi nella stringa "gruppi" delle votazioni
  deputies: Deputy[];
  votes: Vote[];
  vById: Map<string, number>;
  days: Day[];
  types: string[];
  map: MapData;
  intro: Intro;
  T0: number;
  T1: number;
  N: number;
  V: number;
  president: number;
}

export let D: Data;

// ---------------------------------------------------------------- caricamento con avanzamento

async function fetchJSON<T>(name: string, onBytes?: (n: number) => void, aula: Aula = AULA): Promise<T> {
  const res = await fetch(`data/${aula}/${name}`, { cache: "no-cache" });
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  if (!onBytes || !res.body) return res.json() as Promise<T>;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let len = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    len += value.length;
    onBytes(value.length);
  }
  const all = new Uint8Array(len);
  let o = 0;
  for (const c of chunks) {
    all.set(c, o);
    o += c.length;
  }
  return JSON.parse(new TextDecoder().decode(all)) as T;
}

/** Carica tutto quello che serve all'apertura. onProgress riceve un valore in [0,1]. */
export async function loadAll(onProgress: (p: number) => void, aula: Aula = "camera"): Promise<Data> {
  const hit = store[aula];
  if (hit) {
    onProgress(1);
    return hit;
  }
  const meta = await fetchJSON<Meta>("meta.json", undefined, aula);
  const introMeta0 = 350_000;
  const sizes = { ...meta.pesi };
  const total = Object.values(sizes).reduce((a, b) => a + b, 0) + introMeta0;
  let got = 0;
  const bump = (n: number) => {
    got += n;
    onProgress(Math.min(0.999, got / total));
  };
  const [groupsRaw, deputiesRaw, map, vi, intro] = await Promise.all([
    fetchJSON<Omit<Group, "rgb" | "k">[]>("groups.json", bump, aula),
    fetchJSON<Omit<Deputy, "name" | "nz" | "gov" | "president">[]>("deputies.json", bump, aula),
    fetchJSON<MapData>("map.json", bump, aula),
    fetchJSON<{ campi: string[]; tipi: string[]; gruppi: string[]; righe: unknown[][] }>("votes_index.json", bump, aula),
    fetchJSON<Intro>("intro.json", bump, aula),
  ]);
  // il mese del voto dell'intro: serve subito per la terza schermata (solo Camera)
  const introMonth = aula === "camera" && intro.voto ? monthKeyOf(intro.data) : "";
  if (introMonth) await loadMonth(introMonth, bump, aula);
  onProgress(1);

  const groups: Group[] = groupsRaw.map((g, k) => ({ ...g, rgb: hex2rgb(g.colore), k }));
  const G = Object.fromEntries(groups.map((g) => [g.id, g]));
  const deputies: Deputy[] = deputiesRaw.map((d) => {
    const name = `${d.nome} ${d.cognome}`;
    const president = d.ruoli.some((r) => r.ruolo === WORDS[aula].presidente);
    return { ...d, name, nz: nz(name), president, gov: d.ruoli.some((r) => r.ruolo !== WORDS[aula].presidente) };
  });
  const votes: Vote[] = [];
  const vById = new Map<string, number>();
  for (const r of vi.righe) {
    const [id, data, tipo, titolo, atto, flag, F, C, A, presenti, esito, margine, contesa, gruppi, dissensi, stato] = r as [
      string, string, number, string, string, number, number, number, number, number, number, number, number, string, number, number,
    ];
    const m = /^(?:vs)?19[_-](\d+)[_-](\d+)/.exec(id);
    const v: Vote = {
      i: votes.length, id, data, tipo: vi.tipi[tipo], titolo: decodeEntities(titolo), atto, flag, F, C, A, presenti, esito,
      margine, contesa, gruppi, dissensi, stato, seduta: m ? +m[1] : 0, n: m ? +m[2] : 0, t: 0, day: 0,
    };
    vById.set(id, v.i);
    votes.push(v);
  }
  const T0 = ymdMs(votes[0].data);
  const T1 = ymdMs(votes[votes.length - 1].data) + 86_400_000;
  const days: Day[] = [];
  for (const v of votes) {
    v.t = (ymdMs(v.data) + 43_200_000 - T0) / (T1 - T0);
    const last = days[days.length - 1];
    if (!last || last.data !== v.data) days.push({ i: days.length, data: v.data, v0: v.i, v1: v.i + 1, seduta: v.seduta, t: v.t });
    else last.v1 = v.i + 1;
    v.day = days.length - 1;
  }
  const president = Math.max(0, deputies.findIndex((d) => d.president));
  const data: Data = {
    meta, groups, G, vgroups: vi.gruppi, deputies, votes, vById, days, types: vi.tipi, map, intro,
    T0, T1, N: deputies.length, V: votes.length, president,
  };
  store[aula] = data;
  if (aula === AULA) D = data;
  return data;
}

// ---------------------------------------------------------------- file caricati su richiesta

const months = new Map<string, MonthFile>();
const monthWait = new Map<string, Promise<MonthFile>>();
export const monthKeyOf = (date: string): string => `${date.slice(0, 4)}-${date.slice(4, 6)}`;

export function loadMonth(key: string, onBytes?: (n: number) => void, aula: Aula = AULA): Promise<MonthFile> {
  const k = `${aula}/${key}`;
  const hit = months.get(k);
  if (hit) return Promise.resolve(hit);
  let p = monthWait.get(k);
  if (!p) {
    p = fetchJSON<MonthFile>(`votes/${key}.json`, onBytes, aula).then((m) => {
      months.set(k, m);
      return m;
    });
    monthWait.set(k, p);
  }
  return p;
}
export function monthOf(v: Vote): MonthFile | undefined {
  return months.get(`${AULA}/${monthKeyOf(v.data)}`);
}
/** riga di voti della votazione (un carattere per deputato), se il mese è in memoria */
export function voteRow(v: Vote): string | null {
  const m = monthOf(v);
  if (!m) return null;
  const k = m.ids.indexOf(v.id);
  return k >= 0 ? m.voti[k] : null;
}
export interface VoteExtra {
  descrizione: string;
  scheda: string;
  ddl: string[];
  votanti: number | null;
  maggioranza: number | null;
}

export function voteExtra(v: Vote): VoteExtra {
  const m = monthOf(v);
  const k = m ? m.ids.indexOf(v.id) : -1;
  return k >= 0 && m
    ? {
        descrizione: decodeEntities(m.descrizioni[k] || ""),
        scheda: m.schede[k] || "",
        ddl: (m.ddl?.[k] || "").split(" ").filter(Boolean),
        votanti: m.votanti?.[k] ?? null,
        maggioranza: m.maggioranze?.[k] ?? null,
      }
    : { descrizione: "", scheda: "", ddl: [], votanti: null, maggioranza: null };
}

const depFiles = new Map<string, DeputyFile>();
const depWait = new Map<string, Promise<DeputyFile>>();
export function loadDeputy(i: number): Promise<DeputyFile> {
  const id = `${AULA}/${D.deputies[i].id}`;
  const hit = depFiles.get(id);
  if (hit) return Promise.resolve(hit);
  let p = depWait.get(id);
  if (!p) {
    p = fetchJSON<DeputyFile>(`deputati/${D.deputies[i].id}.json`).then((f) => {
      depFiles.set(id, f);
      return f;
    });
    depWait.set(id, p);
  }
  return p;
}
export const deputyFile = (i: number): DeputyFile | undefined => depFiles.get(`${AULA}/${D.deputies[i]?.id}`);

const monthly: Partial<Record<Aula, MonthlyMetrics>> = {};
const monthlyWait: Partial<Record<Aula, Promise<MonthlyMetrics>>> = {};
export function loadMonthly(): Promise<MonthlyMetrics> {
  const a = AULA;
  const hit = monthly[a];
  if (hit) return Promise.resolve(hit);
  return (monthlyWait[a] ??= fetchJSON<MonthlyMetrics>("metriche_mensili.json", undefined, a).then((m) => (monthly[a] = m)));
}
export const monthlyMetrics = (): MonthlyMetrics | null => monthly[AULA] ?? null;

// ---------------------------------------------------------------- deputati nel tempo

/** gruppo del deputato in una data (AAAAMMGG), dai voti */
export function groupAt(d: Deputy, date: string): string | null {
  const g = d.gruppi;
  if (!g.length) return d.gruppo;
  if (date <= g[0].da) return g[0].g;
  for (let k = 0; k < g.length; k++) {
    if (date <= g[k].a) return date >= g[k].da ? g[k].g : g[k - 1]?.g ?? g[k].g;
  }
  return g[g.length - 1].g;
}
export function inOffice(d: Deputy, date: string): boolean {
  const [a, b] = d.mandato;
  return (!a || a <= date) && (!b || date <= b);
}
export const todayKey = (): string => D.votes[D.V - 1].data;

/** lato del deputato in una data: quello del gruppo, o il suo personale se è nel Misto senza componente */
export function sideAt(d: Deputy, date: string): number {
  const g = groupAt(d, date);
  if (!g || g === "ALT") return d.lato;
  return D.G[g]?.lato ?? 0;
}

// ---------------------------------------------------------------- una votazione nel dettaglio

export const CODE = { F: 70, C: 67, A: 65, N: 78, M: 77, P: 80, NONE: 45, S: 83 } as const;

export interface VoteBreakdown {
  byGroup: Record<string, { F: number; C: number; A: number; N: number; M: number; P: number; V: number }>;
  posMaj: string;
  posOpp: string;
  dissenters: number[];
}

/** posizione (lettera) data una conta */
export function plurality(F: number, C: number, A: number): string {
  const mx = Math.max(F, C, A);
  if (!mx) return "";
  const tops = [F === mx, C === mx, A === mx].filter(Boolean).length;
  if (tops > 1) return "";
  return F === mx ? "F" : C === mx ? "C" : "A";
}

export function breakdown(v: Vote, row: string): VoteBreakdown {
  const byGroup: VoteBreakdown["byGroup"] = {};
  const side = { 1: [0, 0, 0], 2: [0, 0, 0] } as Record<number, number[]>;
  const grp: (string | null)[] = [];
  for (let j = 0; j < D.N; j++) {
    const ch = row.charAt(j);
    if (ch === "-" || ch === "S") {
      grp.push(null);
      continue;
    }
    const d = D.deputies[j];
    const g = groupAt(d, v.data) ?? "ALT";
    grp.push(g);
    const b = (byGroup[g] ??= { F: 0, C: 0, A: 0, N: 0, M: 0, P: 0, V: 0 });
    if (ch in b) b[ch as keyof typeof b]++;
    const s = sideAt(d, v.data);
    const k = "FCA".indexOf(ch);
    if (k >= 0 && (s === 1 || s === 2)) side[s][k]++;
  }
  // dissenso: voto diverso dalla posizione del proprio gruppo calcolata senza il proprio voto
  const dissenters: number[] = [];
  for (let j = 0; j < D.N; j++) {
    const g = grp[j];
    const ch = row.charAt(j);
    if (!g || D.G[g]?.misto || "FCA".indexOf(ch) < 0) continue;
    const b = byGroup[g];
    const pos = plurality(b.F - (ch === "F" ? 1 : 0), b.C - (ch === "C" ? 1 : 0), b.A - (ch === "A" ? 1 : 0));
    if (pos && pos !== ch) dissenters.push(j);
  }
  return {
    byGroup,
    posMaj: plurality(side[1][0], side[1][1], side[1][2]),
    posOpp: plurality(side[2][0], side[2][1], side[2][2]),
    dissenters,
  };
}

// ---------------------------------------------------------------- confronto tra due deputati

export interface Comparison {
  cont: [number, number];
  all: [number, number];
  monthly: { cont: (number | null)[]; all: (number | null)[] };
  split: number[];
  agree: number[];
}
export function compare(a: number, b: number, fa: DeputyFile, fb: DeputyFile): Comparison {
  const months = D.meta.mesi;
  const mIdx = new Map(months.map((m, k) => [m, k]));
  const mc = months.map(() => [0, 0]);
  const ma = months.map(() => [0, 0]);
  const r: Comparison = { cont: [0, 0], all: [0, 0], monthly: { cont: [], all: [] }, split: [], agree: [] };
  const da = D.deputies[a], db = D.deputies[b];
  for (let v = 0; v < D.V; v++) {
    const vo = D.votes[v];
    if (vo.stato !== 0) continue;
    const x = fa.barcode.charAt(v), y = fb.barcode.charAt(v);
    if ("FCA".indexOf(x) < 0 || "FCA".indexOf(y) < 0) continue;
    const e = x === y ? 1 : 0;
    const k = mIdx.get(vo.data.slice(0, 6)) ?? 0;
    r.all[0]++;
    r.all[1] += e;
    ma[k][0]++;
    ma[k][1] += e;
    if (vo.contesa) {
      r.cont[0]++;
      r.cont[1] += e;
      mc[k][0]++;
      mc[k][1] += e;
    }
    const fin = (vo.flag & 3) !== 0;
    if (fin && ((x === "F" && y === "C") || (x === "C" && y === "F"))) r.split.push(v);
    if (fin && e && vo.contesa && sideAt(da, vo.data) !== sideAt(db, vo.data)) r.agree.push(v);
  }
  r.monthly.cont = mc.map(([n, e]) => (n >= 8 ? e / n : null));
  r.monthly.all = ma.map(([n, e]) => (n >= 8 ? e / n : null));
  return r;
}

// ---------------------------------------------------------------- utilità per le votazioni

export const isFinal = (v: Vote): boolean => (v.flag & 1) !== 0;
export const isTrust = (v: Vote): boolean => (v.flag & 2) !== 0;
export const isSecret = (v: Vote): boolean => (v.flag & 4) !== 0 || v.stato === 2;
export const actLabel = (v: Vote): string => (v.atto ? `${W().atto} ` + v.atto.split(" ").map((a) => a.replace(/^0+/, "")).join(", ") : "");
export const typeLabel = (v: Vote): string => {
  if (isTrust(v)) return v.flag & 8 ? "Mozione di sfiducia" : v.tipo === "Mozione" ? "Mozione di fiducia" : "Fiducia";
  if (isFinal(v)) return "Voto finale";
  return v.tipo || "Votazione";
};
