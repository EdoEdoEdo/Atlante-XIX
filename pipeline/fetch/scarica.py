#!/usr/bin/env python3
"""
Atlante XIX · scarico completo da dati.camera.it

Scarica metadati delle votazioni, deputati, adesioni ai gruppi e tutti i voti
individuali della XIX legislatura, poi controlla che i voti tornino con i totali.

Uso, dalla cartella atlante-xix:
    python3 pipeline/fetch/scarica.py

Lo stesso comando serve per riprendere uno scarico interrotto e per gli
aggiornamenti: scarica solo quello che manca e riscarica i metadati degli
ultimi due mesi.

Opzioni:
    --paralleli N   richieste in parallelo (predefinito 2)
    --lotto N       votazioni per richiesta (predefinito 20)
    --solo-controllo  non scarica niente, rifà solo il controllo finale

Richiede python3 (3.9 o più recente) e curl. Nessuna libreria da installare.
I file finiscono in pipeline/data/raw/camera/.
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import os
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

EP = os.environ.get("EP", "https://dati.camera.it/sparql")
LEG = "<http://dati.camera.it/ocd/legislatura.rdf/repubblica_19>"
VZ = "http://dati.camera.it/ocd/votazione.rdf/"
INIZIO = dt.date(2022, 10, 1)
LIMITE = 10000           # righe massime per risposta dell'endpoint
SOGLIA = LIMITE - 10     # se ci arriviamo, il lotto viene diviso
TENTATIVI = 5
PAUSA = float(os.environ.get("PAUSA_RIPROVA", "3"))

ROOT = Path(__file__).resolve().parents[1] / "data" / "raw" / "camera"
csv.field_size_limit(10_000_000)

PREFIXES = """PREFIX ocd: <http://dati.camera.it/ocd/>
PREFIX dc: <http://purl.org/dc/elements/1.1/>
PREFIX foaf: <http://xmlns.com/foaf/0.1/>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
"""

# ---------------------------------------------------------------- query

# Metadati delle votazioni (verificato con la sonda 2):
# - una query "leggera" per mese con i campi a valore singolo: 4-22 secondi;
# - atti, atti di indirizzo e descrizioni a parte, un campo per volta: ~1 secondo.
# Messi tutti insieme in una query sola, alcuni mesi vanno in timeout.
COLONNE_LEGGERE = ["votazione", "data", "identificativo", "titolo", "tipo", "seduta", "presenti", "votanti",
                   "maggioranza", "favorevoli", "contrari", "astenuti", "approvato", "finale", "fiducia",
                   "segreta", "presieduta", "scheda"]
CAMPI_A_PARTE = {"atto": "ocd:rif_attoCamera", "aic": "ocd:rif_aic", "descrizione": "dc:description"}
COLONNE_VOTAZIONI = COLONNE_LEGGERE[:4] + ["descrizione"] + COLONNE_LEGGERE[4:6] + ["atto", "aic"] + COLONNE_LEGGERE[6:]
FORMATO_METADATI = "3"

Q_META_LEGGERA = """
SELECT DISTINCT ?votazione ?data ?identificativo ?titolo ?tipo ?seduta
       ?presenti ?votanti ?maggioranza ?favorevoli ?contrari ?astenuti
       ?approvato ?finale ?fiducia ?segreta ?presieduta ?scheda WHERE {
  ?votazione a ocd:votazione ; ocd:rif_leg __LEG__ ; dc:date ?data .
  FILTER(STRSTARTS(STR(?data), '__PREFISSO__'))
  OPTIONAL { ?votazione dc:identifier ?identificativo }
  OPTIONAL { ?votazione dc:title ?titolo }
  OPTIONAL { ?votazione dc:type ?tipo }
  OPTIONAL { ?votazione ocd:rif_seduta ?seduta }
  OPTIONAL { ?votazione ocd:presenti ?presenti }
  OPTIONAL { ?votazione ocd:votanti ?votanti }
  OPTIONAL { ?votazione ocd:maggioranza ?maggioranza }
  OPTIONAL { ?votazione ocd:favorevoli ?favorevoli }
  OPTIONAL { ?votazione ocd:contrari ?contrari }
  OPTIONAL { ?votazione ocd:astenuti ?astenuti }
  OPTIONAL { ?votazione ocd:approvato ?approvato }
  OPTIONAL { ?votazione ocd:votazioneFinale ?finale }
  OPTIONAL { ?votazione ocd:richiestaFiducia ?fiducia }
  OPTIONAL { ?votazione ocd:votazioneSegreta ?segreta }
  OPTIONAL { ?votazione ocd:presiedutaDa ?presieduta }
  OPTIONAL { ?votazione dc:relation ?scheda }
}
"""

Q_UN_CAMPO = """
SELECT DISTINCT ?votazione ?valore WHERE {
  ?votazione a ocd:votazione ; ocd:rif_leg __LEG__ ; dc:date ?data .
  FILTER(STRSTARTS(STR(?data), '__PREFISSO__'))
  ?votazione __PROP__ ?valore .
}
"""

# Voti: forma compatta (solo gli identificativi) e forma completa di riserva.
Q_VOTI_COMPATTA = """
SELECT DISTINCT
  (STRAFTER(STR(?votazione), 'votazione.rdf/') AS ?votazione_id)
  (STRAFTER(STR(?deputato), 'deputato.rdf/') AS ?deputato_id)
  ?espressione
  (STRAFTER(STR(?gruppo), 'gruppoParlamentare.rdf/') AS ?gruppo_id)
  ?sigla
