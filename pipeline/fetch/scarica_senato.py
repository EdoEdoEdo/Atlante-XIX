#!/usr/bin/env python3
"""
Atlante XIX · scarico dei dati del Senato (dati.senato.it)

Scarica senatori, gruppi, votazioni dell'Assemblea della XIX legislatura e, per ogni
votazione, gli elenchi dei senatori favorevoli, contrari, astenuti, presenti non votanti,
in congedo o missione e il presidente di turno.

Uso, dalla cartella atlante-xix:
    caffeinate -i python3 pipeline/fetch/scarica_senato.py

Dura circa un'ora (300 richieste): il Senato blocca chi fa troppe richieste ravvicinate, quindi tra una
richiesta e l'altra lo script aspetta 5 secondi. Se si interrompe (anche con un 403), basta
rilanciarlo: riparte dalle sedute che mancano. Rilanciato in seguito, scarica solo le sedute
nuove (e ricontrolla le ultime due).

Scrive in pipeline/data/raw/senato/ e alla fine crea atlante_senato.zip nella cartella
atlante-xix (gli stessi file, compressi: qualche MB) da mandare a Claude. Per preparare
i dati da soli: python3 pipeline/fetch/prepara_senato.py, poi analizza.py senato.

Richiede python3 (3.9 o più recente) e curl. Nessuna libreria da installare.

Cosa sappiamo dell'endpoint (sonda del 13/11/2026 e altri progetti):
- solo GET, richiesta al massimo 2047 byte; niente VALUES, BIND; le date vanno confrontate con STR();
- al massimo 10.000 righe per risposta;
- 403 dopo raffiche di richieste: ci si ferma e si riprova più tardi o da un'altra rete.
"""
from __future__ import annotations

import csv
import io
import subprocess
import sys
import time
import urllib.parse
import zipfile
from collections import defaultdict
from pathlib import Path

EP = "https://dati.senato.it/sparql"
UA = "Mozilla/5.0 (compatible; AtlanteXIX/1.0; progetto civico open data sul Parlamento)"
PAUSA = 5             # secondi tra due richieste
MAX_URI = 2000        # byte massimi della richiesta
CAP = 10000           # righe massime per risposta
MAX_VOTI = 40         # votazioni per richiesta di voti individuali (~215 righe ciascuna)
BLOCCHI = 60          # sedute per blocco nelle richieste dei metadati

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "pipeline" / "data" / "raw" / "senato"
VOTI = RAW / "voti"
ZIP = ROOT / "atlante_senato.zip"

PRE = """PREFIX osr: <http://dati.senato.it/osr/>
PREFIX ocd: <http://dati.camera.it/ocd/>
PREFIX foaf: <http://xmlns.com/foaf/0.1/>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
PREFIX sa: <http://dati.senato.it/sedutaassemblea/>
"""

# elenchi di senatori di una votazione → carattere usato da prepara_senato.py
LISTE = {
    "favorevole": "F", "contrario": "C", "astenuto": "A", "presenteNonVotante": "V",
    "richiedenteNonVotante": "R", "inCongedoMissione": "M", "presidente": "P",
}

Q_SEDUTE = PRE + """SELECT ?s ?numero ?data WHERE { ?s a osr:SedutaAssemblea ; osr:legislatura 19 ; osr:dataSeduta ?data ; osr:numeroSeduta ?numero } ORDER BY ?numero"""

Q_SENATORI = PRE + """SELECT DISTINCT ?senatore ?nome ?cognome ?genere ?inizio ?fine ?tipoMandato ?tipoElezione ?collegio ?regione WHERE {
?senatore a osr:Senatore ; osr:mandato ?m ; foaf:firstName ?nome ; foaf:lastName ?cognome .
?m osr:legislatura 19 . OPTIONAL { ?senatore foaf:gender ?genere } OPTIONAL { ?m osr:inizio ?inizio } OPTIONAL { ?m osr:fine ?fine }
OPTIONAL { ?m osr:tipoMandato ?tipoMandato } OPTIONAL { ?m osr:tipoElezione ?tipoElezione }
OPTIONAL { ?m osr:collegioElezione ?collegio } OPTIONAL { ?m osr:regioneElezione ?regione } }"""

