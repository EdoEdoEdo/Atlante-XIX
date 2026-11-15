// Codice a barre: una linea per votazione (o per seduta, da lontano), in ordine di data

import { D, isFinal, isSecret, isTrust, typeLabel } from "./data.js";
import { S, type Filter } from "./state.js";
import type { Vote } from "./types.js";
import { $, MESI3, clamp, esc, fmtDL, fmtN, fmtS, msYmd } from "./util.js";

interface Handlers {
  vote: (v: number) => void;
  day: (d: number) => void;
  period: (a: string, b: string) => void;
  tip: (e: PointerEvent, html: string) => void;
  hideTip: () => void;
}
let H: Handlers;
let cv: HTMLCanvasElement;
let bx: CanvasRenderingContext2D;
let BW = 0, BH = 0;
const PADX = 14, AXH = 17;
export let dom: [number, number] = [0, 1];
let hover: { v?: number; day: number } | null = null;
let drag: { x0: number; x1: number; moved: boolean } | null = null;

const bxf = (t: number) => PADX + ((t - dom[0]) / (dom[1] - dom[0])) * (BW - 2 * PADX);
const btf = (x: number) => dom[0] + ((x - PADX) / (BW - 2 * PADX)) * (dom[1] - dom[0]);
export const tOfDate = (d: string): number => (Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8)) + 43_200_000 - D.T0) / (D.T1 - D.T0);
export const dateOfT = (t: number): string => msYmd(D.T0 + clamp(t, 0, 1) * (D.T1 - D.T0));

export function passes(v: Vote, f: Filter = S.filter): boolean {
  switch (f) {
    case "cont": return !!v.contesa;
    case "finale": return isFinal(v);
    case "fiducia": return isTrust(v);
    case "segreta": return isSecret(v);
    case "respinta": return !v.esito;
    case "stretto": return v.margine < 0.1;
    default: return true;
  }
}

export function initBarcode(canvas: HTMLCanvasElement, h: Handlers): void {
  cv = canvas;
  bx = cv.getContext("2d")!;
  H = h;
  cv.addEventListener("pointerdown", (e) => {
    if (e.button) return;
    stopPlay();
    cv.setPointerCapture(e.pointerId);
    drag = { x0: e.offsetX, x1: e.offsetX, moved: false };
  });
  cv.addEventListener("pointermove", (e) => {
    if (drag) {
      drag.x1 = clamp(e.offsetX, PADX, BW - PADX);
      if (Math.abs(drag.x1 - drag.x0) > 5) drag.moved = true;
      H.hideTip();
      drawBarcode();
      return;
    }
    const hit = hitAt(e.offsetX);
    hover = hit;
    drawBarcode();
    if (!hit) return H.hideTip();
    if (hit.v != null) {
      const v = D.votes[hit.v];
      H.tip(e, `<b>${esc(typeLabel(v))}${isSecret(v) ? " · segreta" : ""}${v.contesa ? " · contesa" : ""}</b><br>${fmtS(v.data)} · seduta ${v.seduta} · n. ${v.n}<br>${v.esito ? "approvata" : "respinta"} ${v.F}–${v.C}<br>${esc(v.titolo.slice(0, 80))}`);
    } else {
      const d = D.days[hit.day];
      let cont = 0, fin = 0, fid = 0;
      for (let k = d.v0; k < d.v1; k++) {
        const v = D.votes[k];
        cont += v.contesa;
        if (isFinal(v)) fin++;
        if (isTrust(v)) fid++;
      }
      H.tip(e, `<b>${esc(fmtDL(d.data))}</b><br>${d.v1 - d.v0} votazioni · ${cont} contese${fid ? " · fiducia" : ""}${fin ? " · voto finale" : ""}<br>Tocca per aprire la seduta`);
    }
  });
  cv.addEventListener("pointerleave", () => {
    if (!drag) {
      hover = null;
      H.hideTip();
      drawBarcode();
    }
  });
  cv.addEventListener("pointerup", () => {
    if (!drag) return;
    const dr = drag;
    drag = null;
    if (!dr.moved) {
      const hit = hitAt(dr.x0);
      if (hit) hit.v != null ? H.vote(hit.v) : H.day(hit.day);
      else drawBarcode();
      return;
    }
    const a = btf(Math.min(dr.x0, dr.x1)), b = btf(Math.max(dr.x0, dr.x1));
    H.period(dateOfT(a), dateOfT(b));
  });
  cv.addEventListener("wheel", (e) => {
    e.preventDefault();
    zoomAround(btf(e.offsetX), Math.exp(e.deltaY * 0.0016));
  }, { passive: false });
  cv.addEventListener("dblclick", (e) => zoomAround(btf(e.offsetX), 0.3));
}

