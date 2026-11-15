// Schede: deputato, votazione, seduta, confronto, gruppo, elenchi, indice

import {
  AULA, D, W, actLabel, breakdown, codeLabel, compare, deputyFile, groupAt, isFinal, isSecret, isTrust, monthOf, plurality, sideAt, todayKey,
  memberWord, typeLabel, voteExtra, voteRow,
} from "./data.js";
import { metrics } from "./lenses.js";
import { S, type Card } from "./state.js";
import { curVote, tColor } from "./stage.js";
import type { Deputy, Group, Vote } from "./types.js";
import { esc, fmtD, fmtDL, fmtM, fmtN, fmtS, pc } from "./util.js";

const SIDE_L: Record<number, string> = { 1: "maggioranza", 2: "opposizione", 0: "non schierato" };
const LOD = "https://dati.camera.it/ocd/";

const gchip = (g: Group | undefined, extra = ""): string =>
  g ? `<span class="gchip" style="--c:${g.colore}"><i></i>${esc(g.nome)}${extra}</span>` : "";
const dotHTML = (c: string): string => `<i class="dot" style="background:${c}"></i>`;
const linkVote = (v: Vote, text?: string): string =>
  `<button class="pl" type="button" data-act="vote" data-v="${v.i}"><span class="plt">${isFinal(v) || isTrust(v) ? '<span class="fin">●</span>' : ""}<span>${esc(text ?? v.titolo)}</span></span><small>${fmtS(v.data)}</small></button>`;
const linkDep = (j: number, small: string): string => {
  const d = D.deputies[j];
  const g = d.gruppo ? D.G[d.gruppo] : undefined;
  return `<button class="pl" type="button" data-act="dep" data-i="${j}"><span class="plt">${g ? dotHTML(g.colore) : ""}<span>${esc(d.name)}</span></span><small>${esc(small)}</small></button>`;
};
const loading = (what: string): string => `<p class="cs loading-line">Carico ${esc(what)}…</p>`;

export function renderCard(card: Card, back: Card | undefined): string {
  let h = "";
  switch (card.type) {
    case "dep": h = depCard(card.i); break;
    case "vote": h = voteCard(D.votes[card.v]); break;
    case "day": h = dayCard(card.d); break;
    case "cmp": h = cmpCard(card.a, card.b); break;
    case "group": h = groupCard(card.g); break;
    case "list": h = listCard(card); break;
    case "simpick":
      h = `<div class="ck">Somiglianza con…</div><div class="ct s">Scegli un ${W().membro}.</div><p class="cs">Tocca un punto sulla tavola o cercalo per nome. Tutti gli altri punti si colorano in base a quanto votano come lui.</p><div class="sec"><button class="btn" type="button" data-act="cmdk">Cerca un nome <span>⌘K</span></button></div>`;
      break;
    default: h = homeCard();
  }
  return (card.type !== "home" && back ? backBtn(back) : "") + h;
}

function backBtn(p: Card): string {
  const l: Record<string, string> = { dep: W().Membro, vote: "Votazione", day: "Seduta", list: "Elenco", cmp: "Confronto", group: "Gruppo", home: "Indice", simpick: "Indice" };
  let t = "";
  if (p.type === "dep") t = D.deputies[p.i].name;
  else if (p.type === "vote") t = fmtS(D.votes[p.v].data);
  else if (p.type === "group") t = D.G[p.g]?.sigla ?? "";
  return `<button class="back" type="button" data-act="back">← ${l[p.type]}${t ? ": " + esc(t) : ""}</button>`;
}

// ---------------------------------------------------------------- indice

function homeCard(): string {
  const m = D.meta;
  const sug = ["fiducie 2025", "contese 2024", AULA === "senato" ? "Lombardia" : "Lombardia 1", "legge di bilancio", "cambi di gruppo", AULA === "senato" ? "autonomie" : "minoranze"];
  return `<div class="ck">Indice · ${W().aulaLunga}</div><div class="ct">Fai una domanda ai dati.</div>
  <p class="cs">Tocca un punto per aprire un ${W().membro}. Tocca il codice a barre per aprire una seduta. Trascina sul codice a barre per scegliere un periodo.</p>
  <div class="sec"><div class="sh">Le tavole</div><div class="idx">
    <button type="button" data-act="view" data-view="hemi"><span class="rn">I</span><span class="t">Emiciclo<small>Dove siedono, gruppo per gruppo. Con una votazione: chi ha votato cosa.</small></span></button>
    <button type="button" data-act="view" data-view="map"><span class="rn">II</span><span class="t">Mappa dei voti<small>Vicini = votano in modo simile sulle votazioni contese.</small></span></button>
    <button type="button" data-act="view" data-view="vote"><span class="rn">III</span><span class="t">Voto<small>Una votazione in colonne: favorevoli, contrari, astenuti, ${AULA === "senato" ? "chi era assente o presente senza votare, chi era in congedo o missione" : "chi non ha partecipato, chi era in missione"}.</small></span></button>
  </div></div>
  <div class="sec"><div class="sh">Prova</div><div class="sug">${sug.map((s) => `<button class="chip" type="button" data-act="q" data-q="${esc(s)}">${esc(s)}</button>`).join("")}</div></div>
  <div class="sec"><div class="sh">In numeri</div><div class="kv">
    <div><b>${fmtN(m.votazioni)}</b>votazioni</div><div><b>${pc(m.contese / m.valide, 0)}</b>contese</div><div><b>${fmtN(m.finali)}</b>voti finali</div>
    <div><b>${m.fiducie}</b>fiducie</div><div><b>${m.segrete}</b>segrete</div><div><b>${(m.cambi.individuale ?? 0) + (m.cambi.scissione ?? 0)}</b>cambi di gruppo</div>
    <div><b>${m.deputati}</b>${W().membri}</div><div><b>${m.sedute}</b>sedute con voti</div><div><b>${m.incomplete}</b>votazioni incomplete</div></div></div>
  <div class="sec"><p class="mini">Fonte: ${W().fonte} (CC BY)${AULA === "camera" ? " e schede ufficiali delle votazioni" : ""}. Dati aggiornati al ${fmtD(m.aggiornato)}.</p>
  <div class="links"><a href="#metodologia"><span>Metodologia</span><span>→</span></a></div>
  <p class="mini credits">Progetto di <a class="cred" href="https://www.edoedoedo.it/" target="_blank" rel="noopener">EDOEDOEDO</a> · <a href="https://github.com/EdoEdoEdo" target="_blank" rel="noopener">GitHub</a></p></div>`;
}

