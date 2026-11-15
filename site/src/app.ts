// L'esploratore: stato, interfaccia e interazioni

import { dom as bcDom, drawBarcode, ensureVisible, initBarcode, isPlaying, passes, setDom, sizeBarcode, startPlay, stopPlay, tOfDate, zoomAround } from "./barcode.js";
import { hydrate, renderCard } from "./cards.js";
import {
  AULA, D, W, WORDS, breakdown, codeLabel, deputyFile, groupAt, inOffice, isFinal, isLoaded, isSecret, isTrust, loadAll, loadDeputy, loadMonth,
  loadMonthly, monthKeyOf, typeLabel, useAula, voteRow, type Aula,
} from "./data.js";
import { dots, hitDot, initEngine, setClip, setGhosts, setKeepAlive, sizeCanvas, type Ghost } from "./engine.js";
import { gridRef, mapPositions } from "./layouts.js";
import { KEY, LENS_TXT, domain, histSVG, metrics, refreshDomains, resetMetrics, similarity, simHist } from "./lenses.js";
import { attoTitle, loadAtti, renderResults, search, type Action, type Result, titleCase } from "./search.js";
import { S, readURL, shareURL, syncURL, type Card, type Filter, type Lens, type View } from "./state.js";
import { computeTargets, curVote, effView, isMobile, slotRect, tColor, tRef } from "./stage.js";
import { PRESETS, TB, renderTable } from "./table.js";
import { $, $$, esc, fmtD, fmtM, fmtN, fmtS, pc } from "./util.js";

const FL: Record<Filter, string> = { all: "Tutte", cont: "Contese", finale: "Voti finali", fiducia: "Fiducie", segreta: "Segrete", respinta: "Respinte", stretto: "Margine stretto" };

// ---------------------------------------------------------------- ingresso

export function enterApp(instant = false): void {
  if (S.mode === "app") return;
  S.mode = "app";
  document.body.classList.add("is-app");
  $("#app").setAttribute("aria-hidden", "false");
  $("#intro").setAttribute("aria-hidden", "true");
  setTimeout(() => S.mode === "app" && document.body.classList.add("intro-off"), 500);
  setClipFromSlot();
  update({ dur: instant ? 0 : 1100 });
  setTimeout(sizeBarcode, instant ? 0 : 850);
  sizeBarcode();
  void loadMonthly().then(() => {
    resetMetrics();
    if (S.period) update({ card: true, dur: 300 });
  });
  setTimeout(() => void loadAtti(), 2500);
}

export function exitApp(onIntro: () => void): void {
  if (S.mode !== "app") return;
  stopPlay();
  closeCmdk();
  S.mode = "intro";
  setClip(null);
  document.body.classList.remove("is-app", "intro-off");
  $("#app").setAttribute("aria-hidden", "true");
  $("#intro").removeAttribute("aria-hidden");
  scrollTo(0, 0);
  onIntro();
}

// ---------------------------------------------------------------- Camera ⇄ Senato

/**
 * Cambia aula. go() dispone i punti nuovi (di solito update); qui sotto si decide da dove partono:
 * ogni punto nuovo nasce dove c'era un punto vecchio, e i punti vecchi in più (da 400 a 200)
 * restano come fantasmi che raggiungono il punto con cui si fondono. All'inverso, da 200 a 400,
 * ogni punto si divide in due.
 */
export function swapAula(to: Aula, go: () => void, dur = 1100): void {
  const old = dots.filter((o) => o.a > 0.05 && o.r > 0.3).map((o) => ({ x: o.x, y: o.y, r: o.r, c: [o.c[0], o.c[1], o.c[2]] as Ghost["c"] }));
  useAula(to);
  initEngine($<HTMLCanvasElement>("#cv"), D.N);
  go();
  const nw = dots.map((o, j) => ({ j, t: o.to })).filter((x) => x.t && x.t.a > 0.05 && x.t.r > 0.3);
  if (!old.length || !nw.length) return;
  const byX = (a: { x: number; y: number }, b: { x: number; y: number }) => a.x - b.x || a.y - b.y;
  old.sort(byX);
  nw.sort((a, b) => byX(a.t!, b.t!));
  const used = new Set<number>();
  nw.forEach((n, k) => {
    const q = Math.min(old.length - 1, Math.floor((k * old.length) / nw.length));
    const A = old[q], o = dots[n.j];
    used.add(q);
    o.f = { x: A.x, y: A.y, r: A.r, a: 1, c: [...A.c], ring: 0 };
    Object.assign(o, { x: A.x, y: A.y, r: A.r, a: 1, c: [...A.c] });
  });
  const ghosts: Ghost[] = [];
  old.forEach((A, q) => {
    if (used.has(q)) return;
    const k = Math.min(nw.length - 1, Math.floor((q * nw.length) / old.length));
    ghosts.push({ ...A, j: nw[k].j });
  });
  setGhosts(ghosts, dur * 0.85);
}

