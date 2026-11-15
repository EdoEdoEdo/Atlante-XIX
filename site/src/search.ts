// Barra comandi: interpreta il testo con regole e ricerca locale (nessuna AI)

import { AULA, D, W, actLabel, groupAt, isFinal, isSecret, isTrust, todayKey, type Aula } from "./data.js";
import { passes } from "./barcode.js";
import type { Filter, Lens, View } from "./state.js";
import { MESI, esc, fmtD, fmtDL, fmtN, nz } from "./util.js";

export type Action =
  | { kind: "day"; d: number }
  | { kind: "period"; a: string; b: string }
  | { kind: "filter"; f: Filter; a?: string; b?: string }
  | { kind: "lens"; lens: Lens }
  | { kind: "view"; view: View }
  | { kind: "dep"; i: number }
  | { kind: "cmp"; a: number; b: number }
  | { kind: "group"; g: string }
  | { kind: "area"; name: string; ids: number[] }
  | { kind: "votes"; title: string; kicker: string; ids: number[] }
  | { kind: "act"; atto: string };

export interface Result {
  group: string;
  label: string;
  small: string;
  dot?: string;
  action: Action;
}

const KW: [string, Filter, string][] = [
  ["contes", "cont", "Votazioni contese"], ["fiduc", "fiducia", "Fiducie"], ["final", "finale", "Voti finali"], ["segret", "segreta", "Votazioni segrete"],
  ["respint", "respinta", "Votazioni respinte"], ["strett", "stretto", "Margine stretto"],
];
const LK: [string, Lens, string][] = [
  ["cambi", "changes", "Colore: cambi di gruppo"], ["presen", "presence", "Colore: presenza al voto"], ["assen", "presence", "Colore: presenza al voto"],
  ["mission", "presence", "Colore: presenza al voto"], ["fedel", "dissent", "Colore: dissenso dal gruppo"], ["dissens", "dissent", "Colore: dissenso dal gruppo"],
  ["ribell", "dissent", "Colore: dissenso dal gruppo"], ["trasvers", "cross", "Colore: trasversalità"], ["somiglian", "sim", "Colore: somiglianza con…"],
];

// ---------------------------------------------------------------- leggi e atti (titoli dalle votazioni finali)

interface Atto {
  a: string;
  t: string;
  n: number;
  d: string;
  tok: string[];
}
const ATTI: Partial<Record<Aula, Atto[]>> = {};
const attiWait: Partial<Record<Aula, Promise<void>>> = {};
/** carica i titoli degli atti alla prima ricerca (circa 30 KB compressi) */
export function loadAtti(): Promise<void> {
  const aula = AULA;
  return (attiWait[aula] ??= fetch(`data/${aula}/atti.json`, { cache: "no-cache" })
    .then((r) => (r.ok ? r.json() : null))
    .then((j: { righe: [string, string, number, string, string][] } | null) => {
      if (!j) return;
      ATTI[aula] = j.righe.map(([a, t, n, d]) => ({ a, t, n, d, tok: nz(t).split(/[^a-z0-9]+/).filter(Boolean) }));
    })
    .catch(() => undefined));
}
export const attoTitle = (a: string): string | null => ATTI[AULA]?.find((x) => x.a === a)?.t ?? null;
const STOP = new Set("di del della dello dei degli delle e ed per in la il lo le i gli a al alla allo ai agli alle con su sul sulla da dal dalla un una uno n nel nella nei nelle legge leggi disegno ddl pdl atto".split(" "));
function findAtti(q: string, lim = 6): Atto[] {
  const atti = ATTI[AULA];
  if (!atti) return [];
  const qt = nz(q).split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !STOP.has(t));
  if (!qt.length) return [];
  const need = qt.length >= 3 ? qt.length - 1 : qt.length;
  return atti.map((x) => ({ x, s: qt.filter((t) => x.tok.some((w) => w.startsWith(t))).length }))
    .filter((r) => r.s >= need)
    .sort((p, r) => r.s - p.s || (p.x.d < r.x.d ? 1 : -1))
    .slice(0, lim)
    .map((r) => r.x);
}

const titleIdx: Partial<Record<Aula, string[]>> = {};
const titles = (): string[] => (titleIdx[AULA] ??= D.votes.map((v) => nz(`${v.titolo} ${actLabel(v)} ${v.tipo}`)));