Q_ADESIONI = PRE + """SELECT DISTINCT ?senatore ?gruppo ?carica ?inizio ?fine WHERE {
?senatore a osr:Senatore ; ocd:aderisce ?a . ?a osr:legislatura 19 ; osr:gruppo ?gruppo .
OPTIONAL { ?a osr:carica ?carica } OPTIONAL { ?a osr:inizio ?inizio } OPTIONAL { ?a osr:fine ?fine } }"""

Q_GRUPPI = PRE + """SELECT DISTINCT ?gruppo ?titolo ?breve ?inizio ?fine WHERE {
?a osr:legislatura 19 ; osr:gruppo ?gruppo . ?gruppo osr:denominazione ?d .
OPTIONAL { ?d osr:titolo ?titolo } OPTIONAL { ?d osr:titoloBreve ?breve } OPTIONAL { ?d osr:inizio ?inizio } OPTIONAL { ?d osr:fine ?fine } }"""

Q_VOTAZIONI = PRE + """SELECT ?v ?seduta ?data ?numero ?label ?tipo ?esito ?favorevoli ?contrari ?astenuti ?presenti ?votanti ?maggioranza ?congedoMissione WHERE {
?v a osr:Votazione ; osr:legislatura 19 ; osr:seduta ?s ; osr:numero ?numero . ?s osr:numeroSeduta ?seduta ; osr:dataSeduta ?data .
OPTIONAL { ?v rdfs:label ?label } OPTIONAL { ?v osr:tipoVotazione ?tipo } OPTIONAL { ?v osr:esito ?esito }
OPTIONAL { ?v osr:favorevoli ?favorevoli } OPTIONAL { ?v osr:contrari ?contrari } OPTIONAL { ?v osr:astenuti ?astenuti }
OPTIONAL { ?v osr:presenti ?presenti } OPTIONAL { ?v osr:votanti ?votanti } OPTIONAL { ?v osr:maggioranza ?maggioranza }
OPTIONAL { ?v osr:congedoMissione ?congedoMissione } FILTER(?seduta >= {A} && ?seduta <= {B}) }"""

Q_VOT_DDL = PRE + """SELECT DISTINCT ?v ?ddl WHERE { ?v a osr:Votazione ; osr:legislatura 19 ; osr:seduta ?s ; osr:oggetto ?o .
?o osr:relativoA ?ddl . ?s osr:numeroSeduta ?seduta . FILTER(?seduta >= {A} && ?seduta <= {B}) }"""

Q_DDL = PRE + """SELECT DISTINCT ?ddl ?fase ?idDdl ?titolo ?breve WHERE { ?v a osr:Votazione ; osr:legislatura 19 ; osr:seduta ?s ; osr:oggetto ?o .
?o osr:relativoA ?ddl . ?s osr:numeroSeduta ?seduta . OPTIONAL { ?ddl osr:fase ?fase } OPTIONAL { ?ddl osr:idDdl ?idDdl }
OPTIONAL { ?ddl osr:titolo ?titolo } OPTIONAL { ?ddl osr:titoloBreve ?breve } FILTER(?seduta >= {A} && ?seduta <= {B}) }"""

# tutti i DDL della legislatura con fase S.: servono per le fiducie, che citano il numero solo nel testo
Q_DDL_FASI = PRE + """SELECT DISTINCT ?ddl ?fase ?idDdl ?titolo ?breve WHERE { ?ddl a osr:Ddl ; osr:legislatura 19 ; osr:fase ?fase .
OPTIONAL { ?ddl osr:idDdl ?idDdl } OPTIONAL { ?ddl osr:titolo ?titolo } OPTIONAL { ?ddl osr:titoloBreve ?breve }
FILTER(STRSTARTS(STR(?fase), "S.")) }"""

Q_VOTI = PRE + """SELECT ?v ?p ?s WHERE { ?v a osr:Votazione ; osr:seduta ?x ; ?p ?s . {NUM}FILTER(?x IN ({SEDUTE}))
FILTER(?p IN (osr:favorevole, osr:contrario, osr:astenuto, osr:presenteNonVotante, osr:richiedenteNonVotante, osr:inCongedoMissione, osr:presidente)) }"""

