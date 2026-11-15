// Indice dei deputati: alternativa tabellare alla tavola

import { AULA, D, W, deputyFile, groupAt, inOffice } from "./data.js";
import { gridRef, mapPositions } from "./layouts.js";
import { metrics, similarity, type Met } from "./lenses.js";
import { S, type Lens } from "./state.js";
import { tColor } from "./stage.js";
import type { Deputy } from "./types.js";
import { $, $$, esc, fmtN, nz, pc } from "./util.js";

interface Preset {
  sort: string;
  dir: 1 | -1;
  lens: Lens | null;
  excludeGov?: boolean;
  filter?: (d: Deputy) => boolean;
  note: () => string;
}
export const PRESETS: Record<string, Preset> = {
  all: { sort: "name", dir: 1, lens: null, note: () => "" },
  presHigh: { sort: "pres", dir: -1, lens: "presence", excludeGov: true, note: () => `Esclusi il ${W().presidente} e i membri del Governo. ${AULA === "senato" ? "Congedi e missioni sono contati" : "Le missioni sono contate"} a parte.` },
  presLow: { sort: "pres", dir: 1, lens: "presence", excludeGov: true, note: () => "Esclusi il Presidente e i membri del Governo. Non votare non significa sempre essere assenti: vedi la metodologia." },
  dissent: { sort: "dissent", dir: -1, lens: "dissent", excludeGov: true, note: () => "Voti diversi dalla posizione del proprio gruppo. Misto escluso." },
  cross: { sort: "cross", dir: -1, lens: "cross", note: () => "Voti contesi espressi come l'altro schieramento." },
  changed: { sort: "ch", dir: -1, lens: "changes", filter: (d) => d.cambi.length > 0, note: () => `${W().Membri} che hanno cambiato gruppo durante la legislatura.` },
};
export const TB = { sort: "name", dir: 1 as 1 | -1, q: "", preset: "all" };

interface Col {
  k: string;
  l: string;
  n?: boolean;
}
function cols(): Col[] {
  const c: Col[] = [
    { k: "name", l: W().Membro }, { k: "group", l: "Gruppo" }, { k: "pres", l: "Presenza", n: true }, { k: "nonpart", l: "Non part.", n: true },
    { k: "mis", l: AULA === "senato" ? "Cong./miss." : "Missione", n: true }, { k: "dissent", l: "Dissenso", n: true }, { k: "cross", l: "Trasv.", n: true }, { k: "ch", l: "Cambi", n: true }, { k: "ref", l: "Tav. II" },
  ];
  if (S.dep != null && deputyFile(S.dep)) c.splice(2, 0, { k: "sim", l: "Accordo con " + D.deputies[S.dep].cognome, n: true });
  return c;
}

function val(d: Deputy, k: string, m: Met): string | number | null {
  switch (k) {
    case "name": return d.cognome + " " + d.nome;
    case "group": { const g = groupAt(d, tColor()); return g ? D.G[g].sigla : ""; }
    case "ch": return d.cambi.filter((c) => c.tipo !== "componente").length;
    case "ref": return gridRef(mapPositions(S.period).pts[d.i]);
    case "sim": return S.dep == null || d.i === S.dep ? null : similarity(S.dep, d.i).v;
    case "pres": return m.pres;
    case "nonpart": return m.nonpart;
    case "mis": return m.mis;
    case "dissent": return m.dissent;
    case "cross": return m.cross;
  }
  return null;
}

export function renderTable(): void {
  const C = cols(), m = metrics(), P = PRESETS[TB.preset], q = nz(TB.q);
  $("#thead").innerHTML = "<tr>" + C.map((c) => `<th class="${c.n ? "n" : ""} ${TB.sort === c.k ? "on" : ""}" scope="col" aria-sort="${TB.sort === c.k ? (TB.dir > 0 ? "ascending" : "descending") : "none"}"><button type="button" data-sort="${c.k}">${esc(c.l)}${TB.sort === c.k ? (TB.dir > 0 ? " ↑" : " ↓") : ""}</button></th>`).join("") + "</tr>";
  let rows = D.deputies.filter((d) => (!P.excludeGov || (!d.president && !d.gov)) && (!P.filter || P.filter(d)) && (!S.period || inOffice(d, S.period[0]) || inOffice(d, S.period[1])));
  if (q) rows = rows.filter((d) => d.nz.includes(q) || nz(d.elezione.circoscrizione).includes(q));
  const vals = new Map(rows.map((d) => [d.i, val(d, TB.sort, m[d.i])]));
  rows.sort((a, b) => {
    const x = vals.get(a.i), y = vals.get(b.i);
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    return (typeof x === "string" ? x.localeCompare(String(y), "it") : (x as number) - (y as number)) * TB.dir;
  });
  const note = P.note();
  $("#tnote").textContent = `${fmtN(rows.length)} ${W().membri}${S.period ? " · periodo scelto" : ""}${note ? " · " + note : ""}`;
  $("#tbody").innerHTML = rows
    .map((d) => {
      const g = groupAt(d, tColor());
      const G = g ? D.G[g] : null, mm = m[d.i];
      return `<tr data-i="${d.i}" tabindex="0" class="${S.dep === d.i ? "sel" : ""}">` + C.map((c) => {
        if (c.k === "name") return `<td><i class="dot" style="background:${G?.colore ?? "#999"};margin-right:7px"></i>${esc(d.name)}${d.ruoli.length ? `<span class="role">${esc(d.ruoli[0].ruolo.replace(/ della Camera| del Senato/, "").replace(/ di Stato.*$/, ""))}</span>` : ""}</td>`;
        if (c.k === "group") return `<td>${esc(G?.sigla ?? "")}</td>`;
        if (c.k === "ref") return `<td class="ref">${val(d, "ref", mm)}</td>`;
        if (c.k === "ch") { const n = val(d, "ch", mm) as number; return `<td class="n">${n || ""}</td>`; }
        const v = val(d, c.k, mm) as number | null;
        return `<td class="n">${d.president && c.k !== "sim" ? "—" : pc(v)}</td>`;
      }).join("") + "</tr>";
    })
    .join("");
  $$("#tbar .chip").forEach((x) => x.classList.toggle("on", x.dataset.pr === TB.preset));
}