let switching = false;
/** dallo switch nella testata */
export async function switchAula(to: Aula): Promise<void> {
  if (to === AULA || switching) return;
  if (S.mode !== "app") enterHook?.();
  switching = true;
  syncAula(to);
  try {
    if (!isLoaded(to)) {
      aload(0, to);
      await loadAll((p) => aload(p, to), to);
    }
  } catch (e) {
    console.error(e);
    toast(`Non riesco a caricare i dati del ${WORDS[to].aula}. Riprova tra poco.`);
    switching = false;
    aload(-1, to);
    syncAula(AULA);
    return;
  }
  aload(-1, to);
  stop();
  closeCmdk();
  S.dep = null;
  S.cmp = null;
  S.vote = null;
  S.hl = null;
  S.pick = null;
  S.hist = [];
  S.card = { type: "home" };
  if (S.view === "vote") S.view = "map";
  if (S.lens === "sim") S.lens = "groups";
  TB.q = "";
  $<HTMLInputElement>("#tq").value = "";
  setDom(0, 1);
  swapAula(to, () => update({ dur: 1100 }));
  syncAula();
  sheet("peek");
  say(`${WORDS[to].aulaLunga}: ${D.N} ${WORDS[to].membri} nella legislatura`);
  switching = false;
}

/** caricamento dell'altra aula, sulla tavola (p < 0 lo nasconde) */
function aload(p: number, to: Aula): void {
  const el = $("#aload");
  el.hidden = p < 0;
  if (p >= 0) el.textContent = `Carico il ${WORDS[to].aula} · ${Math.round(p * 100)}%`;
}

/** stato dei pulsanti Camera / Senato */
export function syncAula(a: Aula = AULA): void {
  $$<HTMLButtonElement>("#aulaSeg button").forEach((b) => {
    const on = b.dataset.aula === a;
    b.classList.toggle("on", on);
    b.setAttribute("aria-pressed", String(on));
  });
  document.body.dataset.aula = a;
  $(".sbtn-l").textContent = `Cerca un ${WORDS[a].membro}, una data, un tema…`;
  $("#cv").setAttribute("aria-label", `Ogni punto è un ${WORDS[a].membro} ${WORDS[a].dellaAula}`);
  if (isLoaded(a)) {
    const m = a === AULA ? D.meta : null;
    $("#rfootSrc").textContent = WORDS[a].fonte;
    if (m) $("#updated2").textContent = `Dati aggiornati al ${fmtD(m.aggiornato)}`;
  }
}

function setClipFromSlot(): void {
  const r = slotRect();
  setClip({ x: r.x0, y: r.y0, w: r.w0, h: r.h0 });
}

// ---------------------------------------------------------------- aggiornamento

interface UpOpts {
  dur?: number;
  card?: boolean;
  quick?: boolean;
}
export function update({ dur = 720, card = true, quick = false }: UpOpts = {}): void {
  if (S.mode !== "app") return;
  // dati che servono prima di disegnare
  const v = curVote();
  if (v && !voteRow(v)) {
    void loadMonth(monthKeyOf(v.data)).then(() => update({ dur, card, quick }));
  }
  const needDep = [S.dep, ...(S.cmp ?? [])].filter((x): x is number => x != null && !deputyFile(x));
  if (needDep.length) void Promise.all(needDep.map(loadDeputy)).then(() => update({ dur: S.lens === "sim" ? 500 : 0, card, quick }));
  if (S.period) void loadMonthly().then((m) => m && resetMetrics());
  metrics();
  refreshDomains();
  setClipFromSlot();
  syncControls();
  renderLegend(); // prima della tavola: sul telefono la legenda toglie spazio all'emiciclo
  computeTargets(dur);
  renderPlate();
  renderPills();
  if (card && !quick) renderCardNow();
  drawBarcode();
  if (S.panel === "table" && !quick) renderTable();
  syncURL();
}

function syncControls(): void {
  const ev = effView();
  $$<HTMLButtonElement>("#views button").forEach((b) => {
    const on = b.dataset.view === ev;
    b.classList.toggle("on", on);
    b.setAttribute("aria-pressed", String(on));
    if (b.dataset.view === "vote") b.disabled = S.vote == null;
  });
  const v = curVote();
  $("#voteHint").textContent = v ? `${fmtS(v.data)} · n. ${v.n}` : "scegli una votazione";
  $$<HTMLButtonElement>("#lenses button").forEach((b) => {
    const on = b.dataset.lens === S.lens;
    b.classList.toggle("on", on);
    b.setAttribute("aria-pressed", String(on));
  });
  $$("#baseSeg button").forEach((b) => b.classList.toggle("on", b.dataset.base === S.base));
  $("#baseSec").style.display = S.lens === "sim" || S.cmp || S.dep != null ? "" : "none";
  $$("#fchips .chip").forEach((b) => b.classList.toggle("on", b.dataset.f === S.filter));
  $$("#panelSeg button").forEach((b) => b.classList.toggle("on", b.dataset.panel === S.panel));
  $("#tablebox").hidden = S.panel !== "table";
  const pb = $("#pickbar");
  if (S.pick && (S.pick === "sim" || S.dep != null)) {
    pb.hidden = false;
    pb.innerHTML = `<span>${S.pick === "cmp" ? `Confronta ${esc(D.deputies[S.dep!].name)} con… tocca un punto o cerca un nome` : `Somiglianza: scegli un ${W().membro}`}</span><button type="button" data-act="pick-cancel">Annulla</button>`;
  } else pb.hidden = true;
}

