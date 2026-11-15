// Avvio: caricamento, introduzione, esploratore

import { closeCmdk, enterApp, exitApp, onResize, restoreFromURL, setEnterHook, swapAula, syncAula, wireApp } from "./app.js";
import { AULA, D, loadAll, todayKey, useAula } from "./data.js";
import { initEngine, setMisreg, setTargets, sizeCanvas } from "./engine.js";
import {
  buildScenes, fillIntroText, introFrame, introScene0, loaderExit, loaderFail, loaderProgress, loaderReady, measureSteps, onIntroScroll,
  scene0Order, startLoader,
} from "./intro.js";
import { hemiIds } from "./layouts.js";
import { fillMethod, methodFromHash, wireMethod } from "./method.js";
import { S, urlAula } from "./state.js";
import { $, reducedMotion } from "./util.js";

const cv = $<HTMLCanvasElement>("#cv");
document.body.classList.add("is-loading");
initEngine(cv, 0);
startLoader();
const ready = loaderReady();

// i caratteri servono alle etichette disegnate sulla tavola (senza bloccare se non arrivano)
const fonts = Promise.race([
  Promise.all(
    ['800 40px "Schibsted Grotesk"', '700 12px "Schibsted Grotesk"', '500 10px "IBM Plex Mono"', '600 10px "IBM Plex Mono"'].map((f) =>
      document.fonts ? document.fonts.load(f) : Promise.resolve([]),
    ),
  ).catch(() => undefined),
  new Promise((r) => setTimeout(r, 3000)),
]);

/** lo switch del Senato si accende solo se i dati del Senato sono pubblicati */
const senato = fetch("data/senato/meta.json", { method: "HEAD", cache: "no-cache" })
  .then((r) => r.ok)
  .catch(() => false);

async function boot(): Promise<void> {
  // l'introduzione racconta la Camera; chi arriva da un link al Senato carica anche quello
  const aula = urlAula();
  const both = aula === "senato" && (await senato);
  try {
    await Promise.all([loadAll((p) => loaderProgress(p * (both ? 0.6 : 0.98))), fonts]);
    if (both) await loadAll((p) => loaderProgress(0.6 + p * 0.38), "senato");
  } catch (e) {
    console.error(e);
    failed(e);
    return;
  }
  loaderProgress(1);
  void senato.then((ok) => {
    const b = $<HTMLButtonElement>("#aulaSeg [data-aula='senato']");
    b.disabled = !ok;
    b.title = ok ? "Senato della Repubblica" : "In arrivo";
  });
  fillIntroText();
  fillMethod(D.meta);
  if (both) useAula("senato");
  syncAula();
  initEngine(cv, D.N);
  wireMethod();
  wireApp(onMast);
  setEnterHook(goApp);
  await ready;

  const restore = restoreFromURL();
  if (restore) {
    // link condiviso o ritorno: si va subito all'esploratore
    await loaderExit(hemiIds(todayKey()), () => enterApp(false));
    paperTheme();
    document.body.classList.remove("is-loading");
    methodFromHash();
    return;
  }
  buildScenes();
  measureSteps();
  scrollTo(0, 0);
  const { T, over } = introScene0();
  await loaderExit(scene0Order(), () => setTargets(T, 1300, 420, over));
  paperTheme();
  document.body.classList.remove("is-loading");
  S.mode = "intro";
  introFrame(true);
  methodFromHash();
}

/** la barra del browser su telefono passa dal nero della schermata di caricamento alla carta */
function paperTheme(): void {
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", "#F4F1EA");
}

function failed(e: unknown): void {
  loaderFail(`Non riesco a caricare i dati (${e instanceof Error ? e.message : String(e)}). Ricarica la pagina tra qualche istante.`);
}

/** dall'introduzione all'esploratore */
function goApp(): void {
  if (S.mode === "app") return;
  setMisreg(0);
  enterApp(false);
}

/** clic sulla testata */
function onMast(): void {
  if (S.mode === "app") {
    closeCmdk();
    exitApp(() => {
      const toIntro = () => {
        buildScenes();
        measureSteps();
        const { T, over } = introScene0();
        setTargets(T, 1000, 300, over);
      };
      try {
        history.replaceState(null, "", location.pathname);
      } catch {
        /* niente */
      }
      // l'introduzione è sulla Camera: dal Senato i punti si dividono di nuovo
      if (AULA === "camera") toIntro();
      else {
        swapAula("camera", toIntro, 1000);
        syncAula();
      }
      setTimeout(() => S.mode === "intro" && introFrame(true), reducedMotion() ? 0 : 1350);
    });
  } else if (S.mode === "intro") {
    scrollTo({ top: 0, behavior: reducedMotion() ? "auto" : "smooth" });
  }
}

let rzT = 0;
addEventListener("resize", () => {
  clearTimeout(rzT);
  rzT = window.setTimeout(() => {
    sizeCanvas();
    if (S.mode === "intro") {
      buildScenes();
      measureSteps();
      introFrame(true);
    } else onResize();
  }, 80);
});
addEventListener("scroll", onIntroScroll, { passive: true });

void boot();
