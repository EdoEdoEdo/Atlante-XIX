// La tavola dell'esploratore: posizioni, colori e disegni sopra i punti

import { D, W, groupAt, inOffice, isSecret, todayKey, voteRow } from "./data.js";
import {
  ACC, ABST, FONT_MONOB, FONT_NAME, FONT_SMALL, INK, INK3, PAPER, RULE, VW, dots, fontBig, label, setTargets,
  type Look, type Painter,
} from "./engine.js";
import { COLS, colLabel, GRID_COLS, GRID_ROWS, hemiIds, hemiLayout, mapFrame, mapPixels, mapPositions, trailNodes, voteLayout, type Hemi, type MapFrame, type Rect } from "./layouts.js";
import { dotStyle } from "./lenses.js";
import { S, type View } from "./state.js";
import type { RGB, Vote, XY } from "./types.js";
import { $, rgbs } from "./util.js";

export const isMobile = (): boolean => innerWidth <= 980;
export const curVote = (): Vote | null => (S.vote != null ? D.votes[S.vote] : null);
export function effView(): View {
  const v = curVote();
  if (S.view === "vote" && (!v || !voteRow(v))) return "map";
  return S.view;
}
/** data di riferimento per chi è in carica */
export function tRef(): string {
  const v = curVote();
  if (v && effView() !== "map") return v.data;
  if (S.period) return S.period[1] < todayKey() ? S.period[1] : todayKey();
  return todayKey();
}
/** data di riferimento per il colore del gruppo */
export const tColor = (): string => tRef();

export function slotRect(): Rect & { x0: number; y0: number; w0: number; h0: number } {
  const r = $("#slot").getBoundingClientRect();
  const peek = isMobile() ? 78 : 0;
  const top = isMobile() ? 44 : 62;
  // sul telefono la legenda sta sopra la scheda: la tavola finisce sopra la legenda
  const lg = isMobile() ? ($("#mlegend").offsetHeight || 0) + (($("#mlegend").offsetHeight || 0) ? 10 : 0) : 0;
  return { x0: r.left, y0: r.top, w0: r.width, h0: r.height - peek, x: r.left + 10, y: r.top + top, w: r.width - 20, h: r.height - peek - lg - top - 8 };
}

const VCOL: Record<string, RGB> = { F: INK, C: ACC, A: ABST };
const mapR = (R: Rect): number => Math.max(2.4, Math.min(4.6, R.w / 190));

export function computeTargets(dur = 720): void {
  const R = slotRect();
  const view = effView();
  const v = curVote();
  const date = tRef();
  const row = v ? voteRow(v) : null;
  const T: Look[] = new Array(D.N);
  const hide = (i: number): Look => ({ x: dots[i].x, y: dots[i].y, r: 0, a: 0, c: [...dots[i].c] as RGB, ring: 0 });
  const secretView = !!v && (isSecret(v) || v.stato === 1) && view === "vote";
  const voteColor = !!v && !!row && v.stato === 0 && !isSecret(v) && view === "hemi";
  let hemi: Hemi | null = null;
  let frame: MapFrame | null = null;
  let vl: ReturnType<typeof voteLayout> | null = null;
  let pts: XY[] = [];
  // sul telefono resta spazio ai lati per le sigle dei gruppi intorno all'emiciclo
  const RH = isMobile() ? { x: R.x + 22, y: R.y, w: R.w - 44, h: R.h } : R;
  if (view === "hemi" || secretView) hemi = hemiLayout(RH, hemiIds(v && (secretView || voteColor) ? v.data : date));
  else if (view === "vote" && v && row) vl = voteLayout(R, v, row);
  else {
    frame = mapFrame(R);
    pts = mapPositions(S.period).pts;
  }
  const cmpSet = S.cmp ? new Set(S.cmp) : null;
  const rMap = mapR(R);
  const MP = frame ? mapPixels(frame, pts, rMap) : null;
  for (let i = 0; i < D.N; i++) {
    const d = D.deputies[i];
    let x: number, y: number, r: number;
    if (hemi) {
      const p = hemi.pos.get(i);
      if (!p) {
        T[i] = hide(i);
        continue;
      }
      x = p[1];
      y = p[2];
      r = hemi.r;
    } else if (vl) {
      const p = vl.pos.get(i);
      if (!p) {
        T[i] = hide(i);
        continue;
      }
      [x, y] = p;
      r = vl.r;
    } else {
      const q = MP?.[i];
      if (!q) {
        T[i] = hide(i);
        continue;
      }
      [x, y] = q;
      r = rMap;
    }
    let st = dotStyle(i, voteColor || vl ? v!.data : date);
    if (secretView) st = { c: [189, 182, 168], ring: 0 };
    else if (voteColor && row) {
      const ch = row.charAt(i);
      st = VCOL[ch] ? { c: VCOL[ch], ring: 0 } : ch === "P" ? { c: PAPER, ring: 6 } : { c: PAPER, ring: 3 };
    }
    let a = st.a ?? 1;
    r *= st.rm ?? 1;
    if (vl && row) {
      const ch = row.charAt(i);
      if (ch === "P") st = { ...st, ring: 6 };
      if ("FCA".indexOf(ch) < 0) a = Math.min(a, 0.45);
    }
    if (frame && !S.period && d.mandato[1] && S.lens !== "sim" && st.ring === 0) st = { ...st, ring: 3 };
    if (S.hl) {
      if (S.hl.has(i)) r *= 1.3;
      else a = Math.min(a, 0.13);
    }
    if (cmpSet) {
      if (cmpSet.has(i)) {
        r *= 1.9;
        st = { ...st, ring: 1 };
        a = 1;
      } else if (S.lens !== "sim") a = Math.min(a, 0.2);
    }
    if (S.dep === i && !cmpSet) {
      r *= 1.9;
      st = { ...st, ring: 1 };
      a = 1;
    }
    T[i] = { x, y, r, a, c: [...st.c] as RGB, ring: st.ring };
  }
  const { over, under } = overlays(R, view, v, row, { hemi, frame, vl, secretView, voteColor }, T);
  setTargets(T, dur, dur ? 240 : 0, over, under);
}