function perLabel(): string {
  if (!S.period) return `${fmtM(D.votes[0].data)} – ${fmtM(D.votes[D.V - 1].data)}`;
  return S.period[0] === S.period[1] ? fmtS(S.period[0]) : `${fmtS(S.period[0])} – ${fmtS(S.period[1])}`;
}

function renderPlate(): void {
  const v = curVote(), view = effView();
  let n: string, t: string, s: string, cls = "";
  if (view === "map") {
    n = "Tav. II";
    t = "Mappa dei voti";
    const nv = D.votes.filter((x) => x.contesa && (!S.period || (x.data >= S.period[0] && x.data <= S.period[1]))).length;
    s = `${perLabel()} · ${fmtN(nv)} voti contesi · ${mapPositions(S.period).label}`;
  } else if (view === "hemi") {
    n = "Tav. I";
    t = v ? "Emiciclo · " + (isSecret(v) ? "voto segreto" : "come hanno votato") : "Emiciclo";
    s = v ? `${typeLabel(v)} · ${fmtS(v.data)} · seduta ${v.seduta}` : "Seduti per gruppo · " + (S.period ? "al " + fmtS(tRef()) : "oggi");
  } else {
    n = "Tav. III";
    t = `${typeLabel(v!)} · ${fmtS(v!.data)}`;
    s = v!.titolo;
    if (isFinal(v!) || isTrust(v!)) cls = "r";
  }
  $("#plate").innerHTML = `<span class="pn">${n}</span><span class="pt ${cls}">${esc(t)}</span><span class="ps">${esc(s.length > 96 ? s.slice(0, 94) + "…" : s)}</span>`;
}

function renderLegend(): void {
  const v = curVote(), view = effView();
  let h = "", mh = "";
  if (v && view === "hemi" && !isSecret(v) && v.stato === 0) {
    const row = voteRow(v);
    let N = 0, M = 0;
    if (row) for (const ch of row) ch === "M" ? M++ : ch === "N" || ch === "P" || ch === "V" ? N++ : 0;
    h = `<div class="lg-h">Votazione del ${fmtS(v.data)}</div>` +
      [["var(--ink)", "Favorevole", v.F], ["var(--accent)", "Contrario", v.C], ["var(--abst)", "Astensione", v.A]].map(([c, l, n]) => `<div class="lg-row"><span class="l"><i class="dot" style="background:${c}"></i>${l}</span><span class="n">${n}</span></div>`).join("") +
      `<div class="lg-row"><span class="l"><i class="dot hollow"></i>${AULA === "senato" ? "Non votanti · in congedo o missione" : "Non ha partecipato · in missione"}</span><span class="n">${N} · ${M}</span></div><p class="lg-txt">Passa alla Tav. III per vedere i voti in colonne.</p>`;
    mh = `<span><i class="dot" style="background:var(--ink)"></i>F ${v.F}</span><span><i class="dot" style="background:var(--accent)"></i>C ${v.C}</span><span><i class="dot" style="background:var(--abst)"></i>A ${v.A}</span>`;
  } else if (S.lens === "groups" || (S.lens === "sim" && S.dep == null) || (view === "vote" && v)) {
    const date = tColor();
    const cnt: Record<string, number> = {};
    D.deputies.forEach((d) => {
      const inn = view === "map" ? mapPositions(S.period).pts[d.i] != null : inOffice(d, tRef());
      if (!inn) return;
      const g = groupAt(d, date);
      if (g) cnt[g] = (cnt[g] ?? 0) + 1;
    });
    const order = D.groups.filter((g) => cnt[g.id]).sort((a, b) => a.ordine - b.ordine);
    const row = (g: (typeof D.groups)[number]) => `<div class="lg-row"><button type="button" data-act="group" data-g="${g.id}"><i class="dot" style="background:${g.colore}"></i>${esc(g.sigla)}</button><span class="n">${cnt[g.id]}</span></div>`;
    const by = (s: number) => order.filter((g) => g.lato === s);
    h = (by(1).length ? `<div class="lg-h">Maggioranza</div>${by(1).reverse().map(row).join("")}` : "") +
      (by(2).length ? `<div class="lg-h">Opposizione</div>${by(2).map(row).join("")}` : "") +
      (by(0).length ? `<div class="lg-h">Non schierati</div>${by(0).map(row).join("")}` : "") +
      `<a class="lg-more" href="#m-maggioranza">Come sono definiti →</a>`;
    mh = order.map((g) => `<span><i class="dot" style="background:${g.colore}"></i>${esc(g.sigla)}</span>`).join("");
  } else if (LENS_TXT[S.lens]) {
    const [t, txt, sec] = LENS_TXT[S.lens], dm = domain(S.lens);
    h = `<div class="lg-h">${t}${S.period ? " · periodo" : ""}</div><div class="lg-hist">${histSVG(dm, (x) => pc(x, 1))}</div><p class="lg-txt">Linea rossa: mediana ${W().dellaAula}. ${txt}</p><a class="lg-more" href="#${sec}">Come è calcolato →</a>`;
    mh = `<span>${t}</span><span>${pc(dm.lo, 1)} <i class="gr"></i> ${pc(dm.hi, 1)}</span>`;
  } else if (S.lens === "changes") {
    const who = D.deputies.filter((d) => d.cambi.some((c) => c.tipo !== "componente"));
    const ind = who.filter((d) => d.cambi.some((c) => c.tipo === "individuale")).length;
    const sc = who.filter((d) => d.cambi.some((c) => c.tipo === "scissione")).length;
    h = `<div class="lg-h">Cambi di gruppo</div><div class="lg-row"><span class="l"><i class="dot" style="background:var(--ink)"></i>Ha cambiato gruppo</span><span class="n">${who.length}</span></div><div class="lg-row"><span class="l"><i class="dot" style="background:var(--fade)"></i>Stesso gruppo</span></div><p class="lg-txt">${ind} per scelta individuale, ${sc} con la scissione di Azione–Italia Viva (alcuni in entrambi i modi). Sulla Tav. II ogni linea va dalla posizione nel vecchio gruppo a quella nel nuovo: il cerchio è la partenza, la punta l'arrivo.</p><a class="lg-more" href="#m-cambi">Come sono contati →</a>`;
    mh = `<span>${who.length} hanno cambiato gruppo · cerchio → punta</span>`;
  } else if (S.lens === "sim" && S.dep != null) {
    const nm = D.deputies[S.dep].name;
    h = `<div class="lg-h">Somiglianza con ${esc(nm)}</div><div class="lg-hist">${simHist() || '<p class="lg-txt">Carico…</p>'}</div><p class="lg-txt">Accordo sulle ${S.base === "cont" ? "votazioni contese" : "votazioni"}. Nero = vota quasi sempre allo stesso modo. Tratteggiati: meno di 50 votazioni in comune.</p><a class="lg-more" href="#m-accordo">Come è calcolato →</a>`;
    mh = `<span>Come ${esc(D.deputies[S.dep].cognome)}</span><span>0% <i class="gr"></i> 100%</span>`;
  }
  $("#legend").innerHTML = h;
  $("#mlegend").innerHTML = mh;
}

