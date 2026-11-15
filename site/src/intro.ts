// Schermata di caricamento e introduzione guidata dallo scroll

import { D, W, todayKey, voteRow } from "./data.js";
import {
  ACC, FADE, INK, INK3, PAPER, VH, VW, ctx, dots, fontBig, label, setCustom, setMisreg, setNow, setTargets,
  type Look, type Painter,
} from "./engine.js";
import { COLS, colLabel, hemiIds, hemiLayout, mapFrame, mapPixels, voteLayout, type Rect } from "./layouts.js";
import { groupColor } from "./lenses.js";
import { S } from "./state.js";
import { drawTrails, groupLabels, arcLabels } from "./stage.js";
import type { RGB } from "./types.js";
import { $, $$, clamp, easeIO, hf, lerp, reducedMotion, rgbs } from "./util.js";

// ---------------------------------------------------------------- caricamento: emiciclo di 100 punti

const LOADER_N = 100;
interface LDot {
  x: number;
  y: number;
  a: number; // angolo
  lit: number; // istante in cui si accende (0 = spento)
}
let ldots: LDot[] = [];
let shown = 0; // avanzamento mostrato (insegue quello reale)
let target = 0;
let t0 = 0;
let lr = 4;
let done: (() => void) | null = null;

function loaderGeometry(): void {
  const mobile = VW < 640;
  const Rmax = Math.min(VW * (mobile ? 0.36 : 0.2), VH * 0.26);
  const R0 = Rmax * 0.42, rows = 5;
  const cx = VW / 2, cy = VH * (mobile ? 0.56 : 0.58);
  const radii = Array.from({ length: rows }, (_v, k) => R0 + ((Rmax - R0) * k) / (rows - 1));
  const tot = radii.reduce((a, b) => a + b, 0);
  const pts: LDot[] = [];
  radii.forEach((r, k) => {
    const m = k === rows - 1 ? LOADER_N - pts.length : Math.round((LOADER_N * r) / tot);
    for (let j = 0; j < m; j++) {
      const a = Math.PI * (1 - (j + 0.5) / m);
      pts.push({ x: cx + r * Math.cos(a), y: cy - r * Math.sin(a), a, lit: 0 });
    }
  });
  pts.sort((p, q) => q.a - p.a);
  const old = ldots;
  ldots = pts.slice(0, LOADER_N).map((p, k) => ({ ...p, lit: old[k]?.lit ?? 0 }));
  lr = clamp(((Rmax - R0) / (rows - 1)) * 0.3, 2.2, 5);
  LG = { cx, cy, Rmax, R0 };
  const el = document.getElementById("loader");
  if (el) {
    el.style.setProperty("--cy", `${cy.toFixed(1)}px`);
    el.style.setProperty("--r0", `${R0.toFixed(1)}px`);
  }
}
let LG = { cx: 0, cy: 0, Rmax: 1, R0: 1 };

export function startLoader(): void {
  loaderGeometry();
  t0 = performance.now();
  shown = 0;
  target = 0;
  addEventListener("resize", loaderGeometry);
  setCustom(paintLoader);
}

export function loaderProgress(p: number): void {
  target = clamp(p, 0, 1);
}
let pctShown = -1;
let broken = false;
/** caricamento fallito: il messaggio prende il posto della percentuale */
export function loaderFail(msg: string): void {
  broken = true;
  $("#loadPct").textContent = "—";
  $("#loadLbl").textContent = "errore";
  const m = $("#loadMsg");
  m.hidden = false;
  m.textContent = msg;
}

/** attende che l'animazione arrivi al 100% (con una durata minima, perché si veda) */
export function loaderReady(): Promise<void> {
  return new Promise((res) => {
    done = res;
  });
}