// ---------------------------------------------------------------- disegni sopra e sotto i punti

interface Lay {
  hemi: Hemi | null;
  frame: MapFrame | null;
  vl: ReturnType<typeof voteLayout> | null;
  secretView: boolean;
  voteColor: boolean;
}

function overlays(R: Rect, view: View, v: Vote | null, row: string | null, L: Lay, T: Look[]): { over: Painter | null; under: Painter | null } {
  const date = tColor();
  if (L.frame) {
    const F = L.frame;
    const under: Painter = (c, a) => {
      drawGrid(c, F, a);
      if (S.lens === "changes") drawTrails(c, F, a);
      if (S.cmp) {
        const [i, j] = S.cmp, A = T[i], B = T[j];
        if (A.a > 0.5 && B.a > 0.5) {
          c.save();
          c.globalAlpha = a;
          c.strokeStyle = rgbs(ACC);
          c.lineWidth = 1.5;
          c.setLineDash([5, 4]);
          c.beginPath();
          c.moveTo(A.x, A.y);
          c.lineTo(B.x, B.y);
          c.stroke();
          c.restore();
        }
      }
    };
    const over: Painter = (c, a) => {
      if (S.lens === "groups" || S.lens === "changes") groupLabels(c, T, date, a);
      if (!isMobile()) label(c, "Vicini = votano in modo simile · l'asse orizzontale separa maggioranza e opposizione", F.ox, F.oy + F.h + 15, { a, align: "left", col: INK3, halo: false, font: FONT_SMALL });
      selLabels(c, T, a);
    };
    return { over, under };
  }
  if (L.hemi) {
    const H = L.hemi;
    const over: Painter = (c, a) => {
      if (L.secretView && v) {
        const big = isMobile() ? 26 : 40;
        label(c, v.stato === 1 ? "Voti individuali incompleti" : "Voto segreto", H.cx, H.cy - big - 10, { font: fontBig(big * 0.8), a });
        label(c, `${v.F} favorevoli · ${v.C} contrari · ${v.A} astenuti`, H.cx, H.cy - 20, { a });
        label(c, v.stato === 1 ? `La ${W().aula} non ha pubblicato tutti i voti individuali` : `I voti dei singoli ${W().membri} non esistono`, H.cx, H.cy - 4, { a, col: INK3 });
      } else if (v && L.voteColor) {
        label(c, `${v.F} – ${v.C}`, H.cx, H.cy - 14, { font: fontBig(isMobile() ? 28 : 40), a, col: v.esito ? INK : ACC });
        label(c, (v.esito ? "APPROVATA" : "RESPINTA") + " · FAVOREVOLI – CONTRARI", H.cx, H.cy + (isMobile() ? 16 : 6), { a, col: INK3 });
      } else {
        label(c, String(H.pos.size), H.cx, H.cy - 14, { font: fontBig(isMobile() ? 28 : 40), a });
        label(c, `${W().membri.toUpperCase()} IN CARICA · ` + (S.period ? "AL " + fmtShort(tRef()) : "OGGI"), H.cx, H.cy + (isMobile() ? 16 : 6), { a, col: INK3 });
      }
      if (!v && S.lens === "groups") arcLabels(c, H, tRef(), a);
      selLabels(c, T, a);
    };
    return { over, under: null };
  }
  if (L.vl) {
    const VL = L.vl;
    const over: Painter = (c, a) => {
      const small = R.h < 380;
      COLS().forEach((k, j) => {
        const x = R.x + R.w * VL.xs[j];
        const lab = isMobile() || COLS().length > 5 ? colLabel(k, true) : colLabel(k).toUpperCase();
        label(c, lab, x, VL.base + 16, { a, col: INK3, font: isMobile() ? FONT_SMALL : undefined });
        label(c, String(VL.cols[k].length), x, VL.base + (small ? 38 : 48), { font: fontBig(small ? 22 : 32), a, col: k === "C" ? ACC : INK });
      });
      selLabels(c, T, a);
    };
    return { over, under: null };
  }
  void view;
  void row;
  return { over: null, under: null };
}