export function findDeps(q: string, lim = 6): number[] {
  const tk = nz(q).split(" ").filter(Boolean);
  if (!tk.length) return [];
  const score = (i: number): number => {
    const d = D.deputies[i], n = d.nz, l = nz(d.cognome);
    let s = 0;
    for (const t of tk) {
      if (l === t) s += 3;
      else if (l.startsWith(t)) s += 2;
      else if (n.includes(t)) s += 1;
      else return -1;
    }
    return s + (d.mandato[1] ? 0 : 0.1);
  };
  return D.deputies.map((d) => [d.i, score(d.i)] as const).filter((x) => x[1] > 0).sort((a, b) => b[1] - a[1] || D.deputies[a[0]].cognome.localeCompare(D.deputies[b[0]].cognome, "it")).slice(0, lim).map((x) => x[0]);
}

const mi = (s: string): number => (s.length >= 3 ? MESI.findIndex((x) => x.startsWith(s)) : -1);
const pad = (n: number): string => String(n).padStart(2, "0");
const lastDay = (y: number, m: number): string => String(new Date(Date.UTC(y, m, 0)).getUTCDate());

export function search(raw: string): Result[] {
  const q = nz(raw);
  const R: Result[] = [];
  if (!q) return R;
  const add = (group: string, label: string, small: string, action: Action, dot?: string) => R.push({ group, label, small, action, dot });
  const dayRes = (d: string) => {
    const k = D.days.findIndex((x) => x.data === d);
    if (k >= 0) add("Data", fmtDL(d), `${D.days[k].v1 - D.days[k].v0} votazioni`, { kind: "day", d: k });
    else {
      const nx = D.days.find((x) => x.data > d);
      add("Data", fmtD(d), "nessuna votazione quel giorno", nx ? { kind: "day", d: nx.i } : { kind: "view", view: "map" });
      if (nx) add("Data", "Seduta successiva: " + fmtD(nx.data), `${nx.v1 - nx.v0} votazioni`, { kind: "day", d: nx.i });
    }
  };
  let m: RegExpExecArray | null;
  let dated = false;
  if ((m = /^(\d{1,2})\s+([a-z]+)\s+(\d{4})$/.exec(q)) && mi(m[2]) >= 0) {
    dayRes(`${m[3]}${pad(mi(m[2]) + 1)}${pad(+m[1])}`);
    dated = true;
  } else if ((m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(q))) {
    dayRes(`${m[3]}${pad(+m[2])}${pad(+m[1])}`);
    dated = true;
  } else if ((m = /^([a-z]+)\s+(\d{4})$/.exec(q)) && mi(m[1]) >= 0) {
    const y = +m[2], mo = mi(m[1]) + 1;
    const a = `${y}${pad(mo)}01`, b = `${y}${pad(mo)}${lastDay(y, mo)}`;
    const n = D.votes.filter((v) => v.data >= a && v.data <= b).length;
    add("Periodo", `${MESI[mo - 1][0].toUpperCase()}${MESI[mo - 1].slice(1)} ${y}`, `${fmtN(n)} votazioni`, { kind: "period", a, b });
    dated = true;
  }
  const yr = /\b(202[2-7])\b/.exec(q)?.[1];
  const kw = KW.find((k) => q.includes(k[0]));
  if (kw) {
    const a = yr ? `${yr}0101` : undefined, b = yr ? `${yr}1231` : undefined;
    const n = D.votes.filter((v) => passes(v, kw[1]) && (!a || (v.data >= a && v.data <= b!))).length;
    add("Filtro", kw[2] + (yr ? " · " + yr : ""), `${fmtN(n)} votazioni`, { kind: "filter", f: kw[1], a, b });
    dated = true;
  } else if (yr && /^\d{4}$/.test(q)) {
    const n = D.votes.filter((v) => v.data.startsWith(yr)).length;
    add("Periodo", "Anno " + yr, `${fmtN(n)} votazioni`, { kind: "period", a: `${yr}0101`, b: `${yr}1231` });
    dated = true;
  }
  const lk = LK.find((l) => q.includes(l[0]));
  if (lk) add("Colore", lk[2], "cambia il colore dei punti", { kind: "lens", lens: lk[1] });
  if (/emicicl|aula/.test(q)) add("Tavola", "Tav. I — Emiciclo", "", { kind: "view", view: "hemi" });
  if (/^mappa/.test(q)) add("Tavola", "Tav. II — Mappa dei voti", "", { kind: "view", view: "map" });
  if ((m = /^(?:ac|as|s|ddl|atto)\s*(\d+)$/.exec(q))) {
    const num = m[1];
    const acts = new Map<string, number>();
    D.votes.forEach((v) => v.atto.split(" ").forEach((a) => a && a.replace(/^0+/, "").startsWith(num) && acts.set(a, (acts.get(a) ?? 0) + 1)));
    [...acts.entries()].slice(0, 8).forEach(([a, n]) => add("Atti", `${W().atto} ${a.replace(/^0+/, "")}`, `${n} votazioni`, { kind: "act", atto: a }));
    dated = true;
  }
  // confronto
  const vs = /^(.+?)\s+(?:vs\.?|contro|\/)\s+(.+)$/i.exec(raw.trim()) || /^confronta\s+(.+?)\s+(?:con|e)\s+(.+)$/i.exec(raw.trim());
  if (vs) {
    const A = findDeps(vs[1], 1)[0], B = findDeps(vs[2], 1)[0];
    if (A != null && B != null && A !== B) add("Confronto", `${D.deputies[A].name}  ⇄  ${D.deputies[B].name}`, "uno contro uno", { kind: "cmp", a: A, b: B });
    dated = true;
  }
  // gruppi
  D.groups.forEach((g) => {
    if (q.length >= 2 && (nz(g.nome).includes(q) || nz(g.sigla) === q || nz(g.id) === q)) add("Gruppi", g.nome, "scheda del gruppo", { kind: "group", g: g.id }, g.colore);
  });
  // circoscrizioni
  if (q.length >= 3) {
    const areas = new Map<string, number[]>();
    D.deputies.forEach((d) => {
      const c = d.elezione.circoscrizione;
      if (c && nz(c).includes(q) && !d.mandato[1]) {
        if (!areas.has(c)) areas.set(c, []);
        areas.get(c)!.push(d.i);
      }
    });
    [...areas.entries()].slice(0, 5).forEach(([c, ids]) => add("Circoscrizioni", titleCase(c), `${ids.length} ${W().membri} in carica eletti qui`, { kind: "area", name: c, ids }));
  }
  if (q.length >= 2 && !dated) {
    findDeps(raw).forEach((i) => {
      const d = D.deputies[i];
      const g = groupAt(d, d.mandato[1] || todayKey());
      add(W().Membri, d.name, `${g ? D.G[g].sigla : ""}${d.mandato[1] ? " · fino al " + fmtD(d.mandato[1]) : ""}`, { kind: "dep", i }, g ? D.G[g].colore : undefined);
    });
  }
  if (q.length >= 3 && !dated) {
    findAtti(raw).forEach((x) =>
      add("Leggi e atti", x.t.length > 92 ? x.t.slice(0, 90) + "…" : x.t, `${W().atto} ${x.a.replace(/^0+/, "")} · ${x.n} vot. · ${fmtD(x.d).replace(/^\d+ /, "")}`, { kind: "act", atto: x.a }),
    );
  }
  if (q.length >= 3 && !dated) {
    const T = titles();
    const ids: number[] = [];
    T.forEach((t, k) => t.includes(q) && ids.push(k));
    if (ids.length) {
      const byAct = new Map<string, number>();
      ids.forEach((k) => D.votes[k].atto.split(" ").forEach((a) => a && byAct.set(a, (byAct.get(a) ?? 0) + 1)));
      [...byAct.entries()].slice(-3).reverse().forEach(([a, n]) => add("Votazioni", `${W().atto} ${a.replace(/^0+/, "")}`, `${n} votazioni`, { kind: "act", atto: a }));
      add("Votazioni", `Tutte le votazioni con «${raw.trim()}»`, `${fmtN(ids.length)} votazioni`, { kind: "votes", title: `«${raw.trim()}»`, kicker: "Ricerca", ids });
    }
  }
  return R;
}

