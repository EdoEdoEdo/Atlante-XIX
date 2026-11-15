// Copia i JSON prodotti da pipeline/analysis/analizza.py nella cartella pubblica del sito.
// Parte da solo prima di "npm run dev" e "npm run build". La Camera serve sempre; il Senato
// si copia se c'è (senza i suoi dati lo switch Camera/Senato resta spento).
import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
for (const aula of ["camera", "senato"]) {
  const src = resolve(here, `../../pipeline/data/final/${aula}`);
  const dst = resolve(here, `../public/data/${aula}`);
  if (!existsSync(src)) {
    if (existsSync(dst)) console.warn(`Non trovo ${src}: uso i dati già presenti in public/data/${aula}`);
    else if (aula === "camera") {
      console.error(`Non trovo ${src}: lancia prima python3 pipeline/analysis/analizza.py`);
      process.exit(1);
    }
    continue;
  }
  rmSync(dst, { recursive: true, force: true });
  cpSync(src, dst, { recursive: true });
  console.log(`Dati ${aula} copiati in ${dst}`);
}
