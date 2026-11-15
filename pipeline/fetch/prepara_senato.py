#!/usr/bin/env python3
"""
Atlante XIX · prepara i dati del Senato in una forma compatta

Legge pipeline/data/raw/senato/ (scarica_senato.py) e scrive pipeline/data/clean/senato/
negli stessi formati della Camera (vedi prepara.py), così analizza.py li tratta allo stesso modo:

    votazioni.csv        una riga per votazione, in ordine, con indice
    deputati.csv         una riga per senatore, con indice di colonna
    matrice_voti.txt     una riga per votazione: identificativo, TAB, un carattere per senatore
    matrice_gruppi.txt   stessa forma: il gruppo di ogni senatore in quella votazione
    codici_gruppi.csv    carattere → gruppo (identificativo e sigla)
    controllo.txt        riepilogo e controlli

Caratteri di matrice_voti.txt:
    F favorevole · C contrario · A astenuto
    V presente non votante (compreso chi ha chiesto la votazione senza votare)
    M in congedo o missione · P presidente di turno
    N assente: in carica, ma in nessun elenco della votazione
    - non in carica quel giorno · S votazione segreta

Stato dei voti individuali (colonna stato_voti), come alla Camera:
    completi    gli elenchi tornano con i totali ufficiali
    corretti    tornano dopo aver tolto senatori fuori dal mandato
    incompleti  non tornano: esclusa dalle metriche individuali, restano i totali
    segreta     voti individuali inesistenti

Le verifiche del numero legale non sono votazioni e restano fuori, come le votazioni annullate
(sono ripetute subito dopo). Le controprove restano: sono votazioni registrate a tutti gli effetti.

Uso, dalla cartella atlante-xix:
    python3 pipeline/fetch/prepara_senato.py
"""
from __future__ import annotations

import csv
import re
import string
from collections import Counter, defaultdict
from pathlib import Path

HERE = Path(__file__).resolve()
RAW = HERE.parents[1] / "data" / "raw" / "senato"
CLEAN = HERE.parents[1] / "data" / "clean" / "senato"
csv.field_size_limit(10_000_000)

GROUP_CHARS = string.ascii_uppercase + string.ascii_lowercase + string.digits
# un senatore può comparire in più elenchi della stessa votazione: vale il primo di questa scala
RANK = {"F": 0, "C": 0, "A": 0, "P": 1, "M": 2, "V": 3, "R": 3}
SCHEDA_VOTO = "https://dati.senato.it/votazione/{}"


def last(u: str) -> str:
    return (u or "").rstrip("/").rsplit("/", 1)[-1]


def ymd(d: str) -> str:
    """2022-10-13 (anche con orario o tipo) → 20221013"""
    m = re.match(r"(\d{4})-?(\d{2})-?(\d{2})", d or "")
    return "".join(m.groups()) if m else ""


def read(name: str) -> list[dict[str, str]]:
    p = RAW / name
    if not p.exists():
        return []
    with open(p, encoding="utf-8", newline="") as f:
        return list(csv.DictReader(f))


def clean_text(t: str) -> str:
    return re.sub(r"\s+", " ", t or "").strip()


def classify(label: str) -> tuple[str, bool, bool, bool]:
    """tipo, finale, fiducia, sfiducia: il Senato li indica solo nel testo della votazione"""
    lo = re.sub(r"\s+", " ", label.lower())
    if lo.startswith("controprova"):
        return "Controprova", False, False, False
    if "sfiducia" in lo:
        return "Mozione", False, True, True
    if "fiducia" in lo:
        # la fiducia iniziale al Governo è una mozione; le altre sono questioni di fiducia su un atto
        on_act = re.search(r"\bd\.?d\.?l\b|disegno di legge|\ba\.?\s?s\b|\bart\.|articol|em\.|emendament", lo)
        return ("Questione di fiducia" if on_act else "Mozione"), False, True, False
    if "votazione finale" in lo or re.search(r"\bvoto finale\b", lo):
        return "Votazione finale", True, False, False
    # spesso il testo comincia con il riferimento all'atto ("DDL n. 855. Em. 1.1, …"): si cerca ovunque
    rules = [
        (r"\bemm?\.\s*\w|\bemm\s+\d|\bemendament|\bsubemend", "Emendamento"),
        (r"\bodg\b|\bo\.d\.g|ordine del giorno|(^|\.\s)g\s?\d", "Ordine del giorno"),
        (r"p[r]?egiudizial|questionepregiud", "Questione pregiudiziale"),
        (r"sospensiv", "Questione sospensiva"),
        (r"non passa", "Non passaggio agli articoli"),
        (r"(^|\.\s)(mantenimento\s+)?(art\.|articol)", "Articolo"),
        (r"(^|\.\s)coord|\bcoo?rdinament", "Coordinamento"),
        (r"risol|\bprop\.?\s*(di\s+)?ris\b|\bris\.\s*n\b", "Risoluzione"),
        (r"mozion", "Mozione"),
        (r"\bgiunta\b", "Proposta della Giunta"),
    ]
    for rx, t in rules:
        if re.search(rx, lo):
            return t, False, False, False
    return "Altre", False, False, False