richieste = 0
ultima = 0.0


class Bloccato(Exception):
    pass


def say(msg: str) -> None:
    print(msg, flush=True)


def sparql(query: str, timeout: int = 180, tries: int = 3) -> list[dict[str, str]]:
    """Una richiesta GET in CSV, con le pause tra una richiesta e l'altra."""
    global richieste, ultima
    enc = urllib.parse.urlencode({"query": query, "format": "text/csv"})
    if len("/sparql?" + enc) > MAX_URI:
        raise ValueError(f"query troppo lunga per il Senato ({len(enc)} byte)")
    for k in range(tries):
        wait = PAUSA - (time.time() - ultima)
        if wait > 0:
            time.sleep(wait)
        ultima = time.time()
        richieste += 1
        r = subprocess.run(
            ["curl", "-sS", "-L", "-m", str(timeout), "-A", UA, "-H", "Accept: text/csv", "-w", "\n%{http_code}", f"{EP}?{enc}"],
            capture_output=True, text=True,
        )
        body, _, code = r.stdout.rpartition("\n")
        if code == "403":
            raise Bloccato()
        if r.returncode == 0 and code == "200" and not body.lstrip().startswith("<"):
            return list(csv.DictReader(io.StringIO(body)))
        motivo = f"HTTP {code or '000'}" + (f", curl: {r.stderr.strip()[:100]}" if r.returncode else "")
        if k < tries - 1:
            pausa = 20 * (k + 1)
            say(f"    risposta non valida ({motivo}), riprovo tra {pausa} s")
            time.sleep(pausa)
        else:
            raise RuntimeError(motivo)
    return []


def short(u: str) -> str:
    return u.rstrip("/").rsplit("/", 1)[-1]


