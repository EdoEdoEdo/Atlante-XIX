// Metodologia: pannello laterale sopra l'atlante (a tutto schermo su telefono).
// Si apre da qualsiasi link "#metodologia" o "#m-…" senza lasciare la pagina,
// così chi la chiude ritrova l'atlante esattamente dov'era.

import type { Meta } from "./types.js";
import { $, fmtD, fmtN, fmtS, reducedMotion } from "./util.js";

let lastFocus: HTMLElement | null = null;
let closeT = 0;

const box = (): HTMLElement => $("#method");
const scroller = (): HTMLElement => $("#mScroll");
export const methodOpen = (): boolean => !box().hidden;

/** i numeri della metodologia vengono dagli stessi dati dell'atlante */
export function fillMethod(m: Meta): void {
  const val: Record<string, string> = {
    votazioni: fmtN(m.votazioni),
    valide: fmtN(m.valide),
    segrete: fmtN(m.segrete),
    incomplete: fmtN(m.incomplete),
    deputati: fmtN(m.deputati),
    contese: fmtN(m.contese),
    "contese-pc": `${((100 * m.contese) / m.valide).toLocaleString("it-IT", { maximumFractionDigits: 1 })}%`,
    aggiornato: fmtS(m.aggiornato),
    "aggiornato-lungo": fmtD(m.aggiornato),
    "cambi-ind": fmtN(m.cambi.individuale ?? 0),
    "cambi-sc": fmtN(m.cambi.scissione ?? 0),
  };
  document.querySelectorAll<HTMLElement>("#method [data-m]").forEach((el) => {
    const v = val[el.dataset.m ?? ""];
    if (v != null) el.textContent = v;
  });
}

/** apre il pannello; con un'ancora (es. "m-accordo") scorre fino a quella sezione */
export function openMethod(anchor = ""): void {
  const el = box();
  clearTimeout(closeT);
  if (el.hidden) {
    lastFocus = document.activeElement as HTMLElement | null;
    el.hidden = false;
    document.documentElement.classList.add("m-open");
    void el.offsetWidth; // fa partire la transizione
    el.classList.add("on");
  }
  const target = anchor && anchor !== "metodologia" ? document.getElementById(anchor) : null;
  const sc = scroller();
  if (target) {
    const y = target.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop - 12;
    sc.scrollTo({ top: y, behavior: reducedMotion() || !el.classList.contains("ready") ? "auto" : "smooth" });
    target.classList.remove("flash");
    void target.offsetWidth;
    target.classList.add("flash");
  } else if (!el.classList.contains("ready")) sc.scrollTop = 0;
  el.classList.add("ready");
  $("#methodPanel").focus({ preventScroll: true });
}

export function closeMethod(): void {
  const el = box();
  if (el.hidden) return;
  el.classList.remove("on", "ready");
  document.documentElement.classList.remove("m-open");
  closeT = window.setTimeout(() => (el.hidden = true), reducedMotion() ? 0 : 420);
  lastFocus?.focus?.({ preventScroll: true });
}

export function wireMethod(): void {
  // tutti i link alla metodologia, ovunque siano (schede e legende sono generate dopo)
  document.addEventListener("click", (e) => {
    const t = e.target as Element;
    if (t.closest("[data-act='method-close']")) {
      e.preventDefault();
      return closeMethod();
    }
    const a = t.closest<HTMLAnchorElement>("a[href^='#m-'], a[href='#metodologia']");
    if (!a) return;
    e.preventDefault();
    openMethod(a.getAttribute("href")!.slice(1));
  });
  // a pannello aperto la tastiera resta qui: Esc chiude, Tab gira dentro il pannello
  document.addEventListener(
    "keydown",
    (e) => {
      if (!methodOpen()) return;
      e.stopPropagation();
      if (e.key === "Escape") {
        e.preventDefault();
        closeMethod();
      } else if (e.key === "Tab") {
        const f = [...$("#methodPanel").querySelectorAll<HTMLElement>("a[href], button")].filter((x) => x.offsetParent !== null);
        if (!f.length) return;
        const first = f[0], last = f[f.length - 1];
        if (e.shiftKey && (document.activeElement === first || document.activeElement === $("#methodPanel"))) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    },
    true,
  );
}

/** link diretto: atlantexix.it/#metodologia oppure /#m-accordo */
export function methodFromHash(): void {
  const h = location.hash.slice(1);
  if (h === "metodologia" || h.startsWith("m-")) openMethod(h);
}