export function renderResults(R: Result[], sel: number, query: string, examples: string[]): string {
  if (!query.trim())
    return `<div class="cg">Prova</div>` + examples.map((s) => `<button class="ci" type="button" data-q="${esc(s)}" role="option"><span>${esc(s)}</span><small>esempio</small></button>`).join("");
  if (!R.length)
    return `<div class="cmdk-empty">Nessun risultato per «${esc(query)}». Prova con una data (10 maggio 2024), un tipo di voto (fiducie 2025), un cognome, una circoscrizione o un tema.</div>`;
  let h = "", last = "";
  R.forEach((r, k) => {
    if (r.group !== last) {
      h += `<div class="cg">${esc(r.group)}</div>`;
      last = r.group;
    }
    h += `<button class="ci${k === sel ? " on" : ""}" type="button" data-k="${k}" role="option" aria-selected="${k === sel}"><span>${r.dot ? `<i class="dot" style="background:${r.dot}"></i>` : ""}${esc(r.label)}</span><small>${esc(r.small)}</small></button>`;
  });
  return h;
}

export const titleCase = (s: string): string => s.toLowerCase().replace(/(^|[\s'’(/-])(\p{L})/gu, (_m, a, b) => a + b.toUpperCase());
export { isFinal, isSecret, isTrust };