const fmtShort = (d: string): string => `${d.slice(6, 8)}/${d.slice(4, 6)}/${d.slice(0, 4)}`;

export function drawGrid(c: CanvasRenderingContext2D, F: MapFrame, a: number): void {
  c.save();
  c.globalAlpha = 0.5 * a;
  c.strokeStyle = rgbs(RULE);
  c.lineWidth = 1;
  c.setLineDash([1, 3]);
  for (let k = 1; k < 10; k++) {
    const x = F.ox + (F.w * k) / 10;
    c.beginPath();
    c.moveTo(x, F.oy);
    c.lineTo(x, F.oy + F.h);
    c.stroke();
  }
  for (let k = 1; k < GRID_ROWS; k++) {
    const y = F.oy + (F.h * k) / GRID_ROWS;
    c.beginPath();
    c.moveTo(F.ox, y);
    c.lineTo(F.ox + F.w, y);
    c.stroke();
  }
  c.setLineDash([]);
  c.globalAlpha = 0.9 * a;
  c.strokeStyle = rgbs(INK3);
  c.strokeRect(F.ox + 0.5, F.oy + 0.5, F.w, F.h);
  c.restore();
  for (let k = 0; k < 10; k++) label(c, GRID_COLS[k], F.ox + (F.w * (k + 0.5)) / 10, F.oy - 5, { col: INK3, a, halo: false, font: FONT_SMALL });
  for (let k = 0; k < GRID_ROWS; k++) label(c, String(k + 1), F.ox - 6, F.oy + (F.h * (k + 0.5)) / GRID_ROWS + 3, { col: INK3, a, halo: false, align: "right", font: FONT_SMALL });
}

export function groupLabels(c: CanvasRenderingContext2D, T: Look[], date: string, a: number): void {
  const acc = new Map<string, Look[]>();
  D.deputies.forEach((d) => {
    const t = T[d.i];
    if (!t || t.a < 0.5) return;
    const g = groupAt(d, date);
    if (!g || g === "ALT") return;
    if (!acc.has(g)) acc.set(g, []);
    acc.get(g)!.push(t);
  });
  const placed: { x: number; y: number; w: number }[] = [];
  acc.forEach((arr, g) => {
    if (arr.length < 3) return;
    const xs = arr.map((o) => o.x).sort((p, q) => p - q), ys = arr.map((o) => o.y).sort((p, q) => p - q);
    const x = xs[xs.length >> 1];
    let y = ys[Math.floor(ys.length * 0.04)] - 10;
    const s = D.G[g].sigla.toUpperCase();
    c.save();
    c.font = FONT_MONOB;
    const w = c.measureText(s).width + 10;
    c.restore();
    // le etichette dei gruppi dello stesso blocco si impilano senza toccarsi
    for (let moved = true, n = 0; moved && n < 12; n++) {
      moved = false;
      for (const p of placed)
        if (Math.abs(p.x - x) < (p.w + w) / 2 && Math.abs(p.y - y) < 13) {
          y = p.y - 14;
          moved = true;
        }
    }
    placed.push({ x, y, w });
    label(c, s, x, y, { a, font: FONT_MONOB });
  });
}

