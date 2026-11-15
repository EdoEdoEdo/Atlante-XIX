// Disposizioni dei punti: emiciclo, mappa dei voti, colonne di una votazione

import { AULA, D, groupAt, inOffice, type Aula } from "./data.js";
import type { Vote, XY } from "./types.js";
import { clamp, ymdMs } from "./util.js";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// ---------------------------------------------------------------- emiciclo

export interface Hemi {
  pos: Map<number, [number, number, number]>; // angolo, x, y
  r: number;
  cx: number;
  cy: number;
  Rmax: number;
  R0: number;
}

/** deputati in carica in una data, ordinati per gruppo (posizione media sulla mappa) e poi per posizione individuale */
export function hemiIds(date: string): number[] {
  const ord = (g: string | null) => (g && D.G[g] ? D.G[g].ordine : 99);
  const mx = (i: number) => D.deputies[i].xy?.[0] ?? 0.5;
  return D.deputies
    .filter((d) => inOffice(d, date))
    .map((d) => ({ i: d.i, g: groupAt(d, date) }))
    .sort((a, b) => ord(a.g) - ord(b.g) || mx(a.i) - mx(b.i) || a.i - b.i)
    .map((x) => x.i);
}

export function hemiLayout(R: Rect, ids: number[]): Hemi {
  const n = ids.length;
  const rows = n > 300 ? 12 : n > 150 ? 9 : n > 60 ? 7 : 5;
  const cx = R.x + R.w / 2, cy = R.y + R.h * 0.92;
  const Rmax = Math.min(R.w * 0.47, R.h * 0.86), R0 = Rmax * 0.36;
  const radii: number[] = [];
  for (let k = 0; k < rows; k++) radii.push(R0 + ((Rmax - R0) * k) / (rows - 1));
  const tot = radii.reduce((a, b) => a + b, 0);
  const slots: [number, number, number][] = [];
  radii.forEach((r) => {
    const m = Math.round((n * r) / tot);
    for (let j = 0; j < m; j++) {
      const a = Math.PI * (1 - (j + 0.5) / m);
      slots.push([a, cx + r * Math.cos(a), cy - r * Math.sin(a)]);
    }
  });
  while (slots.length < n) slots.push(slots[slots.length - 1]);
  slots.length = n;
  slots.sort((p, q) => q[0] - p[0]);
  const pos = new Map<number, [number, number, number]>();
  ids.forEach((i, k) => pos.set(i, slots[k]));
  const dr = (Rmax - R0) / (rows - 1);
  return { pos, r: clamp(dr * 0.37, 1.6, 5.4), cx, cy, Rmax, R0 };
}

// ---------------------------------------------------------------- mappa

export const GRID_COLS = "ABCDEFGHJK";
export const GRID_ROWS = 8;
const BOX = { x0: 0.04, x1: 0.96, y0: 0.06, y1: 0.94 };

export interface MapFrame {
  ox: number;
  oy: number;
  w: number;
  h: number;
  X: (x: number) => number;
  Y: (y: number) => number;
}
export function mapFrame(R: Rect): MapFrame {
  const bw = BOX.x1 - BOX.x0, bh = BOX.y1 - BOX.y0;
  const pad = R.w < 500 ? 12 : 30;
  const sc = Math.min((R.w - 2 * pad) / bw, (R.h - 2 * pad - 12) / bh);
  const ox = R.x + (R.w - bw * sc) / 2, oy = R.y + (R.h - bh * sc) / 2 + 4;
  return { ox, oy, w: bw * sc, h: bh * sc, X: (x) => ox + (x - BOX.x0) * sc, Y: (y) => oy + (y - BOX.y0) * sc };
}
export function gridRef(p: XY): string {
  if (!p) return "—";
  const c = clamp(Math.floor(((p[0] - BOX.x0) / (BOX.x1 - BOX.x0)) * 10), 0, 9);
  const r = clamp(Math.floor(((p[1] - BOX.y0) / (BOX.y1 - BOX.y0)) * GRID_ROWS), 0, GRID_ROWS - 1);
  return GRID_COLS[c] + (r + 1);
}

/** riporta dentro la cornice i pochi punti oltre il bordo, comprimendoli nell'ultimo margine */
function soft(v: number, lo: number, hi: number, m = 0.03): number {
  if (v > hi - m) return hi - m + m * Math.tanh((v - (hi - m)) / m);
  if (v < lo + m) return lo + m - m * Math.tanh((lo + m - v) / m);
  return v;
}

/**
 * Scosta i punti quanto basta perché non si sovrappongano (collisioni con una debole attrazione
 * verso la posizione vera, che si spegne a metà). I blocchi che votano compatti diventano macchie
 * leggibili e cliccabili invece di un unico grumo.
 */
