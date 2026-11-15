#!/usr/bin/env python3
"""
Atlante XIX · prepara i dati scaricati in una forma compatta

Legge pipeline/data/raw/camera/ (scarica.py e, se c'è, missioni.py) e scrive
pipeline/data/clean/camera/:

    votazioni.csv        una riga per votazione, in ordine, con indice
    deputati.csv         una riga per deputato, con indice di colonna
    matrice_voti.txt     una riga per votazione: identificativo, TAB, un carattere per deputato
    matrice_gruppi.txt   stessa forma: il gruppo di ogni deputato in quella votazione
    codici_gruppi.csv    carattere → gruppo (identificativo e sigla)
    controllo.txt        riepilogo e controlli

Ogni votazione ha uno stato dei voti individuali (colonna stato_voti):
    completi    i voti individuali tornano con i totali ufficiali
    corretti    tornano dopo aver tolto voti di deputati fuori dal mandato
    incompleti  non tornano: esclusa dalle metriche individuali, restano i totali
    segreta     voti individuali inesistenti

Caratteri di matrice_voti.txt:
    F favorevole · C contrario · A astensione · N non ha partecipato
    M in missione · P presidente di turno · - nessun voto registrato · S votazione segreta

Alla fine crea atlante_dati.zip nella cartella atlante-xix, da mandare a Claude.

Uso, dalla cartella atlante-xix:
    python3 pipeline/fetch/prepara.py
"""
from __future__ import annotations

import csv
import re
import string
import zipfile
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve()
RAW = HERE.parents[1] / "data" / "raw" / "camera"
CLEAN = HERE.parents[1] / "data" / "clean" / "camera"
ZIP = HERE.parents[2] / "atlante_dati.zip"
csv.field_size_limit(10_000_000)

ESPR = {"Favorevole": "F", "Contrario": "C", "Astensione": "A", "Non ha votato": "N"}
VID = re.compile(r"vs19_(\d+)_(\d+)$")
DID = re.compile(r"d(\d+)_19$")
GROUP_CHARS = string.ascii_uppercase + string.ascii_lowercase + string.digits


def last(uri: str) -> str:
    return uri.rsplit("/", 1)[-1]