export function sizeBarcode(): void {
  const r = cv.getBoundingClientRect();
  const dpr = Math.min(2, devicePixelRatio || 1);
  BW = r.width;
  BH = r.height;
  cv.width = Math.max(1, BW * dpr);
  cv.height = Math.max(1, BH * dpr);
  bx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawBarcode();
}

export function zoomAround(t: number, f: number): void {
  const minSpan = (4 * 86_400_000) / (D.T1 - D.T0);
  const span = clamp((dom[1] - dom[0]) * f, minSpan, 1);
  let a = t - ((t - dom[0]) / (dom[1] - dom[0])) * span;
  a = clamp(a, 0, 1 - span);
  dom = [a, a + span];
  drawBarcode();
}
export function setDom(a: number, b: number): void {
  dom = [clamp(a, 0, 1), clamp(b, 0, 1)];
  drawBarcode();
}
export function ensureVisible(t: number): void {
  if (t >= dom[0] && t <= dom[1]) return;
  const s = dom[1] - dom[0];
  const a = clamp(t - s / 2, 0, 1 - s);
  dom = [a, a + s];
}

const mode = (): "day" | "vote" => {
  let n = 0;
  for (const d of D.days) if (d.t >= dom[0] && d.t <= dom[1]) n += d.v1 - d.v0;
  return n / Math.max(1, BW - 2 * PADX) > 0.85 ? "day" : "vote";
};

export function drawBarcode(): void {
  if (!BW) return;
  const c = bx, top = 8, base = BH - AXH, hg = base - top;
  c.clearRect(0, 0, BW, BH);
  const m = mode();
  const spanDays = ((dom[1] - dom[0]) * (D.T1 - D.T0)) / 86_400_000;
  const pxDay = (BW - 2 * PADX) / spanDays;
  if (S.period) {
    const x0 = bxf(tOfDate(S.period[0]) - 0.5 / ((D.T1 - D.T0) / 86_400_000)), x1 = bxf(tOfDate(S.period[1]) + 0.5 / ((D.T1 - D.T0) / 86_400_000));
    c.fillStyle = "rgba(21,21,21,.07)";
    c.fillRect(x0, 0, Math.max(2, x1 - x0), base);
    c.fillStyle = "#151515";
    c.fillRect(x0, 0, 1, base);
    c.fillRect(x1, 0, 1, base);
  }
  let shown = 0;
  if (m === "day") {
    let mx = 1;
    const cnt = D.days.map((d) => {
      let n = 0, f = 0;
      for (let k = d.v0; k < d.v1; k++) {
        const v = D.votes[k];
        if (passes(v)) {
          n++;
          if (isFinal(v) || isTrust(v)) f++;
        }
      }
      if (n > mx) mx = n;
      return [n, f];
    });
    const w = clamp(pxDay * 0.62, 1, 7);
    D.days.forEach((d, k) => {
      if (d.t < dom[0] - 0.01 || d.t > dom[1] + 0.01) return;
      const [n, f] = cnt[k];
      if (!n) return;
      shown += n;
      const x = bxf(d.t), h = Math.max(2, Math.sqrt(n / mx) * hg);
      c.fillStyle = hover && hover.day === k ? "#D2402B" : "rgba(21,21,21,.78)";
      c.fillRect(x - w / 2, base - h, w, h);
      if (f) {
        c.fillStyle = "#D2402B";
        c.fillRect(x - w / 2, base - h - 3, w, 2.4);
      }
    });
  } else {
    for (const d of D.days) {
      if (d.t < dom[0] - 0.002 || d.t > dom[1] + 0.002) continue;
      const n = d.v1 - d.v0, x0 = bxf(d.t) - pxDay * 0.4, step = (pxDay * 0.8) / Math.max(1, n), lw = clamp(step * 0.6, 0.6, 3);
      for (let k = d.v0; k < d.v1; k++) {
        const v = D.votes[k], on = passes(v), x = x0 + (k - d.v0 + 0.5) * step, h = hg * (0.22 + 0.78 * v.margine);
        if (on) shown++;
        const hot = isFinal(v) || isTrust(v);
        c.strokeStyle = !on ? "rgba(21,21,21,.1)" : hot ? "#D2402B" : hover && hover.v === k ? "#D2402B" : "rgba(21,21,21,.7)";
        c.lineWidth = hot && on ? Math.max(1.4, lw) : lw;
        c.setLineDash(isSecret(v) ? [2, 2] : []);
        c.beginPath();
        c.moveTo(x, base);
        c.lineTo(x, base - h);
        c.stroke();
      }
    }
    c.setLineDash([]);
  }
  c.fillStyle = "#151515";
  c.fillRect(PADX, base, BW - 2 * PADX, 1);
  // assi
  c.fillStyle = "#5E5A52";
  c.font = '500 9.5px "IBM Plex Mono", ui-monospace, monospace';
  c.textAlign = "center";
  const y0 = +D.votes[0].data.slice(0, 4), y1 = +D.votes[D.V - 1].data.slice(0, 4);
  if (spanDays > 500) {
    for (let y = y0 + 1; y <= y1; y++) {
      const t = tOfDate(`${y}0101`);
      if (t < dom[0] || t > dom[1]) continue;
      const x = bxf(t);
      c.fillRect(x, base, 1, 5);
      c.fillText(String(y), x, base + 14);
    }
  } else if (spanDays > 40) {
    for (let y = y0; y <= y1; y++)
      for (let mo = 0; mo < 12; mo++) {
        const t = tOfDate(`${y}${String(mo + 1).padStart(2, "0")}01`);
        if (t < dom[0] || t > dom[1]) continue;
        const x = bxf(t);
        c.fillRect(x, base, 1, 4);
        if (spanDays < 240 || mo % 3 === 0) c.fillText(MESI3[mo] + (mo === 0 || spanDays < 150 ? " " + String(y).slice(2) : ""), x, base + 14);
      }
  } else {
    for (const d of D.days) {
      if (d.t < dom[0] || d.t > dom[1]) continue;
      const x = bxf(d.t);
      c.fillRect(x, base, 1, 4);
      if (pxDay > 22) c.fillText(`${+d.data.slice(6, 8)}/${+d.data.slice(4, 6)}`, x, base + 14);
    }
  }
  // votazione selezionata
  if (S.vote != null) {
    const v = D.votes[S.vote];
    if (v.t >= dom[0] && v.t <= dom[1]) {
      const d = D.days[v.day];
      const x = m === "vote" ? bxf(d.t) - pxDay * 0.4 + (v.i - d.v0 + 0.5) * ((pxDay * 0.8) / Math.max(1, d.v1 - d.v0)) : bxf(d.t);
      c.fillStyle = "#D2402B";
      c.fillRect(x - 1.5, 0, 3, base);
      c.beginPath();
      c.moveTo(x - 5, 0);
      c.lineTo(x + 5, 0);
      c.lineTo(x, 7);
      c.fill();
    }
  }
  if (drag && drag.moved) {
    const a = Math.min(drag.x0, drag.x1), b = Math.max(drag.x0, drag.x1);
    c.fillStyle = "rgba(210,64,43,.12)";
    c.fillRect(a, 0, b - a, base);
    c.strokeStyle = "#D2402B";
    c.lineWidth = 1;
    c.strokeRect(a + 0.5, 0.5, b - a, base - 1);
  }
  $("#bcCount").textContent = `${fmtN(shown)} votazioni`;
  $("#bcMode").textContent = m === "day" ? "1 linea = 1 seduta" : "1 linea = 1 votazione";
}