export function declutter(P: [number, number][], r: number, iters = 200): [number, number][] {
  const n = P.length;
  const X = new Float64Array(n), Y = new Float64Array(n), TX = new Float64Array(n), TY = new Float64Array(n);
  P.forEach((p, i) => {
    X[i] = TX[i] = p[0];
    Y[i] = TY[i] = p[1];
  });
  const d = 2 * r + Math.max(0.7, r * 0.3), d2 = d * d;
  const grid = new Map<number, number[]>();
  for (let it = 0; it < iters; it++) {
    const u = it / iters;
    const pull = u < 0.6 ? 0.03 * (1 - u / 0.6) ** 2 : 0, str = u < 0.6 ? 0.6 : 0.9;
    grid.clear();
    for (let i = 0; i < n; i++) {
      const k = Math.floor(X[i] / d) * 65536 + Math.floor(Y[i] / d);
      const a = grid.get(k);
      if (a) a.push(i);
      else grid.set(k, [i]);
    }
    let moved = false;
    for (let i = 0; i < n; i++) {
      const gx = Math.floor(X[i] / d), gy = Math.floor(Y[i] / d);
      for (let ox = -1; ox <= 1; ox++)
        for (let oy = -1; oy <= 1; oy++) {
          const a = grid.get((gx + ox) * 65536 + gy + oy);
          if (!a) continue;
          for (const j of a) {
            if (j <= i) continue;
            let dx = X[j] - X[i], dy = Y[j] - Y[i], l2 = dx * dx + dy * dy;
            if (l2 >= d2) continue;
            if (l2 < 1e-6) {
              const ang = (i * 2.399 + j * 0.7) % 6.283;
              dx = Math.cos(ang) * 0.01;
              dy = Math.sin(ang) * 0.01;
              l2 = 1e-4;
            }
            const l = Math.sqrt(l2), m = ((d - l) / l) * 0.5 * str;
            X[i] -= dx * m;
            Y[i] -= dy * m;
            X[j] += dx * m;
            Y[j] += dy * m;
            moved = true;
          }
        }
    }
    if (pull)
      for (let i = 0; i < n; i++) {
        X[i] += (TX[i] - X[i]) * pull;
        Y[i] += (TY[i] - Y[i]) * pull;
      }
    else if (!moved) break;
  }
  return P.map((_p, i) => [X[i], Y[i]]);
}

const pixCache = new Map<string, ([number, number] | null)[]>();
/** posizioni in pixel sulla tavola II, senza sovrapposizioni (calcolate una volta per cornice) */
export function mapPixels(F: MapFrame, pts: XY[], r: number): ([number, number] | null)[] {
  const key = `${frameId(pts)}|${F.ox.toFixed(1)}|${F.oy.toFixed(1)}|${F.w.toFixed(1)}|${r.toFixed(2)}`;
  const hit = pixCache.get(key);
  if (hit) return hit;
  const idx: number[] = [];
  const P: [number, number][] = [];
  pts.forEach((p, i) => {
    if (!p) return;
    idx.push(i);
    P.push([F.X(soft(p[0], BOX.x0, BOX.x1)), F.Y(soft(p[1], BOX.y0, BOX.y1))]);
  });
  const Q = declutter(P, r);
  const out: ([number, number] | null)[] = pts.map(() => null);
  idx.forEach((i, k) => (out[i] = Q[k]));
  if (pixCache.size > 120) pixCache.delete(pixCache.keys().next().value!);
  pixCache.set(key, out);
  return out;
}
const ids = new WeakMap<XY[], number>();
let nextId = 1;
function frameId(pts: XY[]): number {
  let k = ids.get(pts);
  if (!k) ids.set(pts, (k = nextId++));
  return k;
}

/** percorso di chi ha cambiato gruppo: posizione mediana sulla mappa in ogni periodo di appartenenza */
type Trail = { i: number; nodes: [number, number][]; groups: string[] };
const trailCaches: Partial<Record<Aula, Trail[]>> = {};
export function trailNodes(): { i: number; nodes: [number, number][]; groups: string[] }[] {
  const hit = trailCaches[AULA];
  if (hit) return hit;
  const trailCache: Trail[] = (trailCaches[AULA] = []);
  const M = D.map;
  const med = (a: number[]) => {
    const s = a.slice().sort((p, q) => p - q);
    return s[s.length >> 1];
  };
  for (const d of D.deputies) {
    if (!d.cambi.some((c) => c.tipo !== "componente")) continue;
    const nodes: [number, number][] = [], groups: string[] = [];
    for (const g of d.gruppi) {
      const a = g.da.slice(0, 6), b = (g.a || "99999999").slice(0, 6);
      const xs: number[] = [], ys: number[] = [];
      M.mesi.forEach((m, k) => {
        const p = M.mensili[k]?.[d.i];
        if (p && m >= a && m <= b) {
          xs.push(p[0]);
          ys.push(p[1]);
        }
      });
      if (!xs.length) continue;
      const pt: [number, number] = [soft(med(xs), BOX.x0, BOX.x1), soft(med(ys), BOX.y0, BOX.y1)];
      const last = nodes[nodes.length - 1];
      if (last && Math.hypot(last[0] - pt[0], last[1] - pt[1]) < 0.004) continue;
      nodes.push(pt);
      groups.push(g.g);
    }
    if (nodes.length >= 2) trailCache.push({ i: d.i, nodes, groups });
  }
  return trailCache;
}

