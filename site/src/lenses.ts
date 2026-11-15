// Lenti: cosa dice il colore dei punti, e le loro legende

import { AULA, D, WORDS, deputyFile, groupAt, monthlyMetrics } from "./data.js";
import { FADE, INK, PAPER, inkAt } from "./engine.js";
import { S } from "./state.js";
import type { RGB } from "./types.js";
import { esc, pc, rgbs } from "./util.js";

export interface Met {
  T: number;
  V: number;
  N: number;
  M: number;
  DB: number;
  DD: number;
  CB: number;
  CC: number;
  pres: number | null;
  nonpart: number | null;
  mis: number | null;
  dissent: number | null;
  cross: number | null;
}

let cacheKey = "";
let cache: Met[] = [];

const ratio = (a: number, b: number, lim = 30): number | null => (b >= lim ? a / b : null);

function build(T: number, V: number, N: number, M: number, DB: number, DD: number, CB: number, CC: number): Met {
  return { T, V, N, M, DB, DD, CB, CC, pres: ratio(V, T), nonpart: ratio(N, T), mis: ratio(M, T), dissent: ratio(DD, DB), cross: ratio(CC, CB) };
}

/** metriche di tutti i deputati per il periodo scelto (mesi interi) */
export function metrics(): Met[] {
  const mm = monthlyMetrics();
  const key = AULA + (S.period && mm ? S.period.join() : "all");
  if (key === cacheKey) return cache;
  cacheKey = key;
  if (!S.period || !mm) {
    cache = D.deputies.map((d) => {
      const m = d.m;
      return build(m.votazioni, m.votati, m.nonpart, m.missioni, m.base_diss, m.dissensi, m.base_trasv, m.trasv_n);
    });
    if (!S.period || !mm) cacheKey = AULA + (S.period ? "pending" : "all");
    return cache;
  }
  const a = S.period[0].slice(0, 6), b = S.period[1].slice(0, 6);
  const ks = mm.mesi.map((m, k) => (m >= a && m <= b ? k : -1)).filter((k) => k >= 0);
  const sum = (arr: number[][], j: number) => ks.reduce((s, k) => s + arr[j][k], 0);
  cache = D.deputies.map((_d, j) =>
    build(sum(mm.votazioni, j), sum(mm.votati, j), sum(mm.nonpart, j), sum(mm.missioni, j), sum(mm.base_diss, j), sum(mm.dissensi, j), sum(mm.base_trasv, j), sum(mm.trasv, j)),
  );
  return cache;
}
export const resetMetrics = (): void => {
  cacheKey = "";
};

// ---------------------------------------------------------------- domini delle scale

export interface Domain {
  lo: number;
  hi: number;
  med: number;
  vals: number[];
}
const quant = (a: number[], q: number): number => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))))];
};
export const KEY: Record<string, keyof Met> = { presence: "pres", dissent: "dissent", cross: "cross" };
export function domain(lens: string): Domain {
  const k = KEY[lens];
  const m = metrics();
  const vals = D.deputies.filter((d) => !d.president && m[d.i][k] != null).map((d) => m[d.i][k] as number);
  return { lo: quant(vals, 0.02), hi: quant(vals, 0.98), med: quant(vals, 0.5), vals };
}

// ---------------------------------------------------------------- colore dei punti

export interface Style {
  c: RGB;
  ring: number;
  a?: number;
  rm?: number;
}
const doms: Record<string, Domain> = {};
export function refreshDomains(): void {
  for (const l of ["presence", "dissent", "cross"]) doms[l] = domain(l);
}

export function similarity(i: number, j: number): { v: number | null; n: number } {
  const f = deputyFile(i);
  if (!f) return { v: null, n: 0 };
  const arr = S.base === "cont" ? f.accordo_deputati.contese : f.accordo_deputati.tutte;
  return { v: arr[j], n: f.accordo_deputati.comuni_contese[j] };
}

export function groupColor(i: number, date: string): RGB {
  const g = groupAt(D.deputies[i], date);
  return g && D.G[g] ? D.G[g].rgb : [163, 158, 147];
}