WHERE {
  VALUES ?votazione { __VALUES__ }
  ?voto ocd:rif_votazione ?votazione ; ocd:rif_deputato ?deputato ; dc:type ?espressione .
  OPTIONAL { ?voto ocd:rif_gruppoParlamentare ?gruppo }
  OPTIONAL { ?voto ocd:siglaGruppo ?sigla }
}
"""
Q_VOTI_COMPLETA = """
SELECT DISTINCT ?votazione_id ?deputato_id ?espressione ?gruppo_id ?sigla WHERE {
  VALUES ?votazione_id { __VALUES__ }
  ?voto ocd:rif_votazione ?votazione_id ; ocd:rif_deputato ?deputato_id ; dc:type ?espressione .
  OPTIONAL { ?voto ocd:rif_gruppoParlamentare ?gruppo_id }
  OPTIONAL { ?voto ocd:siglaGruppo ?sigla }
}
"""

Q_DEPUTATI = """
SELECT DISTINCT ?deputato ?cognome ?nome ?genere ?mandato ?inizio_mandato ?fine_mandato
       ?tipo_elezione ?collegio ?lista ?elezione WHERE {
  ?deputato a ocd:deputato ; ocd:rif_leg __LEG__ ; foaf:surname ?cognome ; foaf:firstName ?nome .
  OPTIONAL { ?deputato foaf:gender ?genere }
  OPTIONAL {
    ?deputato ocd:rif_mandatoCamera ?mandato . ?mandato ocd:rif_leg __LEG__ .
    OPTIONAL { ?mandato ocd:startDate ?inizio_mandato }
    OPTIONAL { ?mandato ocd:endDate ?fine_mandato }
    OPTIONAL {
      ?mandato ocd:rif_elezione ?e .
      OPTIONAL { ?e ocd:tipoElezione ?tipo_elezione }
      OPTIONAL { ?e dc:coverage ?collegio }
      OPTIONAL { ?e ocd:lista ?lista }
      OPTIONAL { ?e rdfs:label ?elezione }
    }
  }
} ORDER BY ?cognome ?nome
"""

Q_ADESIONI = """
SELECT DISTINCT ?deputato ?etichetta ?gruppo ?inizio ?fine WHERE {
  ?deputato a ocd:deputato ; ocd:rif_leg __LEG__ ; ocd:aderisce ?a .
  ?a rdfs:label ?etichetta .
  OPTIONAL { ?a ocd:rif_gruppoParlamentare ?gruppo }
  OPTIONAL { ?a ocd:startDate ?inizio }
  OPTIONAL { ?a ocd:endDate ?fine }
} ORDER BY ?deputato ?inizio
"""

Q_GRUPPI = """
SELECT DISTINCT ?gruppo ?p ?o WHERE {
  VALUES ?gruppo { __VALUES__ }
  ?gruppo ?p ?o .
  FILTER(isLiteral(?o))
}
"""

# Esplorazioni: servono a capire dove stanno Governo e componenti del Misto.
# Se una fallisce o torna vuota, lo scarico continua.
ESPLORAZIONI = {
    "adesione_proprieta": """
SELECT ?a ?p ?o WHERE {
  <http://dati.camera.it/ocd/deputato.rdf/d308928_19> ocd:aderisce ?a . ?a ?p ?o .
}""",
    "governi_dal_2022": """