def main() -> None:
    vraw = read("votazioni.csv")
    if not vraw:
        raise SystemExit("Non trovo pipeline/data/raw/senato/votazioni.csv: lancia prima scarica_senato.py.")
    CLEAN.mkdir(parents=True, exist_ok=True)
    report: list[str] = []

    # ---- votazioni (senza le verifiche del numero legale)
    vz: dict[str, dict[str, str]] = {}
    skipped = Counter()
    for r in vraw:
        vid = r["votazione"]
        tipo_v = (r.get("tipo") or "").strip().lower()
        if "numero legale" in tipo_v:
            skipped["verifiche del numero legale"] += 1
            continue
        if re.search(r"\bannullat", (r.get("label") or "").lower()):
            skipped["votazioni annullate"] += 1
            continue
        vz.setdefault(vid, r)
    order = sorted(vz, key=lambda v: (int(vz[v]["seduta"]), int(vz[v]["numero"])))
    vidx = {v: i for i, v in enumerate(order)}
    secret = {v for v in order if (vz[v].get("tipo") or "").strip().lower() == "segreta"}

    # ---- DDL: numero dell'atto (fase S.n) e titolo
    ddl = {r["ddl"]: r for r in read("ddl.csv")}

    def act_of(d: dict[str, str]) -> str:
        m = re.match(r"\s*S\.?\s*(\d+(?:-[A-Za-z]+)*)", d.get("fase") or "")
        return m.group(1) if m else ""

    links: dict[str, list[str]] = defaultdict(list)
    for r in read("votazioni_ddl.csv"):
        if r["ddl"] in ddl and act_of(ddl[r["ddl"]]):
            links[r["votazione"]].append(r["ddl"])
    by_number: dict[str, list[str]] = defaultdict(list)       # "1793" → ddl con fase S.1793, S.1793-B…
    for k, d in ddl.items():
        a = act_of(d)
        if a:
            by_number[a.split("-")[0]].append(k)

    # le fiducie citano il numero del DDL solo nel testo: lo si cerca tra gli atti della stessa seduta
    seduta_ddl: dict[str, set[str]] = defaultdict(set)
    for v, ks in links.items():
        if v in vz:
            seduta_ddl[vz[v]["seduta"]].update(ks)
    fid_linked = fid_total = 0
    for v in order:
        lab = vz[v].get("label") or ""
        if links.get(v) or "fiducia" not in lab.lower():
            continue
        fid_total += 1
        m = re.search(r"(?:d\.?d\.?l\.?|disegno di legge|a\.\s?s\.?)\s*(?:n\.?)?\s*(\d+)", lab, re.I)
        if not m:
            continue
        cands = by_number.get(m.group(1), [])
        same = [k for k in cands if k in seduta_ddl.get(vz[v]["seduta"], set())]
        pick = same or [k for k in cands if act_of(ddl[k]) == m.group(1)]
        if pick:
            links[v] = pick[:1]
            fid_linked += 1

    # ---- senatori: righe dei mandati della XIX
    sen: dict[str, dict] = {}
    for r in read("senatori.csv"):
        sid = last(r["senatore"])
        s = sen.setdefault(sid, {"id": sid, "intervalli": set()})
        for k in ("nome", "cognome", "genere", "tipoMandato", "tipoElezione", "collegio", "regione"):
            if r.get(k) and not s.get(k):
                s[k] = clean_text(r[k])
        if r.get("inizio"):
            s["intervalli"].add((ymd(r["inizio"]), ymd(r.get("fine", ""))))

    # ---- voti individuali
    lists: dict[str, dict[str, set[str]]] = defaultdict(lambda: defaultdict(set))
    n_rows = 0
    voti_dir = RAW / "voti"
    for p in sorted(voti_dir.glob("s*.csv")):
        with open(p, encoding="utf-8", newline="") as f:
            for r in csv.DictReader(f):
                if r["votazione"] in vidx:
                    lists[r["votazione"]][r["senatore"]].add(r["voto"])
                    n_rows += 1
    in_votes = {s for d in lists.values() for s in d}
    keep = {s for s, d in sen.items() if d.get("tipoMandato")} | in_votes
    extra = sorted(in_votes - set(sen))
    for s in extra:
        sen[s] = {"id": s, "intervalli": set(), "nota": "presente nei voti ma non tra i senatori"}
    no_mandate = sorted(s for s in sen if s not in keep)
    sids = sorted(keep, key=lambda s: int(re.sub(r"\D", "", s) or 0))
    sidx = {s: i for i, s in enumerate(sids)}
    N, V = len(sids), len(order)

    def in_office(sid: str, date: str) -> bool:
        iv = sen[sid]["intervalli"]
        return not iv or any(a <= date and (not b or date <= b) for a, b in iv)

    # ---- gruppi: adesione e denominazione del gruppo in ogni data
    den: dict[str, list[tuple[str, str, str]]] = defaultdict(list)       # gruppo → (inizio, fine, sigla)
    for r in read("gruppi.csv"):
        den[last(r["gruppo"])].append((ymd(r.get("inizio", "")), ymd(r.get("fine", "")), clean_text(r.get("breve") or r.get("titolo"))))
    ades: dict[str, list[tuple[str, str, str]]] = defaultdict(list)      # senatore → (inizio, fine, gruppo)
    for r in read("adesioni.csv"):
        ades[last(r["senatore"])].append((ymd(r.get("inizio", "")), ymd(r.get("fine", "")), last(r["gruppo"])))

    def dist(date: str, a: str, b: str) -> int:
        """distanza in giorni (approssimata) tra una data e un intervallo"""
        def n(x: str) -> int:
            return int(x[:4]) * 372 + int(x[4:6]) * 31 + int(x[6:8]) if x else 0
        d = n(date)
        if a and d < n(a):
            return n(a) - d
        if b and d > n(b):
            return d - n(b)
        return 0

    def pick(rows: list[tuple[str, str, str]], date: str) -> tuple[tuple[str, str, str] | None, bool]:
        """la riga che copre la data (la più recente se più d'una), o la più vicina"""
        cover = [r for r in rows if (not r[0] or r[0] <= date) and (not r[1] or date <= r[1])]
        if cover:
            return max(cover, key=lambda r: r[0]), True
        if not rows:
            return None, False
        return min(rows, key=lambda r: dist(date, r[0], r[1])), False

    gcache: dict[tuple[str, str], str] = {}
    nearest = Counter()

    def group_at(sid: str, date: str) -> str:
        k = (sid, date)
        if k in gcache:
            return gcache[k]
        a, ok = pick(ades.get(sid, []), date)
        key = ""
        if a:
            if not ok:
                nearest[sid] += 1
            g = a[2]
            d, _ = pick(den.get(g, []), date)
            key = f"gr{g}:{d[0]}" if d else f"gr{g}"
        gcache[k] = key
        return key

    # ---- stato, codici e matrici
    def official(v: str):
        try:
            return tuple(int(float(vz[v][k])) for k in ("favorevoli", "contrari", "astenuti"))
        except (TypeError, ValueError, KeyError):
            return None

    def resolve(codes: set[str]) -> str:
        c = min(codes, key=lambda x: (RANK.get(x, 9), "FCA".find(x)))
        return "V" if c == "R" else c

    stato: dict[str, str] = {}
    removed = Counter()
    conflicts = outside = 0
    matrix_v: list[str] = []
    matrix_g: list[str] = []
    codes_count = Counter()
    gcount = Counter()
    for v in order:
        date = ymd(vz[v]["data"])
        if v in secret:
            stato[v] = "segreta"
            matrix_v.append("S" * N)
            matrix_g.append("." * N)
            codes_count["S"] += N
            continue
        got = lists.get(v, {})
        row = {}
        for sid, cs in got.items():
            if len(cs & set("FCA")) > 1:
                conflicts += 1
            row[sid] = resolve(cs)
        outs = [s for s in row if not in_office(s, date)]
        outside += len(outs)
        u = official(v)
        fca = Counter(c for c in row.values() if c in "FCA")
        if not got:
            stato[v] = "incompleti"
        elif u is None or (fca["F"], fca["C"], fca["A"]) == u:
            stato[v] = "completi"
        else:
            kept = {s: c for s, c in row.items() if s not in outs}
            k2 = Counter(c for c in kept.values() if c in "FCA")
            if outs and (k2["F"], k2["C"], k2["A"]) == u:
                for s in outs:
                    removed[s] += 1
                row = kept
                stato[v] = "corretti"
            else:
                stato[v] = "incompleti"
        bv = bytearray(b"-" * N)
        keys = [""] * N                  # gruppo di ogni senatore; i caratteri si assegnano dopo, per frequenza
        for sid in sids:
            i = sidx[sid]
            c = row.get(sid)
            if c is None:
                if not in_office(sid, date):
                    continue
                c = "N"
            bv[i] = ord(c)
            keys[i] = group_at(sid, date)
            gcount[keys[i]] += 1
        line = bv.decode()
        codes_count.update(line)
        matrix_v.append(line)
        matrix_g.append(keys)

    gcount.pop("", None)
    gids = sorted(gcount, key=lambda g: -gcount[g])
    if len(gids) > len(GROUP_CHARS):
        raise SystemExit(f"Troppi gruppi ({len(gids)}) per la codifica a un carattere.")
    gchar = {g: GROUP_CHARS[i] for i, g in enumerate(gids)}

    def sigla(key: str) -> str:
        g, _, start = key[2:].partition(":")
        for a, _b, s in den.get(g, []):
            if a == start:
                return s
        return key

    with open(CLEAN / "matrice_voti.txt", "w", encoding="utf-8") as fv, open(CLEAN / "matrice_gruppi.txt", "w", encoding="utf-8") as fg:
        for v, lv, lg in zip(order, matrix_v, matrix_g):
            fv.write(f"{v}\t{lv}\n")
            fg.write(f"{v}\t" + (lg if isinstance(lg, str) else "".join(gchar[k] if k else "." for k in lg)) + "\n")

    # ---- votazioni.csv
    cols = ["indice", "id", "stato_voti", "votazione", "data", "identificativo", "titolo", "descrizione", "tipo", "seduta",
            "atto", "aic", "presenti", "votanti", "maggioranza", "favorevoli", "contrari", "astenuti", "approvato", "finale",
            "fiducia", "segreta", "presieduta", "scheda", "sfiducia", "modalita", "congedo_missione", "ddl"]
    types = Counter()
    with open(CLEAN / "votazioni.csv", "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(cols)
        for i, v in enumerate(order):
            r = vz[v]
            label = clean_text(r.get("label")).rstrip(".")
            tipo, fin, fid, sfid = classify(label)
            types[tipo] += 1
            # disegni di legge esaminati insieme: in ordine di numero, il titolo del primo
            ks = sorted(dict.fromkeys(links.get(v, [])), key=lambda k: [int(x) if x.isdigit() else 0 for x in re.split(r"\D+", act_of(ddl[k])) if x] or [0])
            acts = [act_of(ddl[k]) for k in ks]
            titles = list(dict.fromkeys(t for t in (clean_text(ddl[k].get("titolo") or ddl[k].get("breve")) for k in ks) if t))
            titolo = label or "Votazione"
            if acts and not re.search(r"\d{2,}", titolo):
                titolo += f" · S. {acts[0]}" + (f" e altri {len(acts) - 1}" if len(acts) > 1 else "")
            descr = titles[0] if titles else label
            pres = next((s for s, c in lists.get(v, {}).items() if "P" in c), "")
            esito = (r.get("esito") or "").lower()
            w.writerow([
                i, v, stato[v], f"http://dati.senato.it/votazione/{v}", ymd(r["data"]), f"{r['seduta']}/{r['numero']}",
                titolo, descr, tipo, r["seduta"], " ".join(acts), "",
                r.get("presenti", ""), r.get("votanti", ""), r.get("maggioranza", ""),
                r.get("favorevoli", ""), r.get("contrari", ""), r.get("astenuti", ""),
                1 if esito.startswith("approvat") else 0, int(fin), int(fid), int(v in secret), pres,
                SCHEDA_VOTO.format(v), int(sfid), r.get("tipo", ""), r.get("congedoMissione", ""), " ".join(ks),
            ])

    # ---- deputati.csv (una riga per senatore, nello stesso formato della Camera)
    def kind(s: dict) -> tuple[str, str, str]:
        """tipo di elezione, circoscrizione, collegio"""
        tm = (s.get("tipoMandato") or "").lower()
        te = (s.get("tipoElezione") or "").lower()
        reg = s.get("regione") or ""
        if tm and tm != "elettivo":
            return s["tipoMandato"], "", ""
        if "ester" in te or (reg and reg.isupper()):
            return "circoscrizione Estero", ("Estero – " + reg.title()) if reg else "Estero", ""
        m = re.search(r"-\s*(U\d+)", s.get("collegio") or "")
        if "uninominal" in te or m:
            return "uninominale", reg, m.group(1) if m else ""
        return "proporzionale", reg, ""

    dcols = ["indice", "deputato_id", "cognome", "nome", "genere", "inizio_mandato", "fine_mandato", "tipo_elezione",
             "circoscrizione", "collegio", "collegio_esteso", "tipo_mandato", "lista", "nota"]
    with open(CLEAN / "deputati.csv", "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(dcols)
        for i, sid in enumerate(sids):
            s = sen[sid]
            iv = sorted(s["intervalli"])
            start = iv[0][0] if iv else ""
            end = "" if not iv or any(not b for _a, b in iv) else max(b for _a, b in iv)
            te, circ, coll = kind(s)
            g = (s.get("genere") or "").upper()
            w.writerow([i, sid, s.get("cognome", ""), s.get("nome", ""), "female" if g.startswith("F") else "male" if g.startswith("M") else "",
                        start, end, te, circ, coll, s.get("collegio", ""), s.get("tipoMandato", ""), "", s.get("nota", "")])
    with open(CLEAN / "codici_gruppi.csv", "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(["carattere", "gruppo_id", "sigla", "voti"])
        for g in gids:
            w.writerow([gchar[g], g, sigla(g), gcount[g]])

    # ---- controllo
    st = Counter(stato.values())
    name = lambda s: f"{sen[s].get('cognome', '')} {sen[s].get('nome', '')} ({s})"
    report += [
        f"Votazioni: {V:,} (segrete: {len(secret)}) · senatori (colonne): {N}",
        "Escluse: " + (", ".join(f"{k} {v:,}" for k, v in skipped.items()) or "nessuna"),
        f"Righe degli elenchi: {n_rows:,} · senatori in più elenchi F/C/A della stessa votazione: {conflicts}",
        "Stato dei voti individuali: " + ", ".join(f"{k} {v:,}" for k, v in st.most_common()),
        "Voti tolti perché fuori dal mandato: " + (", ".join(f"{name(s)}: {n}" for s, n in removed.most_common()) or "nessuno"),
        f"Presenze negli elenchi fuori dal mandato in tutta la legislatura: {outside:,}",
        "Votazioni incomplete: " + (", ".join(v for v in order if stato[v] == "incompleti")[:2000] or "nessuna"),
        "Tipi: " + ", ".join(f"{k} {v:,}" for k, v in types.most_common()),
        f"Votazioni collegate a un DDL: {sum(1 for v in order if links.get(v)):,} · fiducie collegate dal testo: {fid_linked} su {fid_total}",
        f"Gruppi (denominazioni) nei voti: {len(gids)} · " + ", ".join(f"{g} {sigla(g)}" for g in gids),
        "Senatori senza adesione a un gruppo nella data (preso il gruppo più vicino nel tempo): "
        + (", ".join(f"{name(s)}: {n}" for s, n in nearest.most_common(12)) or "nessuno"),
        "Caratteri nella matrice: " + ", ".join(f"{k} {v:,}" for k, v in codes_count.most_common()),
        f"Righe di senatori.csv escluse (senza mandato da senatore e mai negli elenchi): {len(no_mandate)}",
        "Senatori negli elenchi ma non in senatori.csv: " + (", ".join(extra) or "nessuno"),
    ]
    text = "\n".join(re.sub(r"(\d),(\d{3})", r"\1.\2", re.sub(r"(\d),(\d{3})", r"\1.\2", l)) for l in report if l) + "\n"
    (CLEAN / "controllo.txt").write_text(text, encoding="utf-8")
    print(text)
    print("Fatto. Ora: python3 pipeline/analysis/analizza.py senato")


if __name__ == "__main__":
    main()
