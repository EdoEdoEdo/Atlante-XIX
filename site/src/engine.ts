// Motore dei punti: un punto per deputato su un unico canvas, con transizioni

import type { RGB } from "./types.js";
import { clamp, easeIO, hf, lerp, reducedMotion, rgbs } from "./util.js";

export const PAPER: RGB = [244, 241, 234];
export const INK: RGB = [21, 21, 21];
export const INK2: RGB = [94, 90, 82];
export const INK3: RGB = [140, 133, 121];
export const RULE: RGB = [207, 200, 186];
export const ACC: RGB = [210, 64, 43];
export const ABST: RGB = [154, 148, 136];
export const LIGHT: RGB = [226, 220, 205];
export const FADE: RGB = [217, 211, 198];

export const FONT_MONO = '500 10px "IBM Plex Mono", ui-monospace, Menlo, monospace';
export const FONT_MONOB = '600 10px "IBM Plex Mono", ui-monospace, Menlo, monospace';
export const FONT_SMALL = '500 9px "IBM Plex Mono", ui-monospace, Menlo, monospace';
export const fontBig = (px: number): string => `800 ${px}px "Schibsted Grotesk", "Helvetica Neue", Arial, sans-serif`;
export const FONT_NAME = '700 12px "Schibsted Grotesk", "Helvetica Neue", Arial, sans-serif';

/** anelli: 0 nessuno · 1 selezionato · 2 bordo accento · 3 vuoto (nessun dato) · 4 tratteggiato (sotto soglia) · 5 vuoto inchiostro · 6 presidente di turno */
export interface Look {
  x: number;
  y: number;
  r: number;
  a: number;
  c: RGB;
  ring: number;
}
interface Dot extends Look {
  f: Look | null;
  to: Look | null;
  delay: number;
}
export type Painter = (ctx: CanvasRenderingContext2D, alpha: number) => void;

export let ctx: CanvasRenderingContext2D;
let cv: HTMLCanvasElement;
export let VW = 0;
export let VH = 0;
let DPR = 1;
export const dots: Dot[] = [];
let stag: Float32Array;
let anim = { on: false, t0: 0, dur: 0 };
let rafId = 0;
let over: Painter | null = null;
let under: Painter | null = null;
let ovT0 = 0;
export let clip: { x: number; y: number; w: number; h: number } | null = null;
export let misreg = 0;
let custom: ((now: number) => boolean) | null = null;
let keepAlive: () => boolean = () => false;

/**
 * Fantasmi: punti che non esistono più (passando da Camera a Senato i punti si dimezzano).
 * Ognuno segue il punto j con cui si fonde e svanisce mentre lo raggiunge.
 */