function hitAt(x: number): { v?: number; day: number } | null {
  const m = mode();
  const spanDays = ((dom[1] - dom[0]) * (D.T1 - D.T0)) / 86_400_000;
  const pxDay = (BW - 2 * PADX) / spanDays;
  let best = -1, bd = 1e9;
  D.days.forEach((d, k) => {
    if (d.t < dom[0] - 0.01 || d.t > dom[1] + 0.01) return;
    const dx = Math.abs(bxf(d.t) - x);
    if (dx < bd) {
      bd = dx;
      best = k;
    }
  });
  if (best < 0 || bd > Math.max(8, pxDay * 0.6)) return null;
  if (m === "day") return { day: best };
  const d = D.days[best], n = d.v1 - d.v0, x0 = bxf(d.t) - pxDay * 0.4, step = (pxDay * 0.8) / Math.max(1, n);
  let vb = -1, vd = 1e9;
  for (let k = d.v0; k < d.v1; k++) {
    if (!passes(D.votes[k])) continue;
    const dx = Math.abs(x0 + (k - d.v0 + 0.5) * step - x);
    if (dx < vd) {
      vd = dx;
      vb = k;
    }
  }
  return vb >= 0 && vd < Math.max(6, step) ? { v: vb, day: best } : { day: best };
}

// ---------------------------------------------------------------- animazione nel tempo

let playing = false;
let playTimer = 0;
let onFrame: ((k: number) => void) | null = null;
let onStop: (() => void) | null = null;
export const isPlaying = (): boolean => playing;
export function startPlay(frame: (k: number) => void, stop: () => void): void {
  onFrame = frame;
  onStop = stop;
  playing = true;
  $("#play").classList.add("on");
  $("#play").textContent = "■ Stop";
  let k = 0;
  const step = () => {
    if (!playing) return;
    if (k >= D.meta.mesi.length) {
      stopPlay(true);
      return;
    }
    onFrame?.(k++);
    playTimer = window.setTimeout(step, 650);
  };
  step();
}
export function stopPlay(natural = false): void {
  if (!playing) return;
  playing = false;
  clearTimeout(playTimer);
  $("#play").classList.remove("on");
  $("#play").textContent = "▶ Anima";
  onStop?.();
  void natural;
}