def main() -> None:
    CLEAN.mkdir(parents=True, exist_ok=True)
    report: list[str] = []

    # ---- votazioni
    vz: dict[str, dict] = {}
    for p in sorted((RAW / "votazioni").glob("*.csv")):
        with open(p, encoding="utf-8", newline="") as f:
            for r in csv.DictReader(f):
                vid = last(r["votazione"])
                if VID.match(vid) and vid not in vz:
                    r["id"] = vid
                    vz[vid] = r
    if not vz:
        raise SystemExit("Non trovo i metadati delle votazioni: lancia prima scarica.py.")
    order = sorted(vz, key=lambda v: (vz[v].get("data", ""), int(VID.match(v).group(1)), int(VID.match(v).group(2))))
    vidx = {v: i for i, v in enumerate(order)}
    secret = {v for v in order if vz[v].get("segreta") == "1"}

    # ---- deputati (indice di colonna stabile: ordine numerico dell'identificativo)
    deps: dict[str, dict] = {}
    with open(RAW / "deputati.csv", encoding="utf-8", newline="") as f:
        for r in csv.DictReader(f):
            did = last(r["deputato"])
            cur = deps.setdefault(did, {"deputato_id": did})
            for k, v in r.items():
                if k != "deputato" and v and not cur.get(k):
                    cur[k] = v

    # ---- voti
    rows_by_vote: dict[str, list[tuple[str, str, str, str]]] = {}
    unknown_expr: Counter = Counter()
    extra_deps: set[str] = set()
    n_rows = dup = 0
    seen_pairs: set[tuple[int, str]] = set()
    for p in sorted((RAW / "voti").glob("*/*.csv")):
        with open(p, encoding="utf-8", newline="") as f:
            for r in csv.DictReader(f):
                vid, did = last(r["votazione_id"]), last(r["deputato_id"])
                if vid not in vidx:
                    continue
                key = (vidx[vid], did)
                if key in seen_pairs:
                    dup += 1
                    continue
                seen_pairs.add(key)
                n_rows += 1
                e = ESPR.get(r["espressione"])
                if e is None:
                    unknown_expr[r["espressione"]] += 1
                    continue
                if did not in deps:
                    extra_deps.add(did)
                g = last(r.get("gruppo_id", "")) or (("sigla:" + r["sigla"]) if r.get("sigla") else "")
                rows_by_vote.setdefault(vid, []).append((did, e, g, r.get("sigla", "")))
    seen_pairs.clear()
    duplicates: dict[str, str] = {}
    for x in extra_deps:
        # un deputato che manca dall'elenco e che in ogni votazione vota esattamente come
        # un altro deputato (e solo come lui) è un doppione nei dati della Camera
        same: set | None = None
        for vid, rows in rows_by_vote.items():
            ex = next((e for d, e, _g, _s in rows if d == x), None)
            if ex is None:
                continue
            cand = {d for d, e, _g, _s in rows if e == ex and d != x}
            same = cand if same is None else same & cand
            if not same:
                break
        if same and len(same) == 1:
            duplicates[x] = next(iter(same))
    if duplicates:
        for vid in list(rows_by_vote):
            rows_by_vote[vid] = [r for r in rows_by_vote[vid] if r[0] not in duplicates]
    for did in extra_deps - set(duplicates):
        deps[did] = {"deputato_id": did, "nota": "presente nei voti ma non in deputati.csv"}

    # ---- stato dei voti individuali di ogni votazione
    def in_mandate(did: str, date: str) -> bool:
        d = deps.get(did, {})
        a, b = d.get("inizio_mandato", ""), d.get("fine_mandato", "")
        return (not a or a <= date) and (not b or date <= b)

    def official(vid: str):
        try:
            return tuple(int(float(vz[vid][k])) for k in ("favorevoli", "contrari", "astenuti"))
        except (TypeError, ValueError, KeyError):
            return None

    def fca(rows) -> tuple[int, int, int]:
        c = Counter(e for _d, e, _g, _s in rows)
        return c["F"], c["C"], c["A"]

    stato: dict[str, str] = {}
    removed: Counter = Counter()
    outside_total = 0
    for vid in order:
        rows = rows_by_vote.get(vid, [])
        date = vz[vid].get("data", "")
        outside_total += sum(1 for r in rows if not in_mandate(r[0], date))
        u = official(vid)
        if vid in secret:
            stato[vid] = "segreta"
        elif not rows:
            stato[vid] = "incompleti"
        elif u is None or fca(rows) == u:
            stato[vid] = "completi"
        else:
            kept = [r for r in rows if in_mandate(r[0], date)]
            if len(kept) < len(rows) and fca(kept) == u:
                for r in rows:
                    if not in_mandate(r[0], date):
                        removed[r[0]] += 1
                rows_by_vote[vid] = kept
                stato[vid] = "corretti"
            else:
                stato[vid] = "incompleti"

    dep_order = sorted(deps, key=lambda d: int(DID.match(d).group(1)) if DID.match(d) else 10**9)
    didx = {d: i for i, d in enumerate(dep_order)}
    N, V = len(dep_order), len(order)

    # ---- missioni
    missions: dict[str, set[str]] = {}
    mfile = RAW / "missioni" / "missioni.csv"
    if mfile.exists():
        with open(mfile, encoding="utf-8", newline="") as f:
            for r in csv.DictReader(f):
                missions.setdefault(r["votazione_id"], set()).add(r["deputato_id"])

    # ---- gruppi: carattere per ogni identificativo di gruppo
    sig: dict[str, Counter] = {}
    for vid, rows in rows_by_vote.items():
        for _d, _e, g, s in rows:
            if g:
                sig.setdefault(g, Counter())[s] += 1
    gids = sorted(sig, key=lambda g: -sum(sig[g].values()))
    if len(gids) > len(GROUP_CHARS):
        raise SystemExit(f"Troppi gruppi ({len(gids)}) per la codifica a un carattere.")
    gchar = {g: GROUP_CHARS[i] for i, g in enumerate(gids)}

    # ---- matrici
    mv = CLEAN / "matrice_voti.txt"
    mg = CLEAN / "matrice_gruppi.txt"
    codes: Counter = Counter()
    no_rows = m_applied = p_applied = m_unmatched = 0
    with open(mv, "w", encoding="utf-8") as fv, open(mg, "w", encoding="utf-8") as fg:
        for vid in order:
            if vid in secret:
                line_v = "S" * N
                line_g = "." * N
            else:
                bv = bytearray(b"-" * N)
                bg = bytearray(b"." * N)
                rows = rows_by_vote.get(vid, [])
                if not rows:
                    no_rows += 1
                for did, e, g, _s in rows:
                    i = didx[did]
                    bv[i] = ord(e)
                    if g in gchar:
                        bg[i] = ord(gchar[g])
                for did in missions.get(vid, ()):
                    i = didx.get(did)
                    if i is None:
                        m_unmatched += 1
                    elif bv[i] == ord("N"):
                        bv[i] = ord("M")
                        m_applied += 1
                pres = last(vz[vid].get("presieduta", ""))
                if pres in didx and bv[didx[pres]] in (ord("N"), ord("-")):
                    bv[didx[pres]] = ord("P")
                    p_applied += 1
                line_v, line_g = bv.decode(), bg.decode()
            codes.update(line_v)
            fv.write(f"{vid}\t{line_v}\n")
            fg.write(f"{vid}\t{line_g}\n")

    # ---- votazioni.csv e deputati.csv
    cols = ["indice", "id", "stato_voti"] + [c for c in next(iter(vz.values())).keys() if c not in ("id",)]
    with open(CLEAN / "votazioni.csv", "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(cols)
        for i, vid in enumerate(order):
            r = vz[vid]
            w.writerow([i, vid, stato[vid]] + [r.get(c, "") for c in cols[3:]])
    dcols = ["indice", "deputato_id"] + sorted({k for d in deps.values() for k in d} - {"deputato_id"})
    with open(CLEAN / "deputati.csv", "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(dcols)
        for i, did in enumerate(dep_order):
            w.writerow([i, did] + [deps[did].get(c, "") for c in dcols[2:]])
    with open(CLEAN / "codici_gruppi.csv", "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(["carattere", "gruppo_id", "sigla", "voti"])
        for g in gids:
            w.writerow([gchar[g], g, sig[g].most_common(1)[0][0], sum(sig[g].values())])

    # ---- controllo
    nonvot = codes["N"] + codes["M"] + codes["P"]
    report += [
        f"Votazioni: {V:,} (segrete: {len(secret)}) · deputati (colonne): {N}",
        f"Righe di voto: {n_rows:,} · doppioni tolti: {dup:,} · votazioni palesi senza voti: {no_rows}",
        "Stato dei voti individuali: " + ", ".join(f"{k} {v:,}" for k, v in Counter(stato.values()).most_common()),
        "Voti tolti perché fuori dal mandato: " + (", ".join(
            f"{deps.get(d, {}).get('cognome', '')} {deps.get(d, {}).get('nome', '')} ({d}, mandato "
            f"{deps.get(d, {}).get('inizio_mandato', '?')}–{deps.get(d, {}).get('fine_mandato', '') or 'oggi'}): {n}"
            for d, n in removed.most_common()) if removed else "nessuno"),
        f"Voti registrati fuori dal mandato in tutta la legislatura: {outside_total:,}",
        "Votazioni incomplete: " + (", ".join(v for v in order if stato[v] == "incompleti")[:2000] or "nessuna"),
        f"Gruppi distinti nei voti: {len(gids)}",
        "Missioni: " + (f"{m_applied:,} applicate · {m_unmatched} deputati non trovati" if missions else "non ancora scaricate (missioni.py)"),
        f"Presidenti di turno segnati: {p_applied:,}",
        "Caratteri nella matrice: " + ", ".join(f"{k} {v:,}" for k, v in sorted(codes.items(), key=lambda x: -x[1])),
        (f"Quota di missioni tra chi non ha votato: {codes['M'] / nonvot:.1%}" if missions and nonvot else ""),
        "Espressioni non riconosciute: " + (", ".join(f"{k} ({v})" for k, v in unknown_expr.items()) if unknown_expr else "nessuna"),
        f"Deputati presenti nei voti ma non in deputati.csv: {len(extra_deps)}"
        + (" · doppioni tolti: " + ", ".join(f"{x} = {d} ({deps[d].get('cognome', '')} {deps[d].get('nome', '')})" for x, d in duplicates.items()) if duplicates else ""),
    ]
    text = "\n".join(re.sub(r"(\d),(\d{3})", r"\1.\2", re.sub(r"(\d),(\d{3})", r"\1.\2", l)) for l in report if l) + "\n"
    (CLEAN / "controllo.txt").write_text(text, encoding="utf-8")
    print(text)

    # ---- zip da mandare
    extra = [RAW / "deputati.csv", RAW / "adesioni.csv", RAW / "gruppi.csv", RAW / "controllo.txt",
             RAW / "controllo.csv", RAW / "missioni" / "controllo.txt"]
    with zipfile.ZipFile(ZIP, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for p in sorted(CLEAN.iterdir()):
            z.write(p, f"clean/{p.name}")
        for p in extra:
            if p.exists():
                z.write(p, f"raw/{p.relative_to(RAW)}")
        for p in sorted((RAW / "esplora").glob("*.csv")):
            z.write(p, f"raw/esplora/{p.name}")
    print(f"Creato {ZIP.name} ({ZIP.stat().st_size / 1e6:.1f} MB): mandalo a Claude.")


if __name__ == "__main__":
    main()