export function dotStyle(i: number, date: string): Style {
  const d = D.deputies[i];
  const m = metrics()[i];
  switch (S.lens) {
    case "groups":
      return { c: groupColor(i, date), ring: 0 };
    case "presence":
    case "dissent":
    case "cross": {
      if (d.president) return { c: PAPER, ring: 5 };
      const val = m[KEY[S.lens]] as number | null;
      if (val == null) return { c: PAPER, ring: 3 };
      const dm = doms[S.lens];
      return { c: inkAt((val - dm.lo) / (dm.hi - dm.lo || 1)), ring: S.lens === "presence" && d.gov ? 2 : 0 };
    }
    case "changes":
      return d.cambi.some((c) => c.tipo !== "componente") ? { c: groupColor(i, date), ring: 0, rm: 1.45 } : { c: FADE, ring: 0, a: 0.75 };
    case "sim": {
      if (S.dep == null) return { c: groupColor(i, date), ring: 0, a: 0.35 };
      if (i === S.dep) return { c: groupColor(i, date), ring: 1 };
      if (!deputyFile(S.dep)) return { c: FADE, ring: 0, a: 0.6 };
      const s = similarity(S.dep, i);
      if (s.v == null) return { c: PAPER, ring: 4 };
      return { c: inkAt(s.v), ring: 0 };
    }
  }
  return { c: INK, ring: 0 };
}

// ---------------------------------------------------------------- legenda

export function histSVG(dm: Domain, fmt: (x: number) => string, fixed01 = false): string {
  const lo = fixed01 ? 0 : dm.lo, hi = fixed01 ? 1 : dm.hi;
  const bins = 22, cnt = new Array(bins).fill(0);
  dm.vals.forEach((x) => {
    const k = Math.min(bins - 1, Math.max(0, Math.floor(((x - lo) / (hi - lo || 1)) * bins)));
    cnt[k]++;
  });
  const mx = Math.max(...cnt, 1), W = 200, H = 46, bw = W / bins;
  let s = `<svg viewBox="0 0 ${W} ${H + 16}" role="img" aria-label="Distribuzione dei valori ${WORDS[AULA].dellaAula}">`;
  cnt.forEach((c, k) => {
    const h = Math.max(c ? 1.5 : 0, (c / mx) * H);
    s += `<rect x="${(k * bw + 0.5).toFixed(1)}" y="${(H - h).toFixed(1)}" width="${(bw - 1).toFixed(1)}" height="${h.toFixed(1)}" fill="${rgbs(inkAt((k + 0.5) / bins))}"/>`;
  });
  const mx_ = Math.min(1, Math.max(0, (dm.med - lo) / (hi - lo || 1))) * W;
  s += `<line x1="${mx_}" x2="${mx_}" y1="0" y2="${H + 3}" stroke="#D2402B" stroke-width="1.5"/><line x1="0" x2="${W}" y1="${H + 0.5}" y2="${H + 0.5}" stroke="#151515"/>`;
  const near = (x: number) => Math.abs(x - mx_) < 34;
  if (!near(0)) s += `<text x="0" y="${H + 13}" class="ax">${esc(fmt(lo))}</text>`;
  if (!near(W)) s += `<text x="${W}" y="${H + 13}" text-anchor="end" class="ax">${esc(fmt(hi))}</text>`;
  const anc = mx_ < 18 ? "start" : mx_ > W - 18 ? "end" : "middle";
  s += `<text x="${mx_}" y="${H + 13}" text-anchor="${anc}" class="ax acc">${esc(fmt(dm.med))}</text></svg>`;
  return s;
}

export const LENS_TXT: Record<string, [string, string, string]> = {
  presence: ["Presenza al voto", "Voti espressi sul totale delle votazioni del mandato. Le assenze giustificate (missioni, congedi) sono contate a parte. Bordo rosso: membro del Governo.", "m-presenza"],
  dissent: ["Dissenso dal gruppo", "Voti diversi dalla posizione del proprio gruppo, calcolata senza il proprio voto. Più scuro = più dissenso. Il Misto è escluso.", "m-dissenso"],
  cross: ["Trasversalità", "Voti contesi espressi come la maggioranza dell'altro schieramento. Più scuro = più spesso.", "m-trasversalita"],
};

export function simHist(): string {
  if (S.dep == null || !deputyFile(S.dep)) return "";
  const vals: number[] = [];
  for (let j = 0; j < D.N; j++) {
    if (j === S.dep) continue;
    const s = similarity(S.dep, j);
    if (s.v != null) vals.push(s.v);
  }
  return histSVG({ lo: 0, hi: 1, med: quant(vals, 0.5), vals }, (x) => pc(x, 0), true);
}