/** posizioni della mappa per il periodo scelto: mappa mensile, annuale o complessiva più vicina */
export function mapPositions(period: [string, string] | null): { pts: XY[]; label: string } {
  const M = D.map;
  if (!period) return { pts: M.complessiva, label: "tutta la legislatura" };
  const days = (ymdMs(period[1]) - ymdMs(period[0])) / 86_400_000;
  if (days <= 100) {
    const mid = (ymdMs(period[0]) + ymdMs(period[1])) / 2;
    const d = new Date(mid);
    const key = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    const k = M.mesi.indexOf(key);
    const pts = k >= 0 ? M.mensili[k] : null;
    if (pts) return { pts, label: "tre mesi intorno al periodo" };
  }
  // anno con la sovrapposizione maggiore
  const spans: [string, string, string][] = [["2022-23", "20221001", "20231231"], ["2024", "20240101", "20241231"], ["2025", "20250101", "20251231"], ["2026", "20260101", "20261231"]];
  let best = "", bo = 0;
  for (const [k, a, b] of spans) {
    const o = Math.min(ymdMs(b), ymdMs(period[1])) - Math.max(ymdMs(a), ymdMs(period[0]));
    if (o > bo) {
      bo = o;
      best = k;
    }
  }
  const tot = ymdMs(period[1]) - ymdMs(period[0]);
  if (best && M.anni[best] && bo >= 0.6 * tot) return { pts: M.anni[best]!, label: `mappa ${best}` };
  return { pts: M.complessiva, label: "tutta la legislatura" };
}

// ---------------------------------------------------------------- una votazione in colonne

/** colonne della vista Voto: al Senato c'è anche chi era presente senza votare */
export const COLS = (): string[] => (AULA === "senato" ? ["F", "C", "A", "V", "N", "M"] : ["F", "C", "A", "N", "M"]);
export function colLabel(k: string, short = false): string {
  const sen = AULA === "senato";
  const L: Record<string, [string, string]> = {
    F: ["Favorevoli", "FAV."], C: ["Contrari", "CONTR."], A: ["Astenuti", "ASTEN."], V: ["Presenti non votanti", "PRES. N.V."],
    N: [sen ? "Assenti" : "Non hanno partecipato", sen ? "ASSENTI" : "NON PART."], M: [sen ? "In congedo o missione" : "In missione", sen ? "CONG./MISS." : "MISS."],
  };
  return L[k]?.[short ? 1 : 0] ?? k;
}

export interface VoteLay {
  pos: Map<number, [number, number]>;
  r: number;
  cols: Record<string, number[]>;
  xs: number[];
  base: number;
}
export function voteLayout(R: Rect, v: Vote, row: string): VoteLay {
  const K = COLS();
  const cols: Record<string, number[]> = Object.fromEntries(K.map((k) => [k, [] as number[]]));
  for (let j = 0; j < D.N; j++) {
    const ch = row.charAt(j);
    if (ch === "-" || ch === "S") continue;
    (ch === "P" ? cols.N : (cols[ch] ?? cols.N))?.push(j);
  }
  const ord = (i: number) => {
    const g = groupAt(D.deputies[i], v.data);
    return g && D.G[g] ? D.G[g].ordine : 99;
  };
  for (const k in cols) cols[k].sort((a, b) => ord(a) - ord(b) || a - b);
  const xs = K.map((_k, j) => (j + 0.5) / K.length);
  const small = R.h < 380;
  const base = R.y + R.h - (small ? 46 : 64), top = R.y + (small ? 44 : 64);
  const avail = base - top, cw = (R.w * 0.85) / K.length;
  const mx = Math.max(...K.map((k) => cols[k].length), 1);
  let s = 13;
  for (; s > 3; s -= 0.2) {
    const c = Math.max(1, Math.floor(cw / s));
    if (Math.ceil(mx / c) * s <= avail) break;
  }
  const nc = Math.max(1, Math.floor(cw / s));
  const pos = new Map<number, [number, number]>();
  K.forEach((k, j) => {
    const x0 = R.x + R.w * xs[j];
    cols[k].forEach((i, q) => pos.set(i, [x0 + ((q % nc) - (nc - 1) / 2) * s, base - Math.floor(q / nc) * s - s / 2]));
  });
  return { pos, r: s * 0.38, cols, xs, base };
}