export function arcLabels(c: CanvasRenderingContext2D, H: Hemi, date: string, a: number): void {
  const per = new Map<string, number[]>();
  H.pos.forEach((p, i) => {
    const g = groupAt(D.deputies[i], date) ?? "ALT";
    if (!per.has(g)) per.set(g, []);
    per.get(g)!.push(p[0]);
  });
  const small = isMobile();
  per.forEach((angs, g) => {
    if (angs.length < (small ? 8 : 3)) return;
    const mid = (Math.max(...angs) + Math.min(...angs)) / 2, r = H.Rmax + 14;
    const x = H.cx + r * Math.cos(mid), y = H.cy - r * Math.sin(mid);
    const al: CanvasTextAlign = Math.cos(mid) > 0.25 ? "left" : Math.cos(mid) < -0.25 ? "right" : "center";
    label(c, D.G[g].sigla, x, y + 3, { a, align: al, font: small ? FONT_SMALL : FONT_MONOB, col: D.G[g].rgb });
  });
}

export function selLabels(c: CanvasRenderingContext2D, T: Look[], a: number): void {
  const ids = S.cmp ? S.cmp : S.dep != null ? [S.dep] : [];
  ids.forEach((i) => {
    const o = T[i];
    if (!o || o.a < 0.5) return;
    const right = o.x < VW - 170;
    label(c, D.deputies[i].name, o.x + (right ? 1 : -1) * (o.r + 8), o.y + 4, { a, align: right ? "left" : "right", font: FONT_NAME });
  });
}

export function drawTrails(c: CanvasRenderingContext2D, F: MapFrame, a: number): void {
  c.save();
  c.lineCap = "round";
  for (const t of trailNodes()) {
    const P = t.nodes.map(([x, y]) => [F.X(x), F.Y(y)] as [number, number]);
    const side = t.i % 2 ? 1 : -1;
    let cx = 0, cy = 0;
    c.globalAlpha = 0.55 * a;
    c.strokeStyle = rgbs(INK);
    c.lineWidth = 1.1;
    c.setLineDash([3, 2.5]);
    c.beginPath();
    c.moveTo(P[0][0], P[0][1]);
    for (let k = 1; k < P.length; k++) {
      const [x0, y0] = P[k - 1], [x1, y1] = P[k];
      const dx = x1 - x0, dy = y1 - y0;
      cx = (x0 + x1) / 2 - dy * 0.18 * side;
      cy = (y0 + y1) / 2 + dx * 0.18 * side;
      c.quadraticCurveTo(cx, cy, x1, y1);
    }
    c.stroke();
    c.setLineDash([]);
    // partenza: cerchio nel colore del primo gruppo; arrivo: punta nel colore dell'ultimo
    const g0 = D.G[t.groups[0]], g1 = D.G[t.groups[t.groups.length - 1]];
    c.globalAlpha = 0.9 * a;
    c.strokeStyle = g0 ? g0.colore : rgbs(INK3);
    c.lineWidth = 1.5;
    c.beginPath();
    c.arc(P[0][0], P[0][1], 3.2, 0, 6.2832);
    c.stroke();
    const [ex, ey] = P[P.length - 1];
    const ang = Math.atan2(ey - cy, ex - cx), L = 7;
    c.fillStyle = g1 ? g1.colore : rgbs(INK);
    c.beginPath();
    c.moveTo(ex, ey);
    c.lineTo(ex - L * Math.cos(ang - 0.42), ey - L * Math.sin(ang - 0.42));
    c.lineTo(ex - L * Math.cos(ang + 0.42), ey - L * Math.sin(ang + 0.42));
    c.closePath();
    c.fill();
  }
  c.restore();
}

/** in carica nel periodo (per la mappa) */
export const presentIn = (i: number): boolean => {
  const d = D.deputies[i];
  if (!S.period) return true;
  return inOffice(d, S.period[0]) || inOffice(d, S.period[1]);
};