// ---------------------------------------------------------------- deputato

function lineChart(series: { vals: (number | null)[]; col: string; dash?: string }[], opts: { h?: number; markers?: { m: number; l: string }[] } = {}): string {
  const months = D.meta.mesi, NM = months.length;
  const W = 300, h = opts.h ?? 92, L = 26, R = 6, T = 8, B = 16, iw = W - L - R, ih = h - T - B;
  const X = (m: number) => L + (m / (NM - 1)) * iw, Y = (v: number) => T + (1 - v) * ih;
  let s = `<svg viewBox="0 0 ${W} ${h}" role="img" aria-label="Andamento mese per mese">`;
  [0, 0.5, 1].forEach((v) => {
    s += `<line x1="${L}" x2="${W - R}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}" stroke="#CFC8BA" ${v ? 'stroke-dasharray="2 3"' : ""}/><text x="${L - 4}" y="${(Y(v) + 3).toFixed(1)}" text-anchor="end">${v * 100}%</text>`;
  });
  months.forEach((m, k) => {
    if (m.endsWith("01")) s += `<line x1="${X(k)}" x2="${X(k)}" y1="${T + ih}" y2="${T + ih + 3}" stroke="#151515"/><text x="${X(k)}" y="${h - 3}" text-anchor="middle">${m.slice(0, 4)}</text>`;
  });
  (opts.markers ?? []).forEach((mk) => {
    const x = X(mk.m).toFixed(1);
    s += `<line x1="${x}" x2="${x}" y1="${T}" y2="${T + ih}" stroke="#D2402B" stroke-width="1.2" stroke-dasharray="3 2"/><text x="${+x + 3}" y="${T + 7}" class="acc">${esc(mk.l)}</text>`;
  });
  series.forEach((se) => {
    let d = "", pen = false;
    se.vals.forEach((v, m) => {
      if (v == null) {
        pen = false;
        return;
      }
      d += (pen ? "L" : "M") + X(m).toFixed(1) + " " + Y(v).toFixed(1);
      pen = true;
    });
    s += `<path d="${d}" fill="none" stroke="${se.col}" stroke-width="1.8" ${se.dash ? `stroke-dasharray="${se.dash}"` : ""} stroke-linejoin="round" stroke-linecap="round"/>`;
  });
  return s + "</svg>";
}

function groupHistory(d: Deputy): string {
  if (d.gruppi.length < 2) return "";
  const kinds: Record<string, string> = { individuale: "", scissione: " · scissione del gruppo", componente: " · cambio di componente" };
  return `<div class="ghist">${d.gruppi
    .map((s, k) => {
      const g = D.G[s.g];
      const ch = d.cambi.find((c) => c.a === s.g && c.data === s.da);
      return `<div>${gchip(g)}<span>${k === 0 ? fmtM(d.mandato[0] || s.da) : fmtM(s.da)} – ${k === d.gruppi.length - 1 && !d.mandato[1] ? "oggi" : fmtM(s.a)}${ch ? esc(kinds[ch.tipo] ?? "") : ""}</span></div>`;
    })
    .join("")}</div>`;
}