SELECT DISTINCT ?governo ?p ?o WHERE {
  ?governo a ocd:governo ; dc:date ?d ; ?p ?o .
  FILTER(STR(?d) >= '2022')
} LIMIT 9000""",
    "membri_governo_via_governo": """
SELECT DISTINCT ?m ?p ?o WHERE {
  ?g a ocd:governo ; dc:date ?d . FILTER(STR(?d) >= '2022')
  ?m a ocd:membroGoverno ; ?k ?g .
  ?m ?p ?o .
} LIMIT 9000""",
    "membri_governo_via_deputato": """
SELECT DISTINCT ?deputato ?m ?p ?o WHERE {
  ?deputato a ocd:deputato ; ocd:rif_leg __LEG__ .
  ?m a ocd:membroGoverno ; ?k ?deputato .
  ?m ?p ?o .
} LIMIT 9000""",
    "misto_componenti": """
SELECT DISTINCT ?c ?p ?o WHERE {
  ?c a ocd:componenteGruppoMisto ; ocd:rif_leg __LEG__ ; ?p ?o .
} LIMIT 9000""",
    "misto_componenti_via_deputato": """
SELECT DISTINCT ?deputato ?k ?c ?p ?o WHERE {
  ?deputato a ocd:deputato ; ocd:rif_leg __LEG__ ; ?k ?c .
  ?c a ocd:componenteGruppoMisto ; ?p ?o .
} LIMIT 9000""",
}

# ---------------------------------------------------------------- utilità

_log_lock = threading.Lock()


def log(msg: str) -> None:
    with _log_lock:
        with open(ROOT / "log.txt", "a", encoding="utf-8") as f:
            f.write(f"{dt.datetime.now():%Y-%m-%d %H:%M:%S}  {msg}\n")


def say(msg: str = "") -> None:
    print(msg, flush=True)
    if msg:
        log(msg)


class FetchError(Exception):
    pass


def count_rows(path: Path) -> int:
    with open(path, encoding="utf-8", newline="") as f:
        return max(0, sum(1 for _ in csv.reader(f)) - 1)


def sparql(query: str, out: Path, expect: list[str] | None = None, timeout: int = 300,
           tries: int = TENTATIVI, quiet: bool = False) -> int:
    """Esegue una query e salva il CSV in `out`. Restituisce il numero di righe."""
    out.parent.mkdir(parents=True, exist_ok=True)
    qfile = out.with_suffix(".rq")
    part = out.with_suffix(".part")
    qfile.write_text(PREFIXES + query.replace("__LEG__", LEG), encoding="utf-8")
    cmd = ["curl", "-sS", "-L", "-m", str(timeout), "-X", "POST", EP,
           "-H", "Accept: text/csv",
           "--data-urlencode", f"query@{qfile}",
           "--data-urlencode", "format=text/csv",
           "-o", str(part), "-w", "%{http_code}"]
    last = ""
    for attempt in range(1, tries + 1):
        r = subprocess.run(cmd, capture_output=True, text=True)
        code = r.stdout.strip()
        ok = r.returncode == 0 and code == "200" and part.exists()
        if ok:
            with open(part, encoding="utf-8", errors="replace") as f:
                head = f.readline().strip()
            header = [h.strip('"') for h in head.split(",")] if head else []
            if not head or head.startswith("Virtuoso") or (expect and header != expect):
                ok = False
                last = f"risposta inattesa: {head[:120]}"
        else:
            snippet = ""
            if part.exists():
                snippet = part.read_text(encoding="utf-8", errors="replace")[:160].replace("\n", " ")
            last = f"HTTP {code or '000'} curl={r.returncode} {r.stderr.strip()[:120]} {snippet}"
        if ok:
            os.replace(part, out)
            return count_rows(out)
        log(f"tentativo {attempt}/{tries} fallito per {out.name}: {last}")
        if not quiet:
            why = ("il server non ha risposto in tempo" if code in ("502", "503", "504") or r.returncode == 28
                   else f"errore {code or r.returncode}")
            print(f"   {out.stem}: {why}, " + ("riprovo" if attempt < tries else "passo oltre")
                  + f" ({attempt}/{tries})", flush=True)
        if attempt < tries:
            time.sleep(min(60, PAUSA * attempt * attempt))
    part.unlink(missing_ok=True)
    raise FetchError(f"{out.name}: {last}")


def months(today: dt.date) -> list[tuple[str, str, str]]:
    """[(AAAA-MM, AAAAMM01, AAAAMM31), …] dall'inizio della legislatura a oggi."""
    out, y, m = [], INIZIO.year, INIZIO.month
    while (y, m) <= (today.year, today.month):
        out.append((f"{y:04d}-{m:02d}", f"{y:04d}{m:02d}01", f"{y:04d}{m:02d}31"))
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    return out