export interface Ghost {
  x: number;
  y: number;
  r: number;
  c: RGB;
  j: number;
}
let ghosts: Ghost[] = [];
let gT0 = 0;
let gDur = 0;
export function setGhosts(g: Ghost[], dur: number): void {
  ghosts = reducedMotion() ? [] : g;
  gT0 = performance.now();
  gDur = Math.max(1, dur);
  kick();
}
function drawGhosts(): boolean {
  if (!ghosts.length) return false;
  const u = clamp((performance.now() - gT0) / gDur, 0, 1);
  if (u >= 1) {
    ghosts = [];
    return false;
  }
  const e = easeIO(u);
  for (const g of ghosts) {
    const d = dots[g.j];
    if (!d) continue;
    ctx.globalAlpha = (1 - e) * (1 - e) * 0.95 + 0.05 * (1 - u);
    ctx.fillStyle = rgbs([lerp(g.c[0], d.c[0], e), lerp(g.c[1], d.c[1], e), lerp(g.c[2], d.c[2], e)]);
    dotPath(lerp(g.x, d.x, e), lerp(g.y, d.y, e), lerp(g.r, d.r, e));
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  return true;
}

export function initEngine(canvas: HTMLCanvasElement, n: number): void {
  cv = canvas;
  ctx = cv.getContext("2d")!;
  dots.length = 0;
  for (let i = 0; i < n; i++) dots.push({ x: 0, y: 0, r: 0, a: 0, c: [...INK] as RGB, ring: 0, f: null, to: null, delay: 0 });
  stag = Float32Array.from(dots, (_d, i) => hf(i, 3, 9));
  sizeCanvas();
}

export function sizeCanvas(): void {
  DPR = Math.min(2, devicePixelRatio || 1);
  VW = innerWidth;
  VH = innerHeight;
  cv.width = Math.round(VW * DPR);
  cv.height = Math.round(VH * DPR);
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
}

export const setClip = (r: typeof clip): void => {
  clip = r;
};
export const setMisreg = (m: number): void => {
  misreg = m;
};
/** un disegno a parte (la schermata di caricamento); restituisce true finché deve continuare */
export const setCustom = (fn: typeof custom): void => {
  custom = fn;
  kick();
};
export const setKeepAlive = (fn: () => boolean): void => {
  keepAlive = fn;
};

const snap = (o: Look): Look => ({ x: o.x, y: o.y, r: o.r, a: o.a, c: [o.c[0], o.c[1], o.c[2]], ring: o.ring });

/** porta i punti verso nuovi valori, con un piccolo ritardo diverso per ciascuno */
export function setTargets(T: Look[], dur = 750, stagger = 260, ov: Painter | null = null, un: Painter | null = null): void {
  if (reducedMotion()) dur = 0;
  const now = performance.now();
  dots.forEach((o, i) => {
    o.f = snap(o);
    o.to = T[i];
    o.delay = dur ? stag[i] * stagger : 0;
  });
  anim = { on: dur > 0, t0: now, dur };
  over = ov;
  under = un;
  ovT0 = now + (dur ? dur * 0.55 : 0);
  if (!dur) dots.forEach((o) => o.to && Object.assign(o, snap(o.to)));
  kick();
}

/** imposta direttamente posizioni e colori (intro guidata dallo scroll) */
export function setNow(T: Look[], ov: Painter | null, un: Painter | null = null): void {
  anim.on = false;
  dots.forEach((o, i) => Object.assign(o, snap(T[i])));
  over = ov;
  under = un;
  ovT0 = 0;
  draw(1);
}

export const animating = (): boolean => anim.on;

export function kick(): void {
  if (!rafId) rafId = requestAnimationFrame(frame);
}

function frame(now: number): void {
  rafId = 0;
  if (custom) {
    if (custom(now)) kick();
    else custom = null;
    return;
  }
  let busy = false;
  if (anim.on) {
    for (const o of dots) {
      if (!o.f || !o.to) continue;
      const u = clamp((now - anim.t0 - o.delay) / anim.dur, 0, 1);
      const e = easeIO(u), f = o.f, t = o.to;
      o.x = lerp(f.x, t.x, e);
      o.y = lerp(f.y, t.y, e);
      o.r = lerp(f.r, t.r, e);
      o.a = lerp(f.a, t.a, e);
      o.c[0] = lerp(f.c[0], t.c[0], e);
      o.c[1] = lerp(f.c[1], t.c[1], e);
      o.c[2] = lerp(f.c[2], t.c[2], e);
      o.ring = u < 0.5 ? f.ring : t.ring;
      if (u < 1) busy = true;
    }
    if (!busy) anim.on = false;
  }
  const oa = clamp((now - ovT0) / 350, 0, 1);
  if (oa < 1) busy = true;
  draw(oa);
  if (ghosts.length) busy = true;
  if (busy || keepAlive()) kick();
}

function dotPath(x: number, y: number, r: number): void {
  ctx.beginPath();
  ctx.arc(x, y, Math.max(0.1, r), 0, 6.2832);
}

export function draw(oa = 1): void {
  ctx.clearRect(0, 0, VW, VH);
  if (clip) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(clip.x, clip.y, clip.w, clip.h);
    ctx.clip();
  }
  if (under) under(ctx, oa);
  drawGhosts();
  if (misreg > 0.01) {
    ctx.globalAlpha = 0.55 * misreg;
    ctx.fillStyle = rgbs(ACC);
    for (const o of dots) {
      if (o.a < 0.05 || o.r < 0.5) continue;
      dotPath(o.x + misreg * 1.8, o.y - misreg * 1.2, o.r);
      ctx.fill();
    }
  }
  for (let pass = 0; pass < 2; pass++) {
    for (const o of dots) {
      if (o.a < 0.02 || o.r < 0.2) continue;
      const hi = o.a > 0.6 || o.ring === 1;
      if ((pass === 0) === hi) continue;
      ctx.globalAlpha = o.a;
      const rg = o.ring;
      if (rg === 3 || rg === 4 || rg === 5) {
        dotPath(o.x, o.y, o.r);
        ctx.fillStyle = rgbs(PAPER);
        ctx.fill();
        ctx.lineWidth = 1;
        ctx.strokeStyle = rg === 5 ? rgbs(INK) : rg === 4 ? rgbs(INK3) : "rgb(185,177,161)";
        if (rg === 4) ctx.setLineDash([2, 1.6]);
        ctx.stroke();
        ctx.setLineDash([]);
        continue;
      }
      dotPath(o.x, o.y, o.r);
      ctx.fillStyle = rgbs(o.c);
      ctx.fill();
      if (rg === 2) {
        ctx.lineWidth = 1.4;
        ctx.strokeStyle = rgbs(ACC);
        dotPath(o.x, o.y, o.r + 1.6);
        ctx.stroke();
      } else if (rg === 6) {
        ctx.lineWidth = 1.2;
        ctx.strokeStyle = rgbs(INK);
        dotPath(o.x, o.y, o.r + 1.8);
        ctx.stroke();
      }
    }
  }
  ctx.globalAlpha = 1;
  for (const o of dots) {
    if (o.ring !== 1 || o.a < 0.05) continue;
    ctx.lineWidth = 2;
    ctx.strokeStyle = rgbs(INK);
    dotPath(o.x, o.y, o.r + 3);
    ctx.stroke();
    ctx.lineWidth = 1;
    ctx.strokeStyle = rgbs(PAPER);
    dotPath(o.x, o.y, o.r + 1.2);
    ctx.stroke();
  }
  if (over) over(ctx, oa);
  if (clip) ctx.restore();
}