function renderPills(): void {
  const v = curVote();
  let h = "";
  if (S.period) h += `<span class="pill">${esc(perLabel())}<button type="button" data-x="period" aria-label="Togli il periodo">✕</button></span>`;
  if (S.filter !== "all") h += `<span class="pill">${esc(FL[S.filter])}<button type="button" data-x="filter" aria-label="Togli il filtro">✕</button></span>`;
  if (v) h += `<span class="pill${isFinal(v) || isTrust(v) ? " r" : ""}">${esc(typeLabel(v))} ${fmtS(v.data)}<button type="button" data-x="vote" aria-label="Togli la votazione">✕</button></span>`;
  if (S.hl) h += `<span class="pill">${esc(S.hlLabel)}<button type="button" data-x="hl" aria-label="Togli l'evidenziazione">✕</button></span>`;
  if (S.cmp) h += `<span class="pill">${esc(D.deputies[S.cmp[0]].cognome)} vs ${esc(D.deputies[S.cmp[1]].cognome)}<button type="button" data-x="cmp" aria-label="Chiudi il confronto">✕</button></span>`;
  else if (S.dep != null) {
    const g = groupAt(D.deputies[S.dep], tColor());
    h += `<span class="pill">${g ? `<i class="dot" style="background:${D.G[g].colore}"></i>` : ""}${esc(D.deputies[S.dep].name)}<button type="button" data-x="dep" aria-label="Deseleziona">✕</button></span>`;
  }
  $("#pills").innerHTML = h || `<span class="muted">Tutta la legislatura · tutti i ${W().membri}</span>`;
}

// ---------------------------------------------------------------- schede

const cardIn = (): HTMLElement => $("#cardIn");
export function openCard(c: Card, push = true): void {
  if (push && S.card.type !== "home") S.hist.push(S.card);
  if (S.hist.length > 12) S.hist.shift();
  S.card = c;
  sheet(c.type === "home" ? "peek" : "half");
}
function renderCardNow(): void {
  const el = cardIn();
  try {
    el.innerHTML = renderCard(S.card, S.hist[S.hist.length - 1]);
  } catch (e) {
    console.error(e);
    el.innerHTML = `<p class="cs">Non sono riuscito a mostrare questa scheda.</p>`;
  }
  el.scrollTop = 0;
  requestAnimationFrame(() => hydrate(el));
}

// foglio su telefono
function sheet(st: "peek" | "half" | "full"): void {
  if (!isMobile()) return;
  const card = $("#card");
  card.classList.toggle("half", st === "half");
  card.classList.toggle("full", st === "full");
}

// ---------------------------------------------------------------- azioni