def ymd(s: str) -> dt.date:
    """AAAAMMGG → data; un giorno oltre la fine del mese (es. 20241131) diventa l'ultimo del mese."""
    y, m, d = int(s[:4]), int(s[4:6]), int(s[6:8])
    while True:
        try:
            return dt.date(y, m, d)
        except ValueError:
            d -= 1


def fmt_dur(sec: float) -> str:
    sec = int(sec)
    return f"{sec // 3600}h {sec % 3600 // 60:02d}m" if sec >= 3600 else f"{sec // 60}m {sec % 60:02d}s"


# ---------------------------------------------------------------- passi

def step_votazioni(today: dt.date) -> None:
    say("1/5 · Metadati delle votazioni, mese per mese")
    folder = ROOT / "votazioni"
    work = folder / "_lavoro"
    folder.mkdir(parents=True, exist_ok=True)
    for p in list(folder.glob("*_*.csv")) + list(folder.glob("*_*.rq")) + list(folder.glob("*.part")):
        p.unlink()                      # resti delle versioni precedenti
    if work.exists():
        for p in work.iterdir():
            p.unlink()
    fmt = folder / "formato.txt"
    if not fmt.exists() or fmt.read_text().strip() != FORMATO_METADATI:
        for p in folder.glob("*.csv"):  # mesi in un formato precedente: li riscarico
            p.unlink()
        fmt.write_text(FORMATO_METADATI)
    ms = months(today)
    recent = {k for k, _, _ in ms[-2:]}
    tot = 0
    for key, _da, _a in ms:
        out = folder / f"{key}.csv"
        if out.exists() and key not in recent:
            tot += count_rows(out)
            continue
        print(f"   {key}  in corso…", flush=True)
        prefix = key.replace("-", "")
        base = fetch_prefix(Q_META_LEGGERA, prefix, work / f"{key}_base.csv", COLONNE_LEGGERE)
        extra: dict[str, dict[str, set]] = {}
        for col, prop in CAMPI_A_PARTE.items():
            for r in fetch_prefix(Q_UN_CAMPO.replace("__PROP__", prop), prefix, work / f"{key}_{col}.csv",
                                  ["votazione", "valore"]):
                extra.setdefault(r["votazione"], {}).setdefault(col, set()).add(r["valore"])
        n = write_month(base, extra, out)
        tot += n
        print(f"   {key}  {n:>4} votazioni", flush=True)
    say(f"   votazioni con metadati: {tot:,}".replace(",", "."))


def fetch_prefix(query: str, prefix: str, out: Path, expect: list[str]) -> list[dict]:
    """Esegue una query filtrata per data (AAAAMM, AAAAMMG o AAAAMMGG). Se va in timeout
    o restituisce troppe righe, la ripete per decine di giorni e poi per singoli giorni."""
    try:
        n = sparql(query.replace("__PREFISSO__", prefix), out, timeout=150,
                   tries=2 if len(prefix) < 8 else TENTATIVI, expect=expect)
        if n < SOGLIA:
            with open(out, encoding="utf-8", newline="") as f:
                rows = list(csv.DictReader(f))
            out.unlink()
            out.with_suffix(".rq").unlink(missing_ok=True)
            return rows
        if len(prefix) >= 8:
            raise FetchError(f"{prefix}: troppe righe in un solo giorno")
    except FetchError:
        if len(prefix) >= 8:
            raise
    out.with_suffix(".rq").unlink(missing_ok=True)
    out.unlink(missing_ok=True)
    step = "decine di giorni" if len(prefix) == 6 else "giorni"
    print(f"   {out.stem}: ripeto per {step}", flush=True)
    rows: list[dict] = []
    for d in ("0123" if len(prefix) == 6 else "0123456789"):
        rows += fetch_prefix(query, prefix + d, out.with_name(f"{out.stem}{d}.csv"), expect)
    return rows