export interface LabelOpts {
  font?: string;
  col?: RGB | string;
  align?: CanvasTextAlign;
  halo?: boolean;
  a?: number;
}
export function label(c: CanvasRenderingContext2D, txt: string, x: number, y: number, o: LabelOpts = {}): void {
  c.save();
  c.globalAlpha = o.a ?? 1;
  c.font = o.font ?? FONT_MONO;
  c.textAlign = o.align ?? "center";
  c.textBaseline = "alphabetic";
  if (o.halo !== false) {
    c.lineJoin = "round";
    c.lineWidth = 4;
    c.strokeStyle = rgbs(PAPER);
    c.strokeText(txt, x, y);
  }
  const col = o.col ?? INK;
  c.fillStyle = Array.isArray(col) ? rgbs(col) : col;
  c.fillText(txt, x, y);
  c.restore();
}

export function hitDot(x: number, y: number): number {
  let best = -1, bd = 1e9;
  for (let i = 0; i < dots.length; i++) {
    const o = dots[i];
    if (o.a < 0.25 || o.r < 0.5) continue;
    const d = (o.x - x) ** 2 + (o.y - y) ** 2, lim = Math.max(o.r + 5, 10) ** 2;
    if (d < lim && d < bd) {
      bd = d;
      best = i;
    }
  }
  return best;
}

export function inkAt(v: number): RGB {
  v = Math.pow(clamp(v, 0, 1), 0.9);
  return [lerp(LIGHT[0], INK[0], v), lerp(LIGHT[1], INK[1], v), lerp(LIGHT[2], INK[2], v)];
}