function depCard(i: number): string {
  const d = D.deputies[i];
  const date = d.mandato[1] && d.mandato[1] < tColor() ? d.mandato[1] : tColor();
  const gid = groupAt(d, date);
  const g = gid ? D.G[gid] : undefined;
  const side = sideAt(d, date);
  const m = metrics()[i];
  const mAll = metrics();
  const regs = D.deputies.filter((x) => !x.president && mAll[x.i].pres != null);
  const med = (k: "pres" | "dissent" | "cross") => {
    const a = regs.map((x) => mAll[x.i][k]).filter((x): x is number => x != null).sort((p, q) => p - q);
    return a.length ? a[a.length >> 1] : 0;
  };
  const e = d.elezione;
  const meta: string[] = [];
  if (e.circoscrizione)
    meta.push(`Eletto${d.genere === "female" ? "a" : ""} nella circoscrizione ${esc(titleCase(e.circoscrizione))}${e.collegio ? " · collegio " + esc(e.collegio) : ""} · ${esc(e.tipo || "")}${e.lista ? " · lista " + esc(titleCase(e.lista)) : ""}`);
  else if (e.tipo) meta.push(`${memberWord(d, true)} ${esc(e.tipo)}`); // senatori a vita e di diritto
  if (d.mandato[0] > "20221101") meta.push(`In carica dal ${fmtD(d.mandato[0])}`);
  if (d.mandato[1]) meta.push(`Mandato concluso il ${fmtD(d.mandato[1])}`);
  const roles = d.ruoli
    .map((r) => `<span class="r">${esc(r.ruolo)}${r.a ? ` (fino al ${fmtS(r.a)})` : ""}</span>`)
    .join("");
  // in questa votazione
  let inV = "";
  const v = curVote();
  if (v) {
    const row = voteRow(v);
    const ch = row ? row.charAt(i) : "";
    inV = `<div class="sec"><div class="sh">In questa votazione · ${fmtS(v.data)}</div>${
      row ? `<div class="big-n"><b style="font-size:24px;color:${ch === "C" ? "var(--accent)" : "var(--ink)"}">${codeLabel(ch) || "—"}</b></div>` : loading("la votazione")
    }<button class="lnk" type="button" data-act="vote" data-v="${v.i}" style="align-self:flex-start">${esc(v.titolo)}</button></div>`;
  }
  let leg = "";
  if (d.president) leg = `<p class="cs">Il ${W().presidente}, per prassi, non vota. È escluso dalle classifiche.</p>`;
  else if (m.T < 30) leg = `<p class="cs">Meno di 30 votazioni nel periodo: le metriche non sono mostrate.</p>`;
  else {
    const w1 = m.V / m.T, w2 = m.N / m.T, w3 = m.M / m.T;
    const misto = !!(g && g.misto);
    const mp = med("pres"), md = med("dissent"), mc = med("cross");
    leg = `<div class="meter-row"><span class="l">Presenza al voto</span><span class="v">${pc(m.pres)}</span></div>
    <div class="stack" title="Ha votato · ${codeLabel("N")} · ${W().missione}"><div style="width:${w1 * 100}%;background:var(--ink)"></div><div style="width:${w2 * 100}%;background:var(--rule-2)"></div><div class="hatch" style="width:${w3 * 100}%"></div><span class="med" style="left:${mp * 100}%"></span></div>
    <div class="sleg"><span><i style="background:var(--ink)"></i>Ha votato ${fmtN(m.V)}</span><span><i style="background:var(--rule-2)"></i>${AULA === "senato" ? "Non ha votato" : "Non ha partecipato"} ${fmtN(m.N)}</span><span><i class="hatch"></i>${W().missione} ${fmtN(m.M)}</span></div>
    <p class="mini">Su ${fmtN(m.T)} votazioni${S.period ? " nel periodo" : ""}. Mediana ${W().dellaAula} ${pc(mp)} (linea rossa).${d.gov ? ` Membro del Governo: ${AULA === "senato" ? "congedi e missioni sono frequenti" : "le missioni sono frequenti"}.` : ""}</p>
    <div class="meter-row" style="margin-top:8px"><span class="l">Vota col suo gruppo</span><span class="v">${misto ? "—" : pc(m.dissent == null ? null : 1 - m.dissent)}</span>${
      misto
        ? '<span class="x">Il Misto non ha una posizione di gruppo: il dissenso non è calcolato.</span>'
        : `<div class="bar"><i style="width:${(1 - (m.dissent ?? 0)) * 100}%;background:${g?.colore ?? "var(--ink)"}"></i><span class="med" style="left:${(1 - md) * 100}%"></span></div><span class="x">${fmtN(m.DD)} voti in dissenso su ${fmtN(m.DB)}. Mediana ${W().dellaAula} ${pc(1 - md)}.</span>`
    }</div>
    <div class="meter-row"><span class="l">Trasversalità</span><span class="v">${pc(m.cross)}</span><div class="bar"><i style="width:${Math.min(1, (m.cross ?? 0) / 0.3) * 100}%"></i><span class="med" style="left:${Math.min(1, mc / 0.3) * 100}%"></span></div><span class="x">Ha votato come l'altro schieramento in ${fmtN(m.CC)} voti contesi su ${fmtN(m.CB)}. Scala 0–30%.</span></div>`;
  }
  const f = deputyFile(i);
  let withWho = "", chart = "", near = "", notable = "", pbc = "";
  if (!d.president) {
    if (!f) {
      withWho = loading(`i dati del ${W().membro}`);
    } else {
      const block = S.base === "cont" ? f.accordo_gruppi.contese : f.accordo_gruppi.tutte;
      const rows = Object.entries(block.totale)
        .map(([gk, [val, n]]) => ({ g: D.G[gk], val, n }))
        .filter((r) => r.g && r.g.id !== "ALT")
        .sort((a, b) => sideRank(a.g.lato, side) - sideRank(b.g.lato, side) || b.val - a.val);
      let last = -1;
      withWho = rows
        .map((r) => {
          let div = "";
          if (last !== -1 && r.g.lato !== last) div = `<div class="ag-div"><span>${SIDE_L[r.g.lato]}</span></div>`;
          last = r.g.lato;
          return `${div}<button class="ag" type="button" data-act="hlgroup" data-g="${r.g.id}" title="${fmtN(r.n)} votazioni"><span class="agn">${dotHTML(r.g.colore)}${esc(r.g.sigla)}${r.g.id === gid ? " <small>suo</small>" : ""}</span><span class="agb"><i style="width:${r.val * 100}%;background:${r.g.colore}"></i></span><span class="agv">${pc(r.val, 0)}</span></button>`;
        })
        .join("");
      const own = gid && block.mensile[gid] ? gid : null;
      const others = rows.filter((r) => r.g.id !== gid);
      const nearG = others[0]?.g;
      const markers = d.cambi.map((c) => ({ m: D.meta.mesi.indexOf(c.data.slice(0, 6)), l: "→ " + (D.G[c.a]?.sigla ?? c.a) }));
      chart = `<div class="chart">${lineChart(
        [own ? { vals: block.mensile[own], col: "#151515" } : { vals: [], col: "#000" }, nearG && block.mensile[nearG.id] ? { vals: block.mensile[nearG.id], col: nearG.colore, dash: "4 2" } : { vals: [], col: "#000" }],
        { markers },
      )}</div><div class="sleg">${own ? `<span><i style="background:var(--ink)"></i>${esc(D.G[own].sigla)} (suo gruppo)</span>` : ""}${nearG ? `<span><i style="background:${nearG.colore}"></i>${esc(nearG.sigla)} (il più vicino tra gli altri)</span>` : ""}</div>`;
      near = f.vicini.map((o) => linkDep(o.i, `${pc(o.accordo, 0)} · ${fmtN(o.comuni)} in comune`)).join("") || '<p class="cs">Nessuno sopra la soglia di 50 votazioni in comune.</p>';
      const nv = f.voti_notevoli.map((id) => D.votes[D.vById.get(id) ?? -1]).filter(Boolean).slice(-6).reverse();
      notable = nv.map((vo) => linkVote(vo, `${typeLabel(vo)}: ${actLabel(vo) || vo.titolo}`)).join("") || '<p class="cs">Nessun voto finale o fiducia in dissenso dal gruppo.</p>';
      pbc = `<div class="pbc-wrap"><div class="lab"><span>F</span><span>C</span><span>A</span></div><canvas class="pbc" data-i="${i}" aria-label="Voti favorevoli, contrari e astensioni nel tempo"></canvas></div><div class="pbc-ax"><span>${fmtM(D.votes[0].data)}</span><span>${fmtM(D.votes[D.V - 1].data)}</span></div>`;
    }
  }
  const B = S.base;
  return `<div class="ck">${gchip(g)}<span>· ${SIDE_L[side]}</span>${roles}</div>
  <div class="ct">${esc(d.name)}</div>
  <p class="cs">${meta.join("<br>")}</p>
  ${groupHistory(d)}
  ${inV}
  <div class="sec"><div class="sh"><span>Legislatura${S.period ? " · periodo scelto" : ""}</span><a class="lnk" href="#m-presenza">Metodo</a></div>${leg}</div>
  ${
    d.president
      ? ""
      : `<div class="sec"><div class="sh"><span>Con chi vota</span><span class="seg"><button type="button" data-act="base" data-base="cont" class="${B === "cont" ? "on" : ""}">Contese</button><button type="button" data-act="base" data-base="all" class="${B === "all" ? "on" : ""}">Tutte</button></span></div>
    ${withWho}<p class="mini">Quota di votazioni ${B === "cont" ? "contese " : ""}in cui ha votato come la posizione di ciascun gruppo. Tocca un gruppo per evidenziarlo.</p>
    ${chart ? `<div class="sh" style="margin-top:6px"><span>Andamento mese per mese</span></div>${chart}` : ""}</div>
  ${pbc ? `<div class="sec"><div class="sh"><span>Come ha votato</span></div>${pbc}</div>` : ""}
  ${f ? `<div class="sec"><div class="sh"><span>Più vicini fuori dal gruppo</span><span>contese</span></div>${near}</div>
  <div class="sec"><div class="sh"><span>Voti notevoli</span><span>${f.voti_notevoli.length} in dissenso</span></div><p class="mini">Voti finali e fiducie in cui ha votato diversamente dal suo gruppo.</p>${notable}</div>` : ""}`
  }
  <div class="sec"><div class="acts">
    <button class="btn k" type="button" data-act="simlens" data-i="${i}">Colora per somiglianza <span>◐</span></button>
    <button class="btn" type="button" data-act="cmp-start" data-i="${i}">Confronta con… <span>⇄</span></button></div>
    <div class="links"><a href="${AULA === "senato" ? `https://www.senato.it/leg/19/BGT/Schede/Attsen/${d.id.padStart(8, "0")}.htm` : `${LOD}deputato.rdf/d${d.id}_19`}" target="_blank" rel="noopener"><span>${AULA === "senato" ? "Scheda sul sito del Senato" : "Scheda nei dati aperti della Camera"}</span><span>↗</span></a><button type="button" data-act="share"><span>Copia il link a questa vista</span><span>⧉</span></button></div></div>`;
}
/** prima lo schieramento del deputato, poi i non schierati, poi l'altro */
const sideRank = (s: number, own: number): number => (s === own ? 0 : s === 0 ? 1 : own === 0 ? s + 1 : 2);
const titleCase = (s: string): string => s.toLowerCase().replace(/(^|[\s'’(/-])(\p{L})/gu, (_m, a, b) => a + b.toUpperCase());

// ---------------------------------------------------------------- votazione

function voteCard(v: Vote): string {
  const fin = isFinal(v) || isTrust(v);
  const row = voteRow(v);
  const ex = voteExtra(v);
  const tags = `<span class="tag ${fin ? "r" : ""}">${esc(typeLabel(v))}</span>${v.contesa ? '<span class="tag f">Contesa</span>' : ""}${isSecret(v) ? '<span class="tag">Segreta</span>' : ""}${v.stato === 1 ? '<span class="tag">Voti incompleti</span>' : ""}<span>${fmtDL(v.data)}</span>`;
  // totali ufficiali quando ci sono; altrimenti la regola ordinaria (al Senato gli astenuti sono tra i votanti)
  const votanti = ex.votanti ?? (AULA === "senato" ? v.F + v.C + v.A : v.F + v.C);
  const mag = ex.maggioranza ?? Math.floor((v.F + v.C) / 2) + 1, tot = v.F + v.C + v.A || 1;
  const res = `<div class="rb"><div class="bar"><div style="width:${(v.F / tot) * 100}%;background:var(--ink)"></div><div style="width:${(v.C / tot) * 100}%;background:var(--accent)"></div><div style="width:${(v.A / tot) * 100}%;background:var(--abst)"></div><span class="thr" style="left:${Math.min(mag / tot, 1) * 100}%"></span></div><div class="lab"><span>F ${v.F}</span><span>Maggioranza ${mag}</span><span>C ${v.C} · A ${v.A}</span></div></div>`;
  let groups = "", dis = "", kv = "";
  if (isSecret(v) || v.stato === 1) {
    groups = `<div class="sec"><div class="sh">${isSecret(v) ? "Voto segreto" : "Voti individuali incompleti"}</div><p class="cs">${
      isSecret(v)
        ? `Esistono solo i totali: non si sa come ha votato ciascun ${W().membro}. La votazione è esclusa dalle metriche individuali.`
        : `La ${W().aula} non ha pubblicato tutti i voti dei singoli ${W().membri} per questa votazione: i totali qui sopra sono quelli ufficiali. È esclusa dalle metriche individuali.`
    }</p></div>`;
  } else if (!row) {
    groups = `<div class="sec">${loading(`i voti dei ${W().membri}`)}</div>`;
  } else {
    const b = breakdown(v, row);
    const order = D.groups.slice().sort((x, y) => x.ordine - y.ordine);
    const rows = order
      .map((g) => {
        const c = b.byGroup[g.id];
        if (!c) return "";
        const n = c.F + c.C + c.A + c.N + c.M + c.P;
        const pos = plurality(c.F, c.C, c.A);
        const seg = (x: number, col: string) => (x ? `<div style="width:${(x / n) * 100}%;background:${col}"></div>` : "");
        return `<button class="gb" type="button" data-act="hlvote" data-g="${g.id}"><span class="n">${dotHTML(g.colore)}<span>${esc(g.sigla)}</span><small>${pos ? codeLabel(pos).slice(0, 4) + "." : "diviso"}</small></span><span class="s">${seg(c.F, "var(--ink)")}${seg(c.C, "var(--accent)")}${seg(c.A, "var(--abst)")}${seg(c.M, "var(--rule-2)")}</span></button>`;
      })
      .join("");
    groups = `<div class="sec"><div class="sh"><span>Come hanno votato i gruppi</span><span>F · C · A · M</span></div>${rows}<div class="sleg"><span><i style="background:var(--ink)"></i>Favorevoli</span><span><i style="background:var(--accent)"></i>Contrari</span><span><i style="background:var(--abst)"></i>Astenuti</span><span><i style="background:var(--rule-2)"></i>${W().missione}</span><span><i style="background:var(--paper-2)"></i>${AULA === "senato" ? "Non votano" : "Non partecipano"}</span></div></div>`;
    const why = v.contesa
      ? `<p class="cs">Contesa: la maggioranza ha votato <b>${(codeLabel(b.posMaj) || "—").toLowerCase()}</b>, l'opposizione <b>${(codeLabel(b.posOpp) || "—").toLowerCase()}</b>.</p>`
      : `<p class="cs">Non contesa: maggioranza e opposizione hanno votato allo stesso modo${b.posMaj ? " (" + codeLabel(b.posMaj).toLowerCase() + ")" : ""}.</p>`;
    dis = `<div class="sec"><div class="sh"><span>Dissensi</span></div>${why}<p class="cs"><b>${b.dissenters.length}</b> ${W().membri} hanno votato diversamente dalla posizione del proprio gruppo.</p>${
      b.dissenters.length ? '<button class="btn" type="button" data-act="hldis" style="align-self:flex-start">Evidenziali sulla tavola <span>●</span></button>' : ""
    }</div>`;
    let M = 0, N = 0, NV = 0;
    for (const ch of row) {
      if (ch === "M") M++;
      else if (ch === "N" || ch === "P") N++;
      else if (ch === "V") NV++;
    }
    kv = `<div><b>${M}</b>${W().missione.toLowerCase()}</div><div><b>${N}</b>${AULA === "senato" ? "assenti" : "non hanno partecipato"}</div>${AULA === "senato" ? `<div><b>${NV}</b>presenti non votanti</div>` : ""}`;
  }
  const day = D.days[v.day];
  const prev = v.i > day.v0 ? v.i - 1 : null, next = v.i < day.v1 - 1 ? v.i + 1 : null;
  const acts = v.atto ? v.atto.split(" ") : [];
  return `<div class="ck">${tags}</div>
  <div class="ct s">${esc(v.titolo)}</div>
  ${ex.descrizione ? `<p class="cs">${esc(ex.descrizione)}</p>` : actLabel(v) ? `<p class="cs">${esc(actLabel(v))}</p>` : ""}
  <div class="sec"><div class="sh"><span>Esito</span><span>seduta ${v.seduta} · n. ${v.n}</span></div>
    <div class="big-n"><b style="color:${v.esito ? "var(--ink)" : "var(--accent)"}">${v.esito ? "Approvata" : "Respinta"}</b><span>margine ${pc(v.margine, 0)}</span></div>${res}
    <div class="kv"><div><b>${v.presenti}</b>presenti</div><div><b>${votanti}</b>votanti</div><div><b>${mag}</b>maggioranza</div>${kv}</div></div>
  ${groups}${dis}
  <div class="sec"><div class="acts"><button class="btn" type="button" data-act="vote" data-v="${prev ?? ""}" ${prev == null ? "disabled" : ""}>← Precedente</button><button class="btn" type="button" data-act="vote" data-v="${next ?? ""}" ${next == null ? "disabled" : ""}>Successiva →</button></div>
  <div class="links"><button type="button" data-act="day" data-d="${v.day}"><span>Tutte le votazioni della seduta</span><span>${day.v1 - day.v0}</span></button>${acts.map((a) => `<button type="button" data-act="act" data-a="${esc(a)}"><span>Tutte le votazioni su ${W().atto} ${esc(a.replace(/^0+/, ""))}</span><span>→</span></button>`).join("")}
  ${ex.scheda ? `<a href="${esc(ex.scheda)}" target="_blank" rel="noopener"><span>${AULA === "senato" ? "La votazione nei dati aperti del Senato" : "Scheda ufficiale della votazione"}</span><span>↗</span></a>` : ""}
  ${
    AULA === "senato"
      ? ex.ddl.map((k, j) => `<a href="https://www.senato.it/leg/19/BGT/Schede/Ddliter/${esc(k)}.htm" target="_blank" rel="noopener"><span>Iter di S. ${esc(acts[j] ?? "")} sul sito del Senato</span><span>↗</span></a>`).join("")
      : acts.map((a) => `<a href="${LOD}attocamera.rdf/ac19_${esc(a)}" target="_blank" rel="noopener"><span>Atto Camera ${esc(a.replace(/^0+/, ""))} nei dati aperti</span><span>↗</span></a>`).join("")
  }
  <button type="button" data-act="share"><span>Copia il link a questa vista</span><span>⧉</span></button></div></div>`;
}

// ---------------------------------------------------------------- seduta, elenchi

function dayCard(di: number): string {
  const day = D.days[di];
  const vs = D.votes.slice(day.v0, day.v1);
  const acts = new Map<string, Vote[]>();
  vs.filter((v) => !isFinal(v) && !isTrust(v)).forEach((v) => {
    const k = v.atto || "—";
    if (!acts.has(k)) acts.set(k, []);
    acts.get(k)!.push(v);
  });
  const row = (v: Vote, lab = v.titolo) =>
    `<button class="pl" type="button" data-act="vote" data-v="${v.i}"><span class="plt">${isFinal(v) || isTrust(v) ? '<span class="fin">●</span>' : ""}<span>${esc(lab)}</span></span><small>n. ${v.n} · ${v.esito ? "appr." : "resp."}${v.contesa ? " · contesa" : ""}</small></button>`;
  const head = (l: string, n: number) => `<div class="sh" style="margin-top:10px"><span>${l}</span><span>${n}</span></div>`;
  const key = vs.filter((v) => isFinal(v) || isTrust(v));
  let h = key.length ? head("Voti finali e fiducie", key.length) + key.map((v) => row(v, `${typeLabel(v)} · ${actLabel(v) || v.titolo}`)).join("") : "";
  const other = acts.get("—");
  acts.delete("—");
  acts.forEach((arr, k) => (h += head(`${W().atto} ` + esc(k.split(" ").map((x) => x.replace(/^0+/, "")).join(", ")), arr.length) + arr.map((v) => row(v)).join("")));
  if (other) h += head("Ordini del giorno, mozioni e altro", other.length) + other.map((v) => row(v)).join("");
  const sed = [...new Set(vs.map((v) => v.seduta))];
  return `<div class="ck">${sed.length > 1 ? `Sedute n. ${sed.join(" e ")}` : `Seduta n. ${sed[0]}`}</div><div class="ct">${esc(fmtDL(day.data))}</div><p class="cs">${vs.length} votazioni in Aula, ${vs.filter((v) => v.contesa).length} contese. Toccane una per vederla sulla tavola.</p><div class="sec">${h}</div>`;
}

function listCard(c: Extract<Card, { type: "list" }>): string {
  return `<div class="ck">${esc(c.kicker)}</div><div class="ct ${c.title.length > 90 ? "xs" : "s"}">${esc(c.title)}</div><p class="cs">${esc(c.sub)}</p><div class="sec">${
    c.items
      .slice(0, 250)
      .map((it) => `<button class="pl" type="button" data-act="${it.act}" ${it.data}><span class="plt">${it.dot ? dotHTML(it.dot) : ""}<span>${esc(it.label)}</span></span><small>${esc(it.small)}</small></button>`)
      .join("") || '<p class="cs">Nessun risultato.</p>'
  }${c.items.length > 250 ? `<p class="mini">Mostrate 250 di ${fmtN(c.items.length)}.</p>` : ""}</div>`;
}

// ---------------------------------------------------------------- confronto

function cmpCard(a: number, b: number): string {
  const A = D.deputies[a], B = D.deputies[b];
  const ga = A.gruppo ? D.G[A.gruppo] : undefined, gb = B.gruppo ? D.G[B.gruppo] : undefined;
  const fa = deputyFile(a), fb = deputyFile(b);
  const head = `<div class="ck"><span>Confronto uno contro uno</span></div>
  <div class="cmp-h"><button type="button" data-act="dep" data-i="${a}">${gchip(ga)}<span class="nm">${esc(A.name)}</span></button><button type="button" data-act="dep" data-i="${b}">${gchip(gb)}<span class="nm">${esc(B.name)}</span></button></div>`;
  if (!fa || !fb) return head + loading(`i voti dei due ${W().membri}`);
  const r = compare(a, b, fa, fb);
  const bs = S.base;
  const main = bs === "cont" ? r.cont : r.all, sec = bs === "cont" ? r.all : r.cont;
  const mv = main[0] >= 50 ? main[1] / main[0] : null, sv = sec[0] >= 50 ? sec[1] / sec[0] : null;
  const cross = sideAt(A, todayKey()) !== sideAt(B, todayKey()) || A.gruppo !== B.gruppo;
  const it = (v: number) => linkVote(D.votes[v], `${typeLabel(D.votes[v])}: ${actLabel(D.votes[v]) || D.votes[v].titolo}`);
  return `${head}
  <div class="sec"><div class="sh"><span>Accordo</span><span class="seg"><button type="button" data-act="base" data-base="cont" class="${bs === "cont" ? "on" : ""}">Contese</button><button type="button" data-act="base" data-base="all" class="${bs === "all" ? "on" : ""}">Tutte</button></span></div>
    <div class="big-n"><b>${mv == null ? "—" : pc(mv)}</b><span>su ${fmtN(main[0])} votazioni ${bs === "cont" ? "contese" : ""} in cui hanno votato entrambi</span></div>
    <p class="mini">${bs === "cont" ? "Su tutte le votazioni" : "Sulle sole contese"}: ${sv == null ? "—" : pc(sv)} (${fmtN(sec[0])}).${mv == null ? " Sotto le 50 votazioni in comune l'accordo non è mostrato." : ""}</p>
    <div class="chart">${lineChart([{ vals: bs === "cont" ? r.monthly.cont : r.monthly.all, col: "#151515" }], { h: 84 })}</div></div>
  <div class="sec"><div class="sh"><span>Voto per voto</span><span>rosso = diversi</span></div><canvas class="cbc" data-a="${a}" data-b="${b}" aria-label="I voti dei due ${W().membri} a confronto"></canvas>
    <div class="pbc-ax" style="margin-left:0"><span>${fmtM(D.votes[0].data)}</span><span>${esc(A.cognome)} sopra · ${esc(B.cognome)} sotto</span><span>${fmtM(D.votes[D.V - 1].data)}</span></div></div>
  <div class="sec"><div class="sh"><span>Dove si sono divisi</span><span>${r.split.length}</span></div><p class="mini">Voti finali e fiducie: uno favorevole, l'altro contrario.</p>${r.split.slice(-6).reverse().map(it).join("") || '<p class="cs">Nessuno.</p>'}</div>
  ${cross ? `<div class="sec"><div class="sh"><span>Dove si sono trovati d'accordo</span><span>${r.agree.length}</span></div><p class="mini">Voti finali e fiducie contesi, da schieramenti diversi, votati allo stesso modo.</p>${r.agree.slice(-6).reverse().map(it).join("") || '<p class="cs">Nessuno.</p>'}</div>` : ""}
  <div class="sec"><div class="links"><button type="button" data-act="share"><span>Copia il link al confronto</span><span>⧉</span></button><button type="button" data-act="cmp-start" data-i="${a}"><span>Cambia il secondo ${W().membro}</span><span>⇄</span></button></div></div>`;
}

// ---------------------------------------------------------------- gruppo

function groupCard(gid: string): string {
  const g = D.G[gid];
  const date = tColor();
  const k = D.vgroups.indexOf(gid);
  const members = D.deputies.filter((d) => !d.mandato[1] && groupAt(d, date) === gid);
  const ever = D.deputies.filter((d) => d.gruppi.some((s) => s.g === gid));
  const inn = D.deputies.filter((d) => d.cambi.some((c) => c.a === gid)).length;
  const out = D.deputies.filter((d) => d.cambi.some((c) => c.da === gid)).length;
  let span = "";
  if (ever.length) {
    const a = ever.map((d) => d.gruppi.find((s) => s.g === gid)!.da).sort()[0];
    const b = ever.map((d) => d.gruppi.filter((s) => s.g === gid).pop()!.a).sort().pop()!;
    span = `${fmtM(a)} – ${b >= todayKey() ? "oggi" : fmtM(b)}`;
  }
  // accordo tra la posizione del gruppo e quella degli altri gruppi
  const agree: { g: Group; v: number; n: number }[] = [];
  if (k >= 0) {
    for (const o of D.groups) {
      const ko = D.vgroups.indexOf(o.id);
      if (o.id === gid || ko < 0) continue;
      let n = 0, e = 0;
      for (const v of D.votes) {
        if (v.stato !== 0 || (S.base === "cont" && !v.contesa)) continue;
        const p = v.gruppi.charAt(k), q = v.gruppi.charAt(ko);
        if (p === "." || q === ".") continue;
        n++;
        if (p === q) e++;
      }
      if (n >= 50) agree.push({ g: o, v: e / n, n });
    }
    agree.sort((x, y) => y.v - x.v);
  }
  const misto = g.misto;
  return `<div class="ck">${gchip(g)}<span>· ${SIDE_L[g.lato]}</span></div><div class="ct">${esc(g.nome)}</div>
  <p class="cs">${span ? esc(span) + " · " : ""}${members.length} ${W().membri} in carica oggi. Entrati da altri gruppi: ${inn}. Usciti: ${out}.${misto ? " Componente del gruppo Misto." : ""}</p>
  <div class="sec"><div class="sh"><span>Con chi vota il gruppo</span><span class="seg"><button type="button" data-act="base" data-base="cont" class="${S.base === "cont" ? "on" : ""}">Contese</button><button type="button" data-act="base" data-base="all" class="${S.base === "all" ? "on" : ""}">Tutte</button></span></div>
  ${agree.map((r) => `<button class="ag" type="button" data-act="group" data-g="${r.g.id}" title="${fmtN(r.n)} votazioni"><span class="agn">${dotHTML(r.g.colore)}${esc(r.g.sigla)}</span><span class="agb"><i style="width:${r.v * 100}%;background:${r.g.colore}"></i></span><span class="agv">${pc(r.v, 0)}</span></button>`).join("") || '<p class="cs">Dati insufficienti.</p>'}
  <p class="mini">Quota di votazioni ${S.base === "cont" ? "contese " : ""}in cui la posizione dei due gruppi è stata la stessa.</p></div>
  ${members.length ? `<div class="sec"><div class="sh"><span>${W().Membri} in carica</span><span>${members.length}</span></div>${members.sort((a, b) => a.cognome.localeCompare(b.cognome, "it")).map((d) => linkDep(d.i, d.ruoli[0]?.ruolo ?? "")).join("")}</div>` : ""}
  <div class="sec"><button class="btn" type="button" data-act="hlgroup" data-g="${gid}" style="align-self:flex-start">Evidenzia sulla tavola <span>●</span></button></div>`;
}

// ---------------------------------------------------------------- disegni nelle schede

export function hydrate(root: HTMLElement): void {
  root.querySelectorAll<HTMLCanvasElement>("canvas.pbc").forEach((c) => drawPersonal(c, +c.dataset.i!));
  root.querySelectorAll<HTMLCanvasElement>("canvas.cbc").forEach((c) => drawCmp(c, +c.dataset.a!, +c.dataset.b!));
}
function prep(c: HTMLCanvasElement): [CanvasRenderingContext2D, number, number] {
  const d = Math.min(2, devicePixelRatio || 1), w = c.clientWidth, h = c.clientHeight;
  c.width = w * d;
  c.height = h * d;
  const x = c.getContext("2d")!;
  x.setTransform(d, 0, 0, d, 0, 0);
  return [x, w, h];
}
function drawPersonal(c: HTMLCanvasElement, i: number): void {
  const f = deputyFile(i);
  if (!f) return;
  const [x, w, h] = prep(c), rh = h / 3, d = D.deputies[i];
  x.fillStyle = "#ECE7DC";
  x.fillRect(0, 0, w, h);
  const cols: Record<string, string> = { F: "rgba(21,21,21,.22)", C: "rgba(210,64,43,.45)", A: "rgba(94,90,82,.55)" };
  const row: Record<string, number> = { F: 0, C: 1, A: 2 };
  for (let v = 0; v < D.V; v++) {
    const ch = f.barcode.charAt(v);
    if (!(ch in row)) continue;
    x.fillStyle = cols[ch];
    x.fillRect(D.votes[v].t * w, row[ch] * rh + 1.5, 0.9, rh - 3);
  }
  x.fillStyle = "#CFC8BA";
  x.fillRect(0, rh, w, 0.6);
  x.fillRect(0, 2 * rh, w, 0.6);
  for (const ch of d.cambi) {
    const v = D.votes.find((vo) => vo.data >= ch.data);
    if (v) {
      x.fillStyle = "#151515";
      x.fillRect(v.t * w - 0.75, 0, 1.5, h);
    }
  }
}
function drawCmp(c: HTMLCanvasElement, a: number, b: number): void {
  const fa = deputyFile(a), fb = deputyFile(b);
  if (!fa || !fb) return;
  const [x, w, h] = prep(c), lh = (h - 14) / 2;
  x.fillStyle = "#ECE7DC";
  x.fillRect(0, 0, w, lh);
  x.fillRect(0, lh + 14, w, lh);
  const col: Record<string, string> = { F: "rgba(21,21,21,.3)", C: "rgba(210,64,43,.45)", A: "rgba(94,90,82,.55)" };
  for (let v = 0; v < D.V; v++) {
    const p = fa.barcode.charAt(v), q = fb.barcode.charAt(v), X = D.votes[v].t * w;
    if (col[p]) {
      x.fillStyle = col[p];
      x.fillRect(X, 1, 0.9, lh - 2);
    }
    if (col[q]) {
      x.fillStyle = col[q];
      x.fillRect(X, lh + 15, 0.9, lh - 2);
    }
    if (col[p] && col[q] && p !== q) {
      x.fillStyle = "rgba(210,64,43,.75)";
      x.fillRect(X, lh + 2, 0.9, 10);
    }
  }
}

export { monthOf };
