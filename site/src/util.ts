// Utilità condivise: DOM, numeri, date, testo

import type { RGB } from "./types.js";

export const $ = <T extends Element = HTMLElement>(s: string, r: ParentNode = document): T =>
  r.querySelector(s) as T;
export const $$ = <T extends Element = HTMLElement>(s: string, r: ParentNode = document): T[] =>
  [...r.querySelectorAll(s)] as T[];

export const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const smooth = (t: number, a: number, b: number): number => {
  const x = clamp((t - a) / (b - a), 0, 1);
  return x * x * (3 - 2 * x);
};
export const easeIO = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
export const easeOut = (t: number): number => 1 - Math.pow(1 - t, 3);

export const reducedMotion = (): boolean => matchMedia("(prefers-reduced-motion: reduce)").matches;

/** hash deterministico in [0,1) */
export function hf(a: number, b: number, c = 0): number {
  let x = Math.imul((a | 0) + 0x9e3779b9, 0x85ebca6b) ^ Math.imul((b | 0) + 0x632be5ab, 0xc2b2ae35) ^ Math.imul((c | 0) + 0x27d4eb2f, 0x165667b1);
  x ^= x >>> 15;
  x = Math.imul(x, 0x2c1b3c6d);
  x ^= x >>> 12;
  x = Math.imul(x, 0x297a2d39);
  x ^= x >>> 15;
  return (x >>> 0) / 4294967296;
}

export const esc = (s: unknown): string =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

/** testo dalla Camera con entità HTML (a volte doppie) → testo semplice */
export function decodeEntities(s: string): string {
  const t = document.createElement("textarea");
  let out = s;
  for (let k = 0; k < 3 && /&[#a-z0-9]+;/i.test(out); k++) {
    t.innerHTML = out;
    out = t.value;
  }
  return out;
}

export const nz = (s: string): string =>
  s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/['’]/g, " ").replace(/\s+/g, " ").trim();

const NF = new Intl.NumberFormat("it-IT");
export const fmtN = (n: number): string => NF.format(n);
export const pc = (v: number | null | undefined, d = 1): string =>
  v == null || !isFinite(v) ? "—" : (v * 100).toFixed(d).replace(".", ",") + "%";

export function hex2rgb(h: string): RGB {
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
}
export const rgbs = (c: RGB | number[]): string => `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`;

// ---- date (AAAAMMGG)
export const MESI = ["gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno", "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre"];
export const MESI3 = ["gen", "feb", "mar", "apr", "mag", "giu", "lug", "ago", "set", "ott", "nov", "dic"];
const GIORNI = ["domenica", "lunedì", "martedì", "mercoledì", "giovedì", "venerdì", "sabato"];

export const ymdMs = (d: string): number => Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8));
export const msYmd = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
};
export const fmtD = (d: string): string => (d ? `${+d.slice(6, 8)} ${MESI[+d.slice(4, 6) - 1]} ${d.slice(0, 4)}` : "");
export const fmtDL = (d: string): string => `${GIORNI[new Date(ymdMs(d)).getUTCDay()]} ${fmtD(d)}`;
export const fmtS = (d: string): string => (d ? `${d.slice(6, 8)}/${d.slice(4, 6)}/${d.slice(0, 4)}` : "");
export const fmtM = (d: string): string => `${MESI3[+d.slice(4, 6) - 1]} ${d.slice(0, 4)}`;
export const fmtMonthKey = (m: string): string => `${MESI[+m.slice(4, 6) - 1]} ${m.slice(0, 4)}`;
export const iso = (d: string): string => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
export const fromIso = (s: string): string => s.replace(/-/g, "");

export const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
export const raf = (): Promise<number> => new Promise((r) => requestAnimationFrame(r));