function stop(): void {
  if (isPlaying()) stopPlay();
}
function selectDep(i: number, withCard = true): void {
  if (S.pick === "cmp" && S.dep != null && i !== S.dep) {
    const a = S.dep;
    S.pick = null;
    openCmp(a, i);
    return;
  }
  if (S.pick === "sim") S.pick = null;
  S.dep = i;
  S.cmp = null;
  if (withCard) openCard({ type: "dep", i });
  say("Selezionato " + D.deputies[i].name);
  update();
}
function openCmp(a: number, b: number): void {
  S.cmp = [a, b];
  S.dep = a;
  S.pick = null;
  openCard({ type: "cmp", a, b });
  say(`Confronto tra ${D.deputies[a].name} e ${D.deputies[b].name}`);
  update();
}
function selectVote(i: number): void {
  stop();
  S.vote = i;
  if (S.view === "map" || S.view === "vote") S.view = "vote";
  S.hl = null;
  ensureVisible(D.votes[i].t);
  openCard({ type: "vote", v: i });
  say(D.votes[i].titolo);
  update();
}
function goDay(di: number): void {
  stop();
  const d = D.days[di];
  S.period = [d.data, d.data];
  const span = (21 * 86_400_000) / (D.T1 - D.T0);
  const a = Math.max(0, Math.min(1 - span, d.t - span / 2));
  setDom(a, a + span);
  const vs = D.votes.slice(d.v0, d.v1);
  const fin = vs.find(isFinal) ?? vs.find(isTrust) ?? vs[vs.length - 1];
  S.vote = fin.i;
  S.view = "vote";
  S.hl = null;
  openCard({ type: "day", d: di });
  update();
}
function setPeriod(a: string, b: string): void {
  stop();
  S.period = a <= b ? [a, b] : [b, a];
  if (S.view === "vote") S.view = "map";
  S.vote = null;
  if (S.card.type === "vote" || S.card.type === "day") openCard({ type: "home" }, false);
}
function hlSet(ids: number[], lbl: string, card = false): void {
  S.hl = new Set(ids);
  S.hlLabel = lbl;
  update({ card });
}
function hlGroup(g: string, card = false): void {
  const date = tColor();
  const pts = mapPositions(S.period).pts;
  const ids = D.deputies.filter((d) => (effView() === "map" ? pts[d.i] != null : inOffice(d, tRef())) && groupAt(d, date) === g).map((d) => d.i);
  hlSet(ids, D.G[g].sigla, card);
}
function voteList(title: string, kicker: string, ids: number[], sub = ""): void {
  const key = (k: number) => (isFinal(D.votes[k]) || isTrust(D.votes[k]) ? 0 : 1);
  const ord = ids.slice().reverse().sort((a, b) => key(a) - key(b));
  openCard({
    type: "list", kicker, title, sub: (sub ? sub + " · " : "") + `${fmtN(ids.length)} votazioni`,
    items: ord.map((k) => {
      const v = D.votes[k];
      const fin = isFinal(v) || isTrust(v);
      const label = isFinal(v) ? "Voto finale" : fin ? `${typeLabel(v)} · ${v.titolo}` : v.titolo;
      return { act: "vote", data: `data-v="${k}"`, label, small: fmtS(v.data) + (v.contesa ? " · contesa" : "") + (fin ? (v.esito ? " · approvato" : " · respinto") : ""), dot: fin ? "var(--accent)" : undefined };
    }),
  });
  update();
}
function actList(atto: string): void {
  const ids = D.votes.filter((v) => v.atto.split(" ").includes(atto)).map((v) => v.i);
  const t = attoTitle(atto);
  voteList(t ?? `${W().atto} ${atto.replace(/^0+/, "")}`, `${W().attoLungo} ${atto.replace(/^0+/, "")}`, ids);
}

export function say(t: string): void {
  $("#live").textContent = t;
}
export function toast(m: string): void {
  const t = $("#toast");
  t.textContent = m;
  t.classList.add("on");
  clearTimeout(toastT);
  toastT = window.setTimeout(() => t.classList.remove("on"), 2800);
}
let toastT = 0;

async function share(): Promise<void> {
  const url = shareURL();
  try {
    await navigator.clipboard.writeText(url);
    toast("Link copiato");
  } catch {
    toast(url);
  }
}

function runAction(a: Action): void {
  S.panel = "stage";
  switch (a.kind) {
    case "day": return goDay(a.d);
    case "period":
      setPeriod(a.a, a.b);
      if (S.view === "vote") S.view = "map";
      setDom(tOfDate(a.a) - 0.01, tOfDate(a.b) + 0.01);
      return update();
    case "filter":
      S.filter = a.f;
      if (a.a && a.b) {
        setPeriod(a.a, a.b);
        setDom(tOfDate(a.a) - 0.005, tOfDate(a.b) + 0.005);
      }
      return update();
    case "lens":
      S.lens = a.lens;
      if (a.lens === "sim" && S.dep == null) {
        S.pick = "sim";
        openCard({ type: "simpick" });
      }
      return update();
    case "view":
      S.view = a.view;
      return update({ card: false });
    case "dep": return selectDep(a.i);
    case "cmp": return openCmp(a.a, a.b);
    case "group":
      openCard({ type: "group", g: a.g });
      return hlGroup(a.g, true);
    case "area": {
      openCard({
        type: "list", kicker: "Circoscrizione", title: titleCase(a.name), sub: `${W().Membri} in carica eletti in questa circoscrizione, nei collegi uninominali e nelle liste proporzionali.`,
        items: a.ids.map((i) => {
          const d = D.deputies[i], g = d.gruppo ? D.G[d.gruppo] : null;
          return { act: "dep", data: `data-i="${i}"`, label: d.name, small: `${g?.sigla ?? ""} · ${d.elezione.tipo}${d.elezione.collegio ? " " + d.elezione.collegio : ""}`, dot: g?.colore };
        }),
      });
      return hlSet(a.ids, titleCase(a.name), true);
    }
    case "votes": return voteList(a.title, a.kicker, a.ids);
    case "act":
      return actList(a.atto);
  }
}