def write(path: Path, rows: list[dict[str, str]], cols: list[str]) -> None:
    tmp = path.with_suffix(".tmp")
    with open(tmp, "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=cols, extrasaction="ignore")
        w.writeheader()
        w.writerows(rows)
    tmp.replace(path)


def blocchi(numeri: list[int]) -> list[tuple[int, int]]:
    out = []
    for k in range(0, len(numeri), BLOCCHI):
        part = numeri[k:k + BLOCCHI]
        out.append((part[0], part[-1]))
    return out


def main() -> None:
    RAW.mkdir(parents=True, exist_ok=True)
    VOTI.mkdir(exist_ok=True)
    t0 = time.time()

    # 1. sedute, senatori, gruppi
    say("1/4 · Sedute, senatori e gruppi")
    sedute = sparql(Q_SEDUTE)
    for r in sedute:
        r["seduta"] = short(r["s"])
    write(RAW / "sedute.csv", sedute, ["seduta", "numero", "data"])
    numeri = sorted({int(r["numero"]) for r in sedute})
    say(f"  {len(sedute)} sedute, dalla {numeri[0]} alla {numeri[-1]} ({sedute[-1]['data']})")
    for name, q, cols in (
        ("senatori", Q_SENATORI, ["senatore", "nome", "cognome", "genere", "inizio", "fine", "tipoMandato", "tipoElezione", "collegio", "regione"]),
        ("adesioni", Q_ADESIONI, ["senatore", "gruppo", "carica", "inizio", "fine"]),
        ("gruppi", Q_GRUPPI, ["gruppo", "titolo", "breve", "inizio", "fine"]),
    ):
        rows = sparql(q)
        write(RAW / f"{name}.csv", rows, cols)
        say(f"  {name}: {len(rows)} righe")

    # 2. votazioni e collegamenti ai DDL, a blocchi di sedute
    say("2/4 · Votazioni")
    vz: dict[str, dict[str, str]] = {}
    links: set[tuple[str, str]] = set()
    ddl: dict[str, dict[str, str]] = {}
    for a, b in blocchi(numeri):
        rows = sparql(Q_VOTAZIONI.replace("{A}", str(a)).replace("{B}", str(b)))
        if len(rows) >= CAP:
            raise RuntimeError(f"sedute {a}-{b}: troppe righe, riduci BLOCCHI")
        for r in rows:
            vz.setdefault(short(r["v"]), r)
        for r in sparql(Q_VOT_DDL.replace("{A}", str(a)).replace("{B}", str(b))):
            links.add((short(r["v"]), short(r["ddl"])))
        for r in sparql(Q_DDL.replace("{A}", str(a)).replace("{B}", str(b))):
            ddl.setdefault(short(r["ddl"]), r)
        say(f"  sedute {a}-{b}: {len(vz)} votazioni finora")
    for r in sparql(Q_DDL_FASI):
        ddl.setdefault(short(r["ddl"]), r)
    righe = []
    for vid, r in vz.items():
        r = dict(r)
        r["votazione"] = vid
        righe.append(r)
    righe.sort(key=lambda r: (int(r["seduta"]), int(r["numero"])))
    write(RAW / "votazioni.csv", righe, ["votazione", "seduta", "data", "numero", "label", "tipo", "esito", "favorevoli", "contrari", "astenuti", "presenti", "votanti", "maggioranza", "congedoMissione"])
    write(RAW / "votazioni_ddl.csv", [{"votazione": v, "ddl": d} for v, d in sorted(links)], ["votazione", "ddl"])
    for k, r in ddl.items():
        r["ddl"] = k
    write(RAW / "ddl.csv", sorted(ddl.values(), key=lambda r: r["ddl"]), ["ddl", "fase", "idDdl", "titolo", "breve"])
    say(f"  {len(righe)} votazioni · {len(links)} collegamenti a {len(ddl)} DDL")

    # 3. voti individuali, seduta per seduta (più sedute piccole per richiesta)
    say("3/4 · Voti individuali")
    per_seduta: dict[int, list[int]] = defaultdict(list)
    for r in righe:
        per_seduta[int(r["seduta"])].append(int(r["numero"]))
    uri_seduta = {int(r["numero"]): short(r["s"]) for r in sedute}
    fatte = {int(p.stem[1:]) for p in VOTI.glob("s*.csv")}
    # le ultime due sedute si riscaricano sempre: il Senato potrebbe averle completate dopo
    for n in sorted(fatte)[-2:]:
        fatte.discard(n)
    todo = [n for n in sorted(per_seduta) if n not in fatte]
    say(f"  {len(per_seduta)} sedute con votazioni · da scaricare: {len(todo)}")

    # gruppi di richieste: sedute intere finché stanno sotto MAX_VOTI, quelle grandi a fette di numeri
    lavori: list[tuple[list[int], tuple[int, int] | None]] = []
    gruppo: list[int] = []
    tot = 0
    for n in todo:
        k = len(per_seduta[n])
        if k > MAX_VOTI:
            if gruppo:
                lavori.append((gruppo, None))
                gruppo, tot = [], 0
            nums = sorted(per_seduta[n])
            for i in range(0, len(nums), MAX_VOTI):
                lavori.append(([n], (nums[i], nums[min(i + MAX_VOTI, len(nums)) - 1])))
            continue
        if tot + k > MAX_VOTI or len(gruppo) >= 12:
            lavori.append((gruppo, None))
            gruppo, tot = [], 0
        gruppo.append(n)
        tot += k
    if gruppo:
        lavori.append((gruppo, None))

    parziali: dict[int, list[tuple[str, str, str]]] = defaultdict(list)
    attese: dict[int, int] = defaultdict(int)
    for gr, rng in lavori:
        for n in gr:
            attese[n] += 1
    eta = len(lavori) * (PAUSA + 1.5) / 60
    say(f"  {len(lavori)} richieste, circa {eta:.0f} minuti")

    def scarica(gr: list[int], rng: tuple[int, int] | None) -> list[dict[str, str]]:
        num = f"?v osr:numero ?n . FILTER(?n >= {rng[0]} && ?n <= {rng[1]}) " if rng else ""
        q = Q_VOTI.replace("{NUM}", num).replace("{SEDUTE}", ", ".join(f"sa:{uri_seduta[n]}" for n in gr))
        rows = sparql(q)
        if len(rows) >= CAP:
            # troppe righe: si divide e si riprova
            if rng and rng[1] > rng[0]:
                mid = (rng[0] + rng[1]) // 2
                return scarica(gr, (rng[0], mid)) + scarica(gr, (mid + 1, rng[1]))
            if len(gr) > 1:
                h = len(gr) // 2
                return scarica(gr[:h], None) + scarica(gr[h:], None)
            nums = sorted(per_seduta[gr[0]])
            mid = nums[len(nums) // 2]
            return scarica(gr, (nums[0], mid - 1)) + scarica(gr, (mid, nums[-1]))
        return rows

    for k, (gr, rng) in enumerate(lavori, 1):
        rows = scarica(gr, rng)
        for r in rows:
            vid = short(r["v"])
            code = LISTE.get(short(r["p"]))
            if code:
                n = int(vid.split("-")[1])
                parziali[n].append((vid, code, short(r["s"])))
        for n in gr:
            attese[n] -= 1
            if attese[n] == 0:
                out = sorted(set(parziali.pop(n, [])))
                tmp = VOTI / f"s{n:04d}.tmp"
                with open(tmp, "w", encoding="utf-8", newline="") as f:
                    w = csv.writer(f)
                    w.writerow(["votazione", "voto", "senatore"])
                    w.writerows(out)
                tmp.replace(VOTI / f"s{n:04d}.csv")
        if k % 10 == 0 or k == len(lavori):
            say(f"  {k}/{len(lavori)} richieste · seduta {gr[-1]} · {(time.time() - t0) / 60:.0f} min")

    # 4. controllo: elenchi contro totali ufficiali
    say("4/4 · Controllo")
    conta: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    for p in sorted(VOTI.glob("s*.csv")):
        for r in csv.DictReader(open(p, encoding="utf-8", newline="")):
            conta[r["votazione"]][r["voto"]] += 1
    ok = diff = senza = 0
    esempi = []
    for r in righe:
        if r.get("tipo") in ("segreta", "verifica numero legale"):
            continue
        c = conta.get(r["votazione"])
        if not c:
            senza += 1
            continue
        attesi = [r.get("favorevoli") or "0", r.get("contrari") or "0", r.get("astenuti") or "0"]
        trovati = [str(c.get("F", 0)), str(c.get("C", 0)), str(c.get("A", 0))]
        if attesi == trovati:
            ok += 1
        else:
            diff += 1
            if len(esempi) < 20:
                esempi.append(f"  {r['votazione']} ({r['data']}): ufficiali F/C/A {'/'.join(attesi)}, elenchi {'/'.join(trovati)}")
    tipi = defaultdict(int)
    for r in righe:
        tipi[r.get("tipo") or "?"] += 1
    rep = [
        f"Senato · scarico del {time.strftime('%Y-%m-%d %H:%M')} · {richieste} richieste in {(time.time() - t0) / 60:.0f} min",
        f"Sedute: {len(sedute)} · votazioni: {len(righe)} · " + ", ".join(f"{k} {v}" for k, v in sorted(tipi.items())),
        f"Elenchi che tornano con i totali (F/C/A): {ok} · non tornano: {diff} · senza elenchi: {senza}",
        *esempi,
    ]
    (RAW / "controllo.txt").write_text("\n".join(rep) + "\n", encoding="utf-8")
    say("\n".join(rep))

    # 5. pacchetto da mandare
    with zipfile.ZipFile(ZIP, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for p in sorted(RAW.glob("*.csv")) + sorted(VOTI.glob("s*.csv")) + [RAW / "controllo.txt"]:
            z.write(p, f"raw/senato/{p.relative_to(RAW).as_posix()}")
    say(f"\nFatto. Creato {ZIP.name} ({ZIP.stat().st_size / 1e6:.1f} MB): mandalo a Claude.")


if __name__ == "__main__":
    try:
        main()
    except Bloccato:
        sys.exit(
            "\nIl Senato ha risposto 403: ha bloccato le richieste da questa rete.\n"
            "Non rilanciare subito: aspetta qualche ora o usa un'altra rete (per esempio l'hotspot del telefono).\n"
            "Quando rilanci, lo script riparte dalle sedute che mancano."
        )
    except KeyboardInterrupt:
        sys.exit("\nInterrotto. Rilancia lo stesso comando per riprendere.")