function paintLoader(now: number): boolean {
  const minDur = reducedMotion() ? 0 : 1500;
  const timeCap = clamp((now - t0) / Math.max(1, minDur), 0, 1);
  const goal = Math.min(target, minDur ? timeCap * 1.02 : 1);
  shown += (goal - shown) * 0.12;
  if (target >= 1 && goal >= 1 && shown > 0.995) shown = 1;
  const lit = Math.floor(shown * LOADER_N + 1e-6);
  if (lit !== pctShown && done && !broken) {
    pctShown = lit;
    $("#loadPct").textContent = `${lit}%`;
  }
  ctx.clearRect(0, 0, VW, VH);
  for (let k = 0; k < LOADER_N; k++) {
    const d = ldots[k];
    if (!d) continue;
    if (k < lit && !d.lit) d.lit = now;
    let r = lr, col = "#34322E", a = 1;
    if (d.lit) {
      const u = clamp((now - d.lit) / 360, 0, 1);
      r = lr * (1 + 0.55 * Math.sin(Math.PI * u) * (1 - u * 0.3));
      col = rgbs(PAPER);
    } else if (k === lit) {
      a = 0.55 + 0.45 * Math.sin(now / 140);
      col = "#5A5751";
    }
    ctx.globalAlpha = a;
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.arc(d.x, d.y, r, 0, 6.2832);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  if (shown >= 1 && ldots.every((d) => d.lit && now - d.lit > 380)) {
    removeEventListener("resize", loaderGeometry);
    const fn = done;
    done = null;
    fn?.();
    return false;
  }
  return true;
}

/** posizioni dei 100 punti del caricamento, per far nascere da lì i 400 punti */
export function loaderOrigins(order: number[]): Look[] {
  const per = Math.max(1, order.length / LOADER_N);
  const start: Look[] = dots.map(() => ({ x: VW / 2, y: VH * 0.58, r: 0, a: 0, c: [...PAPER] as RGB, ring: 0 }));
  order.forEach((i, s) => {
    const d = ldots[Math.min(LOADER_N - 1, Math.floor(s / per))];
    start[i] = { x: d.x, y: d.y, r: lr, a: 1, c: [...PAPER] as RGB, ring: 0 };
  });
  return start;
}

/**
 * chiude la schermata nera in due tempi:
 * 1. ancora sul nero, ognuno dei 100 punti si divide e l'emiciclo diventa quello vero (400 seggi);
 * 2. il nero si ritira verso l'alto, la carta compare e i punti prendono inchiostro e posto (final).
 */
export function loaderExit(order: number[], final: () => void): Promise<void> {
  const el = $("#loader");
  setNow(loaderOrigins(order), null);
  if (reducedMotion()) {
    el.classList.add("out");
    final();
    el.hidden = true;
    return Promise.resolve();
  }
  const Rm = LG.Rmax * 1.12;
  const w = Rm / 0.47, h = Rm / 0.86;
  const H = hemiLayout({ x: LG.cx - w / 2, y: LG.cy - h * 0.92, w, h }, order);
  const mid: Look[] = dots.map((_o, i) => {
    const p = H.pos.get(i);
    return p ? { x: p[1], y: p[2], r: H.r, a: 1, c: [...PAPER] as RGB, ring: 0 } : { x: LG.cx, y: LG.cy, r: 0, a: 0, c: [...PAPER] as RGB, ring: 0 };
  });
  el.classList.add("split");
  const num = $("#loadPct"), lbl = $("#loadLbl");
  num.textContent = String(order.length);
  lbl.textContent = W().membri;
  setTargets(mid, 700, 300, null);
  return new Promise((res) =>
    setTimeout(() => {
      el.classList.add("out");
      final();
      setTimeout(() => {
        el.hidden = true;
        res();
      }, 1350);
    }, 1050),
  );
}

// ---------------------------------------------------------------- introduzione

let SC: Look[][] = [];
let SCOV: (Painter | null)[] = [];
let stepC: number[] = [];
let lastP = -1;
let rafPending = 0;
export const introMobile = (): boolean => innerWidth <= 980;

export function introRect(): Rect {
  const top = $("#hd").offsetHeight;
  if (!introMobile()) {
    const x0 = Math.max(innerWidth * 0.37, 420);
    return { x: x0 + 28, y: top + 30, w: innerWidth - x0 - 76, h: innerHeight - top - 64 };
  }
  return { x: 14, y: top + 10, w: innerWidth - 28, h: Math.min(innerHeight * 0.47, innerWidth * 1.05) };
}

export function scene0Order(): number[] {
  return hemiIds(todayKey());
}

export function buildScenes(): void {
  const R = introRect();
  const today = todayKey();
  const ids = hemiIds(today);
  const H = hemiLayout(R, ids);
  const hide = (): Look => ({ x: R.x + R.w / 2, y: R.y + R.h * 0.9, r: 0, a: 0, c: [...INK] as RGB, ring: 0 });
  const sc: Look[][] = [];
  const ov: (Painter | null)[] = [];
  sc[0] = D.deputies.map((d) => {
    const p = H.pos.get(d.i);
    return p ? { x: p[1], y: p[2], r: H.r, a: 1, c: [...INK] as RGB, ring: 0 } : hide();
  });
  sc[1] = D.deputies.map((d) => {
    const p = H.pos.get(d.i);
    return p ? { x: p[1], y: p[2], r: H.r, a: 1, c: [...groupColor(d.i, today)] as RGB, ring: 0 } : hide();
  });
  const small = introMobile();
  ov[0] = (c, a) => {
    label(c, String(ids.length), H.cx, H.cy - 14, { font: fontBig(small ? 30 : 40), a });
    label(c, "DEPUTATI IN CARICA", H.cx, H.cy + 6, { a, col: INK3 });
  };
  ov[1] = (c, a) => arcLabels(c, H, today, a);
  // un voto
  const iv = D.vById.get(D.intro.voto);
  const v = iv != null ? D.votes[iv] : null;
  const row = v ? voteRow(v) : null;
  if (v && row) {
    const L = voteLayout(R, v, row);
    sc[2] = D.deputies.map((d) => {
      const p = L.pos.get(d.i);
      if (!p) return hide();
      const ch = row.charAt(d.i);
      return { x: p[0], y: p[1], r: L.r, a: "FCA".includes(ch) ? 1 : 0.42, c: [...groupColor(d.i, v.data)] as RGB, ring: 0 };
    });
    ov[2] = (c, a) =>
      COLS().forEach((k, j) => {
        const x = R.x + R.w * L.xs[j];
        label(c, small ? colLabel(k, true) : colLabel(k).toUpperCase(), x, L.base + 16, { a, col: INK3 });
        label(c, String(L.cols[k].length), x, L.base + (R.h < 380 ? 38 : 48), { font: fontBig(R.h < 380 ? 22 : 32), a, col: k === "C" ? ACC : INK });
      });
  } else {
    sc[2] = sc[1];
    ov[2] = ov[1];
  }
  // la mappa
  const F = mapFrame(R);
  const rr = Math.max(2.4, Math.min(4.4, R.w / 190));
  const MP = mapPixels(F, D.map.complessiva, rr);
  sc[3] = D.deputies.map((d) => {
    const p = MP[d.i];
    if (!p) return hide();
    return { x: p[0], y: p[1], r: rr, a: 1, c: [...groupColor(d.i, today)] as RGB, ring: d.mandato[1] ? 3 : 0 };
  });
  sc[4] = D.deputies.map((d, i) => {
    const o = sc[3][i];
    return d.cambi.some((c) => c.tipo !== "componente") ? { ...o, c: [...o.c] as RGB, r: o.r * 1.45, ring: 0 } : { ...o, c: [...FADE] as RGB, a: 0.7, ring: 0 };
  });
  ov[3] = (c, a) => groupLabels(c, sc[3], today, a);
  ov[4] = (c, a) => drawTrails(c, F, a);
  SC = sc;
  SCOV = ov;
}

export function introScene0(): { T: Look[]; over: Painter | null } {
  return { T: SC[0], over: SCOV[0] };
}

export function measureSteps(): void {
  stepC = $$(".step").map((el) => {
    const r = el.getBoundingClientRect();
    const y = r.top + scrollY;
    return introMobile() ? y + r.height - innerHeight * 0.98 : y + r.height / 2 - innerHeight / 2;
  });
}
function introP(): number {
  const s = scrollY, c = stepC;
  if (!c.length || s <= c[0]) return 0;
  for (let k = 0; k < c.length - 1; k++)
    if (s < c[k + 1]) {
      const f = (s - c[k]) / (c[k + 1] - c[k]);
      return k + clamp((f - 0.1) / 0.6, 0, 1);
    }
  return c.length - 1;
}

export function introFrame(force = false): void {
  if (S.mode !== "intro" || !SC.length) return;
  const p = introP();
  if (!force && Math.abs(p - lastP) < 1e-4) return;
  lastP = p;
  const last = SC.length - 1, k = Math.min(Math.floor(p), last - 1), u = clamp(p - k, 0, 1), A = SC[k], B = SC[k + 1];
  const T: Look[] = new Array(D.N);
  for (let i = 0; i < D.N; i++) {
    const a = A[i], b = B[i];
    const ui = clamp((u - hf(i, 3, 9) * 0.35) / 0.65, 0, 1), e = easeIO(ui);
    T[i] = {
      x: lerp(a.x, b.x, e), y: lerp(a.y, b.y, e), r: lerp(a.r, b.r, e), a: lerp(a.a, b.a, e),
      c: [lerp(a.c[0], b.c[0], e), lerp(a.c[1], b.c[1], e), lerp(a.c[2], b.c[2], e)], ring: e < 0.5 ? a.ring : b.ring,
    };
  }
  setMisreg(k === 0 && !reducedMotion() ? Math.sin(Math.PI * u) : 0);
  setNow(T, (c) => {
    for (let j = 0; j <= last; j++) {
      const a = clamp(1 - Math.abs(p - j) * 2.4, 0, 1);
      if (a > 0 && SCOV[j]) SCOV[j]!(c, a);
    }
  });
  const act = Math.round(p);
  $$(".step").forEach((el, j) => el.classList.toggle("on", j === act));
}

export function onIntroScroll(): void {
  if (S.mode !== "intro") return;
  if (!rafPending)
    rafPending = requestAnimationFrame(() => {
      rafPending = 0;
      introFrame();
    });
}

/** testi dell'intro dai dati */
export function fillIntroText(): void {
  const m = D.meta;
  const set = (id: string, v: string) => {
    const el = document.getElementById(id);
    if (el) el.textContent = v;
  };
  const nf = new Intl.NumberFormat("it-IT");
  set("fVotes", nf.format(m.votazioni));
  set("fDeps", String(m.deputati));
  set("fCont", nf.format(m.contese));
  set("iCont", nf.format(m.contese));
  const changed = D.deputies.filter((d) => d.cambi.some((c) => c.tipo !== "componente")).length;
  set("iCh", String(changed));
  const iv = D.vById.get(D.intro.voto);
  if (iv != null) {
    const v = D.votes[iv];
    const y = /anno finanziario (\d{4})/i.exec(D.intro.descrizione)?.[1];
    set("ivH", y ? `Legge di bilancio ${y}, voto finale.` : "Un voto finale.");
    set("ivKick", `${+v.data.slice(6, 8)} ${["gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno", "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre"][+v.data.slice(4, 6) - 1]} ${v.data.slice(0, 4)}`);
    const row = voteRow(v);
    if (row) {
      let n = 0, mi = 0;
      for (const ch of row) {
        if (ch === "N" || ch === "P") n++;
        else if (ch === "M") mi++;
      }
      set("ivF", String(v.F));
      set("ivC", String(v.C));
      set("ivA", String(v.A));
      set("ivN", String(n));
      set("ivM", String(mi));
    }
  }
  const order = D.groups.filter((g) => g.membri_oggi > 0).sort((a, b) => a.ordine - b.ordine);
  const gl = $("#iGroups");
  if (gl) gl.innerHTML = order.map((g) => `<span><i class="dot" style="background:${g.colore}"></i>${g.sigla}</span>`).join("");
  set("updated", `Dati aggiornati al ${+m.aggiornato.slice(6, 8)}/${m.aggiornato.slice(4, 6)}/${m.aggiornato.slice(0, 4)}`);
}