// ---------------------------------------------------------------- barra comandi

let RES: Result[] = [];
let sel = 0;
let lastFocus: Element | null = null;
const EXAMPLES: Record<Aula, string[]> = {
  camera: ["Schlein", "fiducie 2025", "contese 2024", "maggio 2024", "Lombardia 1", "legge di bilancio", "cambi di gruppo", "Meloni vs Schlein"],
  senato: ["Boccia", "fiducie 2025", "contese 2024", "maggio 2024", "Lombardia", "legge di bilancio", "cambi di gruppo", "Malan vs Boccia"],
};
export function openCmdk(): void {
  lastFocus = document.activeElement;
  $("#cmdk").hidden = false;
  const q = $<HTMLInputElement>("#q");
  q.value = "";
  RES = [];
  sel = 0;
  renderRes();
  q.focus();
  setTimeout(() => q.focus(), 20);
  void loadAtti().then(() => {
    if ($("#cmdk").hidden || !q.value) return;
    RES = search(q.value);
    renderRes();
  });
}
export function closeCmdk(): void {
  if ($("#cmdk").hidden) return;
  $("#cmdk").hidden = true;
  (lastFocus as HTMLElement | null)?.focus?.();
}
function renderRes(): void {
  const q = $<HTMLInputElement>("#q").value;
  $("#res").innerHTML = renderResults(RES, sel, q, EXAMPLES[AULA]);
  $("#res .ci.on")?.scrollIntoView({ block: "nearest" });
}
let enterHook: (() => void) | null = null;
export const setEnterHook = (fn: () => void): void => {
  enterHook = fn;
};
function runRes(k: number): void {
  const r = RES[k];
  if (!r) return;
  closeCmdk();
  if (S.mode !== "app") enterHook?.();
  runAction(r.action);
}
function runQuery(s: string): void {
  void loadAtti().then(() => {
    RES = search(s);
    if (RES.length) {
      if (S.mode !== "app") enterHook?.();
      runAction(RES[0].action);
    } else {
      openCmdk();
      $<HTMLInputElement>("#q").value = s;
      RES = search(s);
      renderRes();
    }
  });
}

// ---------------------------------------------------------------- suggerimenti sulla tavola

const tip = (): HTMLElement => $("#tip");
function showTip(e: { clientX: number; clientY: number }, html: string): void {
  const t = tip();
  t.innerHTML = html;
  t.classList.add("on");
  const w = t.offsetWidth, h = t.offsetHeight;
  t.style.left = Math.max(8, Math.min(innerWidth - w - 8, e.clientX + 14)) + "px";
  t.style.top = Math.max(8, Math.min(innerHeight - h - 8, e.clientY - h - 12)) + "px";
}
function hideTip(): void {
  tip().classList.remove("on");
}
function dotTip(i: number): string {
  const d = D.deputies[i], date = tColor(), g = groupAt(d, date);
  let s = `<b>${esc(d.name)}</b>${g ? " · " + esc(D.G[g].sigla) : ""}`;
  const v = curVote();
  const row = v ? voteRow(v) : null;
  if (v && row && !isSecret(v)) s += `<br>${codeLabel(row.charAt(i))}`;
  if ((S.lens === "sim" || S.cmp) && S.dep != null && i !== S.dep) {
    const r = similarity(S.dep, i);
    s += `<br>${r.v == null ? "meno di 50 votazioni in comune" : `${pc(r.v)} · ${fmtN(r.n)} voti contesi in comune`}`;
  } else if (LENS_TXT[S.lens]) {
    const val = metrics()[i][KEY[S.lens]] as number | null;
    s += `<br>${LENS_TXT[S.lens][0]}: ${d.president ? "non vota" : pc(val)}`;
  }
  if (effView() === "map") s += `<br><span class="dim">Tav. II · ${gridRef(mapPositions(S.period).pts[i])}</span>`;
  return s;
}

// ---------------------------------------------------------------- collegamenti con il DOM