def write_month(base: list[dict], extra: dict[str, dict[str, set]], out: Path) -> int:
    """Una riga per votazione. Più atti o atti di indirizzo sono separati da uno spazio."""
    seen: dict[str, dict] = {}
    for r in base:
        seen.setdefault(r["votazione"], r)
    order = sorted(seen, key=lambda v: (seen[v]["data"], v))
    tmp = out.with_suffix(".tmp")
    with open(tmp, "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(COLONNE_VOTAZIONI)
        for v in order:
            r, e = seen[v], extra.get(v, {})
            row = []
            for c in COLONNE_VOTAZIONI:
                if c in ("atto", "aic"):
                    row.append(" ".join(sorted(e.get(c, ()))))
                elif c == "descrizione":
                    row.append(sorted(e[c])[0] if e.get(c) else "")
                else:
                    row.append(r.get(c, ""))
            w.writerow(row)
    os.replace(tmp, out)
    return len(order)


def load_votazioni() -> list[dict]:
    seen, rows = set(), []
    for p in sorted((ROOT / "votazioni").glob("*.csv")):
        with open(p, encoding="utf-8", newline="") as f:
            for r in csv.DictReader(f):
                vid = r["votazione"].rsplit("/", 1)[-1]
                if vid in seen:
                    continue
                seen.add(vid)
                r["id"] = vid
                rows.append(r)
    rows.sort(key=lambda r: (r["data"], r["id"]))
    return rows


def step_deputati() -> None:
    say("2/5 · Deputati, mandati, elezione e adesioni ai gruppi")
    n = sparql(Q_DEPUTATI, ROOT / "deputati.csv")
    m = sparql(Q_ADESIONI, ROOT / "adesioni.csv")
    say(f"   deputati: {n} righe · adesioni: {m} righe")


def step_voti(lotto: int, paralleli: int) -> None:
    say("3/5 · Voti individuali")
    folder = ROOT / "voti"
    folder.mkdir(parents=True, exist_ok=True)
    done_file, empty_file, mode_file = folder / "fatte.txt", folder / "vuote.txt", folder / "modo.txt"
    # fatte.txt: una riga per file completato, "cartella/file.csv<TAB>id id id"
    done, manifest = set(), set()
    if done_file.exists():
        for line in done_file.read_text(encoding="utf-8").splitlines():
            if "\t" in line:
                path, ids = line.split("\t", 1)
                manifest.add(path)
                done.update(ids.split())
    # file rimasti a metà da un'interruzione: li tolgo, verranno riscaricati
    orphans = [p for p in folder.glob("*/*.csv") if f"{p.parent.name}/{p.name}" not in manifest]
    for p in orphans:
        p.unlink()
    for p in folder.glob("*/*.part"):
        p.unlink()
    if orphans:
        say(f"   tolti {len(orphans)} file incompleti di uno scarico interrotto")
    vz = load_votazioni()
    secret = {v["id"] for v in vz if v.get("segreta") == "1"}
    pending = [v for v in vz if v["id"] not in done and v["id"] not in secret]
    say(f"   votazioni: {len(vz):,} · segrete (senza voti individuali): {len(secret)} · già scaricate: {len(done):,} · da scaricare: {len(pending):,}".replace(",", "."))
    if not pending:
        return

    # forma della query: compatta se l'endpoint la accetta, altrimenti completa
    mode = mode_file.read_text().strip() if mode_file.exists() else ""
    if not mode:
        test = pending[0]["id"]
        try:
            sparql(Q_VOTI_COMPATTA.replace("__VALUES__", f"<{VZ}{test}>"), folder / "_prova.csv",
                   expect=["votazione_id", "deputato_id", "espressione", "gruppo_id", "sigla"])
            mode = "compatta"
        except FetchError as e:
            log(f"forma compatta non accettata ({e}), uso la forma completa")
            mode = "completa"
        for p in (folder / "_prova.csv", folder / "_prova.rq"):
            p.unlink(missing_ok=True)
        mode_file.write_text(mode)
    query = Q_VOTI_COMPATTA if mode == "compatta" else Q_VOTI_COMPLETA
    say(f"   forma della query: {mode}")

    # lotti: mai a cavallo di due mesi, così i file restano ordinati per mese
    jobs: list[tuple[str, list[str]]] = []
    by_month: dict[str, list[str]] = {}
    for v in pending:
        by_month.setdefault(f"{v['data'][:4]}-{v['data'][4:6]}", []).append(v["id"])
    for key, ids in by_month.items():
        for k in range(0, len(ids), lotto):
            jobs.append((key, ids[k:k + lotto]))

    def run(key: str, ids: list[str]) -> list[tuple[str, list[str], int, list[str]]]:
        name = f"{ids[0]}__{ids[-1]}.csv" if len(ids) > 1 else f"{ids[0]}.csv"
        out = folder / key / name
        values = " ".join(f"<{VZ}{i}>" for i in ids)
        try:
            n = sparql(query.replace("__VALUES__", values), out, tries=3 if len(ids) > 1 else TENTATIVI, quiet=True,
                       expect=["votazione_id", "deputato_id", "espressione", "gruppo_id", "sigla"])
        except FetchError:
            if len(ids) == 1:
                raise
            log(f"lotto {ids[0]}…{ids[-1]} non riuscito, lo divido a metà")
            h = len(ids) // 2
            return run(key, ids[:h]) + run(key, ids[h:])
        if n >= SOGLIA:
            out.unlink()
            if len(ids) == 1:
                raise FetchError(f"{ids[0]}: una sola votazione supera {LIMITE} righe")
            h = len(ids) // 2
            return run(key, ids[:h]) + run(key, ids[h:])
        out.with_suffix(".rq").unlink(missing_ok=True)
        with open(out, encoding="utf-8", newline="") as f:
            present = {r["votazione_id"].rsplit("/", 1)[-1] for r in csv.DictReader(f)}
        time.sleep(0.3)
        return [(f"{key}/{name}", ids, n, [i for i in ids if i not in present])]

    t0, rows_tot, n_done, failed = time.time(), 0, 0, 0
    total = len(jobs)
    with ThreadPoolExecutor(max_workers=paralleli) as ex, \
            open(done_file, "a", encoding="utf-8") as fd, open(empty_file, "a", encoding="utf-8") as fe:
        futs = {ex.submit(run, key, ids): (key, ids) for key, ids in jobs}
        try:
            for fut in as_completed(futs):
                key, ids = futs[fut]
                try:
                    for rel, sub_ids, n, missing in fut.result():
                        rows_tot += n
                        fd.write(rel + "\t" + " ".join(sub_ids) + "\n")
                        if missing:
                            fe.write("\n".join(missing) + "\n")
                    fd.flush()
                    fe.flush()
                except FetchError as e:
                    failed += 1
                    log(f"lotto non riuscito {ids[0]}…{ids[-1]}: {e}")
                n_done += 1
                el = time.time() - t0
                eta = el / n_done * (total - n_done)
                sys.stdout.write(f"\r   lotti {n_done}/{total} · {rows_tot:,} righe · trascorso {fmt_dur(el)} · mancano ~{fmt_dur(eta)}   ".replace(",", "."))
                sys.stdout.flush()
        except KeyboardInterrupt:
            fd.flush()
            fe.flush()
            print()
            say("Interrotto. Rilancia lo stesso comando per riprendere da dove eri arrivato.")
            os._exit(1)
    print()
    say(f"   voti scaricati in questa sessione: {rows_tot:,} righe in {fmt_dur(time.time() - t0)}".replace(",", "."))
    if failed:
        say(f"   ATTENZIONE: {failed} lotti non riusciti. Rilancia lo stesso comando per riprovarli (dettagli in log.txt).")


def iter_voti():
    for p in sorted((ROOT / "voti").glob("*/*.csv")):
        with open(p, encoding="utf-8", newline="") as f:
            for r in csv.DictReader(f):
                yield r


def step_gruppi() -> None:
    say("4/5 · Gruppi parlamentari ed esplorazioni")
    ids = set()
    for r in iter_voti():
        g = r.get("gruppo_id", "")
        if g:
            ids.add(g.rsplit("/", 1)[-1])
    ad = ROOT / "adesioni.csv"
    if ad.exists():
        with open(ad, encoding="utf-8", newline="") as f:
            for r in csv.DictReader(f):
                if r.get("gruppo"):
                    ids.add(r["gruppo"].rsplit("/", 1)[-1])
    if ids:
        values = " ".join(f"<http://dati.camera.it/ocd/gruppoParlamentare.rdf/{i}>" for i in sorted(ids))
        n = sparql(Q_GRUPPI.replace("__VALUES__", values), ROOT / "gruppi.csv")
        say(f"   gruppi: {len(ids)} · {n} righe di proprietà")
    for name, q in ESPLORAZIONI.items():
        try:
            n = sparql(q, ROOT / "esplora" / f"{name}.csv", timeout=180)
            print(f"   esplora/{name}: {n} righe", flush=True)
        except FetchError as e:
            log(f"esplorazione {name} non riuscita: {e}")
            print(f"   esplora/{name}: non riuscita (vedi log.txt)", flush=True)


ESPR = {"Favorevole": "F", "Contrario": "C", "Astensione": "A", "Non ha votato": "N"}


def step_controllo() -> None:
    say("5/5 · Controllo: voti individuali contro totali ufficiali")
    vz = {v["id"]: v for v in load_votazioni()}
    counts: dict[str, list[int]] = {}
    other: dict[str, int] = {}
    deps = set()
    rows = 0
    for r in iter_voti():
        rows += 1
        vid = r["votazione_id"].rsplit("/", 1)[-1]
        c = counts.setdefault(vid, [0, 0, 0, 0])
        e = ESPR.get(r["espressione"])
        if e is None:
            other[r["espressione"]] = other.get(r["espressione"], 0) + 1
            continue
        c["FCAN".index(e)] += 1
        deps.add(r["deputato_id"].rsplit("/", 1)[-1])
    ok = diff = absent = 0
    with open(ROOT / "controllo.csv", "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(["votazione", "data", "titolo", "esito", "F_uff", "F_voti", "C_uff", "C_voti", "A_uff", "A_voti", "righe"])
        for vid, v in vz.items():
            if v.get("segreta") == "1":
                continue
            c = counts.get(vid)
            if c is None:
                absent += 1
                w.writerow([vid, v["data"], v.get("titolo", ""), "senza voti", v.get("favorevoli"), "", v.get("contrari"), "", v.get("astenuti"), "", 0])
                continue

            def num(x):
                try:
                    return int(float(x))
                except (TypeError, ValueError):
                    return -1
            uff = (num(v.get("favorevoli")), num(v.get("contrari")), num(v.get("astenuti")))
            if uff == tuple(c[:3]):
                ok += 1
            else:
                diff += 1
                w.writerow([vid, v["data"], v.get("titolo", ""), "diverso", uff[0], c[0], uff[1], c[1], uff[2], c[2], sum(c)])
    n_secret = sum(1 for v in vz.values() if v.get("segreta") == "1")
    lines = [
        f"Votazioni: {len(vz):,} (segrete: {n_secret})",
        f"Righe di voto: {rows:,} · deputati distinti nei voti: {len(deps)}",
        f"Totali che tornano: {ok:,} · diversi: {diff:,} · senza voti scaricati: {absent:,}",
        "Espressioni non riconosciute: " + (", ".join(f"{k} ({n})" for k, n in other.items()) if other else "nessuna"),
        "Dettaglio delle votazioni che non tornano: controllo.csv",
    ]
    text = "\n".join(l.replace(",", ".") for l in lines)
    (ROOT / "controllo.txt").write_text(text + "\n", encoding="utf-8")
    for l in text.splitlines():
        say("   " + l)


# ---------------------------------------------------------------- main

def main() -> None:
    ap = argparse.ArgumentParser(description="Scarica i dati della XIX legislatura da dati.camera.it")
    ap.add_argument("--paralleli", type=int, default=2)
    ap.add_argument("--lotto", type=int, default=20)
    ap.add_argument("--solo-controllo", action="store_true")
    a = ap.parse_args()
    ROOT.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    say(f"Atlante XIX · scarico da {EP}")
    say(f"Cartella dei dati: {ROOT}")
    try:
        if not a.solo_controllo:
            step_votazioni(dt.date.today())
            step_deputati()
            step_voti(max(1, a.lotto), max(1, min(4, a.paralleli)))
            step_gruppi()
        step_controllo()
    except FetchError as e:
        say(f"Errore: {e}")
        say("Controlla la connessione e rilancia lo stesso comando: riparte da dove era arrivato.")
        raise SystemExit(1)
    except KeyboardInterrupt:
        print()
        say("Interrotto. Rilancia lo stesso comando per riprendere.")
        raise SystemExit(1)
    say(f"Fatto in {fmt_dur(time.time() - t0)}. Mandami controllo.txt e la cartella esplora/.")


if __name__ == "__main__":
    main()