export function wireApp(onMast: () => void): void {
  const cv = $<HTMLCanvasElement>("#cv");
  cv.addEventListener("pointermove", (e) => {
    if (S.mode !== "app" || e.pointerType === "touch") return;
    const i = hitDot(e.clientX, e.clientY);
    cv.style.cursor = i >= 0 ? "pointer" : "default";
    if (i >= 0) showTip(e, dotTip(i));
    else hideTip();
  });
  cv.addEventListener("pointerleave", hideTip);
  cv.addEventListener("click", (e) => {
    if (S.mode !== "app") return;
    const i = hitDot(e.clientX, e.clientY);
    hideTip();
    if (i >= 0) return selectDep(i);
    if (S.pick) {
      S.pick = null;
      return update({ card: false });
    }
    if (S.hl || S.dep != null || S.cmp) {
      S.hl = null;
      S.cmp = null;
      S.dep = null;
      if (S.lens === "sim") S.lens = "groups";
      if (S.card.type === "dep" || S.card.type === "cmp") openCard({ type: "home" }, false);
      update();
    }
  });

  initBarcode($<HTMLCanvasElement>("#bcv"), {
    vote: selectVote,
    day: goDay,
    period: (a, b) => {
      setPeriod(a, b);
      update();
    },
    tip: (e, h) => showTip(e, h),
    hideTip,
  });

  document.addEventListener("click", (e) => {
    const b = (e.target as Element).closest<HTMLElement>("[data-act],[data-view],[data-lens],[data-base],[data-panel],[data-f],[data-x],[data-pr],[data-sort],tbody tr");
    if (!b) return;
    if (b.matches("tbody tr")) {
      S.panel = "stage";
      return selectDep(+b.dataset.i!);
    }
    if (b.dataset.view && !b.dataset.act) {
      if ((b as HTMLButtonElement).disabled) return;
      stop();
      S.view = b.dataset.view as View;
      return update({ card: false });
    }
    if (b.dataset.lens) {
      S.lens = b.dataset.lens as Lens;
      if (S.lens === "sim" && S.dep == null) {
        S.pick = "sim";
        openCard({ type: "simpick" });
      }
      return update({ dur: 520, card: S.lens === "sim" && S.pick === "sim" });
    }
    if (b.dataset.base && !b.dataset.act) {
      S.base = b.dataset.base as "cont" | "all";
      return update({ dur: 400 });
    }
    if (b.dataset.panel) {
      S.panel = b.dataset.panel as "stage" | "table";
      syncControls();
      if (S.panel === "table") renderTable();
      return;
    }
    if (b.dataset.f) {
      S.filter = b.dataset.f as Filter;
      drawBarcode();
      renderPills();
      syncURL();
      return;
    }
    if (b.dataset.pr) {
      TB.preset = b.dataset.pr;
      const P = PRESETS[TB.preset];
      TB.sort = P.sort;
      TB.dir = P.dir;
      if (P.lens) {
        S.lens = P.lens;
        return update({ dur: 400, card: false });
      }
      return renderTable();
    }
    if (b.dataset.sort) {
      const k = b.dataset.sort;
      if (TB.sort === k) TB.dir = TB.dir === 1 ? -1 : 1;
      else {
        TB.sort = k;
        TB.dir = k === "name" || k === "group" || k === "ref" ? 1 : -1;
      }
      return renderTable();
    }
    if (b.dataset.x) {
      const x = b.dataset.x;
      if (x === "period") S.period = null;
      if (x === "filter") S.filter = "all";
      if (x === "vote") {
        S.vote = null;
        if (S.view === "vote") S.view = "map";
        if (S.card.type === "vote" || S.card.type === "day") openCard({ type: "home" }, false);
      }
      if (x === "hl") S.hl = null;
      if (x === "dep" || x === "cmp") {
        S.dep = null;
        S.cmp = null;
        S.pick = null;
        if (S.lens === "sim") S.lens = "groups";
        if (S.card.type === "dep" || S.card.type === "cmp") openCard({ type: "home" }, false);
      }
      return update();
    }
    const a = b.dataset.act;
    switch (a) {
      case "enter": return enterHook?.();
      case "aula": return void switchAula(b.dataset.aula as Aula);
      case "cmdk": return openCmdk();
      case "cmdk-close": return closeCmdk();
      case "q": return runQuery(b.dataset.q!);
      case "view":
        if (b.dataset.view === "vote" && S.vote == null) {
          const iv = D.vById.get(D.intro.voto);
          if (iv != null) return selectVote(iv);
        }
        S.view = b.dataset.view as View;
        return update({ card: false });
      case "dep": return selectDep(+b.dataset.i!);
      case "vote": if (b.dataset.v) selectVote(+b.dataset.v); return;
      case "day": return goDay(+b.dataset.d!);
      case "act":
        void loadAtti().then(() => actList(b.dataset.a!));
        return;
      case "group":
        S.hl = null;
        openCard({ type: "group", g: b.dataset.g! });
        return hlGroup(b.dataset.g!, true);
      case "hlgroup": return hlGroup(b.dataset.g!);
      case "hlvote": {
        const v = curVote();
        if (!v) return;
        const ids = D.deputies.filter((d) => inOffice(d, v.data) && groupAt(d, v.data) === b.dataset.g).map((d) => d.i);
        return hlSet(ids, D.G[b.dataset.g!].sigla);
      }
      case "hldis": {
        const v = curVote();
        const row = v ? voteRow(v) : null;
        if (!v || !row) return;
        const ids = breakdown(v, row).dissenters;
        return hlSet(ids, `Dissensi (${ids.length})`);
      }
      case "base":
        S.base = b.dataset.base as "cont" | "all";
        return update({ dur: 400 });
      case "simlens":
        S.dep = +b.dataset.i!;
        S.cmp = null;
        S.lens = "sim";
        return update({ dur: 520, card: false });
      case "cmp-start":
        S.dep = +b.dataset.i!;
        S.cmp = null;
        S.pick = "cmp";
        sheet("peek");
        update({ card: false });
        return toast("Tocca un secondo punto o cerca un nome");
      case "pick-cancel":
        S.pick = null;
        return update({ card: false });
      case "back": {
        const p = S.hist.pop();
        if (!p) return;
        S.card = p;
        if (p.type === "dep") {
          S.dep = p.i;
          S.cmp = null;
        }
        if (p.type === "cmp") {
          S.cmp = [p.a, p.b];
          S.dep = p.a;
        }
        if (p.type === "vote") S.vote = p.v;
        return update();
      }
      case "share": return void share();
      case "zin": return zoomAround((bcDom[0] + bcDom[1]) / 2, 0.4);
      case "zout": return zoomAround((bcDom[0] + bcDom[1]) / 2, 2.5);
      case "zfull": return setDom(0, 1);
      case "play":
        if (isPlaying()) return stopPlay();
        S.view = "map";
        S.vote = null;
        startPlay(
          (k) => {
            const m = D.meta.mesi[k];
            const y = +m.slice(0, 4), mo = +m.slice(4, 6);
            const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
            S.period = [`${m}01`, `${m}${String(last).padStart(2, "0")}`];
            setDom(0, 1);
            update({ dur: 560, quick: true });
          },
          () => update(),
        );
        return;
    }
  });

  $("#mast").addEventListener("click", (e) => {
    e.preventDefault();
    onMast();
  });
  $("#sbtn").addEventListener("click", openCmdk);
  $<HTMLInputElement>("#tq").addEventListener("input", (e) => {
    TB.q = (e.target as HTMLInputElement).value;
    renderTable();
  });
  $("#tbody").addEventListener("keydown", (e) => {
    const t = e.target as HTMLElement;
    if (e.key === "Enter" && t.matches("tr")) {
      S.panel = "stage";
      selectDep(+t.dataset.i!);
    }
  });
  // barra comandi
  const q = $<HTMLInputElement>("#q");
  $("#res").addEventListener("click", (e) => {
    const b = (e.target as Element).closest<HTMLElement>(".ci");
    if (!b) return;
    e.stopPropagation();
    if (b.dataset.q != null) {
      q.value = b.dataset.q;
      RES = search(q.value);
      sel = 0;
      renderRes();
      q.focus();
      return;
    }
    runRes(+b.dataset.k!);
  });
  $("#res").addEventListener("mousemove", (e) => {
    const b = (e.target as Element).closest<HTMLElement>(".ci[data-k]");
    if (b && +b.dataset.k! !== sel) {
      sel = +b.dataset.k!;
      $$(".ci", $("#res")).forEach((x) => x.classList.toggle("on", +x.dataset.k! === sel));
    }
  });
  $("#cmdk").addEventListener("click", (e) => {
    if (e.target === $("#cmdk")) closeCmdk();
  });
  q.addEventListener("input", () => {
    RES = search(q.value);
    sel = 0;
    renderRes();
  });
  q.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      sel = Math.min(RES.length - 1, sel + 1);
      renderRes();
      e.preventDefault();
    } else if (e.key === "ArrowUp") {
      sel = Math.max(0, sel - 1);
      renderRes();
      e.preventDefault();
    } else if (e.key === "Enter") {
      e.preventDefault();
      runRes(sel);
    } else if (e.key === "Escape") closeCmdk();
  });
  addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      return openCmdk();
    }
    if (e.key === "Escape") {
      if (!$("#cmdk").hidden) return closeCmdk();
      if (S.pick) {
        S.pick = null;
        update({ card: false });
      }
      return;
    }
    if ((e.target as Element).matches("input,textarea")) return;
    if (e.key === "/") {
      e.preventDefault();
      return openCmdk();
    }
    if (S.mode !== "app") return;
    if ((e.key === "ArrowRight" || e.key === "ArrowLeft") && S.vote != null) {
      // votazione precedente o successiva tra quelle che passano il filtro
      const step = e.key === "ArrowRight" ? 1 : -1;
      let n = S.vote + step;
      while (n >= 0 && n < D.V && !passes(D.votes[n])) n += step;
      if (n >= 0 && n < D.V) selectVote(n);
      e.preventDefault();
    }
    if (["1", "2", "3"].includes(e.key)) {
      const v = (["hemi", "map", "vote"] as View[])[+e.key - 1];
      if (v !== "vote" || S.vote != null) {
        S.view = v;
        update({ card: false });
      }
    }
  });
  // foglio su telefono
  const card = $("#card"), hd = $("#handle");
  let y0: number | null = null;
  let st0 = "peek";
  hd.addEventListener("pointerdown", (e) => {
    y0 = e.clientY;
    st0 = card.classList.contains("full") ? "full" : card.classList.contains("half") ? "half" : "peek";
    hd.setPointerCapture(e.pointerId);
  });
  hd.addEventListener("pointerup", (e) => {
    if (y0 == null) return;
    const dy = e.clientY - y0;
    y0 = null;
    const ord = ["peek", "half", "full"] as const;
    let k = ord.indexOf(st0 as (typeof ord)[number]);
    if (Math.abs(dy) < 8) k = k === 0 ? 1 : k === 1 ? 2 : 0;
    else k = Math.max(0, Math.min(2, k + (dy < 0 ? 1 : -1) * (Math.abs(dy) > 160 ? 2 : 1)));
    sheet(ord[k]);
  });
  hd.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      sheet(card.classList.contains("full") ? "peek" : card.classList.contains("half") ? "full" : "half");
    }
  });
  setKeepAlive(() => isPlaying());
}

export function onResize(): void {
  sizeCanvas();
  if (S.mode === "app") {
    sizeBarcode();
    update({ dur: 0, card: false });
  }
}

/** ripristina lo stato da un link condiviso */
export function restoreFromURL(): boolean {
  return readURL();
}
