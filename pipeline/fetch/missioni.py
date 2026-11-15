#!/usr/bin/env python3
"""
Atlante XIX · deputati in missione, dalle schede ufficiali delle votazioni

L'endpoint SPARQL mette insieme in "Non ha votato" tre stati diversi:
non ha partecipato, in missione, presidente di turno. Le missioni compaiono solo
nella scheda HTML di ogni votazione su documenti.camera.it. Questo script le legge.

Non legge tutte le schede. Per ogni seduta legge la prima e l'ultima votazione:
se l'elenco dei deputati in missione è lo stesso, vale per tutte quelle in mezzo.
Se è diverso legge quella centrale, e continua a dividere finché trova dove cambia.
Per controllare l'ipotesi legge per intero alcune sedute e confronta.

Uso, dalla cartella atlante-xix, dopo scarica.py:
    python3 pipeline/fetch/missioni.py

Opzioni:
    --pausa S      secondi tra una pagina e l'altra (predefinito 1)
    --verifica N   sedute da leggere per intero per il controllo (predefinito 10)

Riprende da dove era arrivato: le schede già lette restano in missioni/schede/.
Richiede python3 (3.9 o più recente) e curl.
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import html
import os
import re
import subprocess
import sys
import time
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / "data" / "raw" / "camera"
OUT = ROOT / "missioni"
CACHE = OUT / "schede"
UA = "Mozilla/5.0 (compatible; AtlanteXIX/1.0; progetto civico di visualizzazione dati)"
SCHEDA = ("http://documenti.camera.it/apps/votazioni/votazionitutte/schedavotazione.asp"
          "?Legislatura=XIX&RifVotazione={s}_{n}&tipo=dettaglio")
STATI = {"Favorevole", "Contrario", "Astensione", "Non ha partecipato", "In missione", "Presidente di turno"}
TENTATIVI = 4
csv.field_size_limit(10_000_000)

ROW = re.compile(r"<tr[^>]*>\s*<td[^>]*>(.*?)</td>\s*<td[^>]*>(.*?)</td>\s*<td[^>]*>(.*?)</td>", re.S | re.I)
TAG = re.compile(r"<[^>]+>")
VID = re.compile(r"vs19_(\d+)_(\d+)$")
SIGLA = re.compile(r"^[A-Z0-9][A-Z0-9\-+]{1,12}$")


# ---------------------------------------------------------------- utilità

def log(msg: str) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    with open(OUT / "log.txt", "a", encoding="utf-8") as f:
        f.write(f"{dt.datetime.now():%Y-%m-%d %H:%M:%S}  {msg}\n")


def say(msg: str = "") -> None:
    print(msg, flush=True)
    if msg:
        log(msg)


def fmt_dur(sec: float) -> str:
    sec = int(sec)
    return f"{sec // 3600}h {sec % 3600 // 60:02d}m" if sec >= 3600 else f"{sec // 60}m {sec % 60:02d}s"


def norm(s: str) -> str:
    """Nome confrontabile: maiuscolo, senza accenti, apostrofi e punteggiatura."""
    s = unicodedata.normalize("NFD", s)
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = re.sub(r"[^A-Za-z0-9 ]+", "", s.replace("'", "").replace("’", "").replace("-", " "))
    return re.sub(r"\s+", " ", s).strip().upper()


def decode(raw: bytes) -> str:
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return raw.decode("cp1252", errors="replace")


def parse(page: str) -> list[tuple[str, str, str]]:
    rows = []
    for a, b, c in ROW.findall(page):
        nome = html.unescape(TAG.sub("", a)).strip()
        sigla = html.unescape(TAG.sub("", b)).strip()
        stato = re.sub(r"\s+", " ", html.unescape(TAG.sub("", c))).strip()
        if nome and stato:
            rows.append((nome, sigla, stato))
    return rows


class FetchError(Exception):
    pass


class Fetcher:
    def __init__(self, pausa: float):
        self.pausa = pausa
        self.last = 0.0
        self.read = 0

    def get(self, vid: str, url: str) -> list[tuple[str, str, str]]:
        """Righe della scheda (nome, sigla, stato), dalla cache o dal sito."""
        cached = CACHE / f"{vid}.tsv"
        if cached.exists():
            with open(cached, encoding="utf-8") as f:
                return [tuple(l.rstrip("\n").split("\t")) for l in f if l.strip()]  # type: ignore
        part = cached.with_suffix(".part")
        last = ""
        for attempt in range(1, TENTATIVI + 1):
            wait = self.pausa - (time.time() - self.last)
            if wait > 0:
                time.sleep(wait)
            self.last = time.time()
            r = subprocess.run(["curl", "-sS", "-L", "-m", "60", "-A", UA, "-o", str(part), "-w", "%{http_code}", url],
                               capture_output=True, text=True)
            code = r.stdout.strip()
            if r.returncode == 0 and code == "200" and part.exists():
                parsed = parse(decode(part.read_bytes()))
                rows = [x for x in parsed if x[2] in STATI]
                if len(rows) >= 300:
                    odd = sorted({x[2] for x in parsed if x[2] not in STATI and SIGLA.match(x[1]) and len(x[2]) < 40})
                    if odd:
                        log(f"{vid}: stati non previsti {odd}")
                    part.unlink()
                    tmp = cached.with_suffix(".tmp")
                    with open(tmp, "w", encoding="utf-8") as f:
                        for x in rows:
                            f.write("\t".join(x) + "\n")
                    os.replace(tmp, cached)
                    self.read += 1
                    return rows
                last = f"pagina senza tabella dei voti ({len(rows)} righe riconosciute)"
            else:
                last = f"HTTP {code or '000'} curl={r.returncode} {r.stderr.strip()[:120]}"
            log(f"tentativo {attempt}/{TENTATIVI} fallito per {vid}: {last}")
            time.sleep(min(60, 4 * attempt * attempt))
        part.unlink(missing_ok=True)
        raise FetchError(f"{vid}: {last}")


# ---------------------------------------------------------------- dati

def load_votazioni() -> dict[str, list[dict]]:
    """Votazioni palesi raggruppate per seduta, in ordine."""
    seen, by = set(), {}
    files = sorted((ROOT / "votazioni").glob("*.csv"))
    if not files:
        raise SystemExit("Non trovo i metadati delle votazioni: lancia prima scarica.py.")
    for p in files:
        with open(p, encoding="utf-8", newline="") as f:
            for r in csv.DictReader(f):
                vid = r["votazione"].rsplit("/", 1)[-1]
                m = VID.match(vid)
                if not m or vid in seen:
                    continue
                seen.add(vid)
                if r.get("segreta") == "1":
                    continue
                s, n = m.group(1), int(m.group(2))
                url = r.get("scheda") or SCHEDA.format(s=s, n=n)
                by.setdefault(s, []).append({"id": vid, "n": n, "data": r.get("data", ""), "url": url,
                                             "F": r.get("favorevoli"), "C": r.get("contrari"), "A": r.get("astenuti")})
    for s in by:
        by[s].sort(key=lambda v: v["n"])
    return dict(sorted(by.items(), key=lambda kv: (kv[1][0]["data"], int(kv[0]))))


class Deputati:
    """Abbina i nomi delle schede ai deputati.

    Le schede usano spesso il nome d'uso (ELLY SCHLEIN, PINO BICCHIELLI) e a volte
    un cognome più lungo (MARCHETTO ALIPRANDI): abbino prima per nome completo,
    poi per cognome, e solo se il cognome non basta confronto i nomi propri.
    """

    def __init__(self) -> None:
        p = ROOT / "deputati.csv"
        if not p.exists():
            raise SystemExit("Non trovo deputati.csv: lancia prima scarica.py.")
        self.deps: list[tuple[str, str, str, str, str]] = []  # id, cognome, nome, inizio, fine
        seen = set()
        with open(p, encoding="utf-8", newline="") as f:
            for r in csv.DictReader(f):
                item = (r["deputato"].rsplit("/", 1)[-1], norm(r["cognome"]), norm(r["nome"]),
                        r.get("inizio_mandato") or "", r.get("fine_mandato") or "")
                if item not in seen:
                    seen.add(item)
                    self.deps.append(item)
        self.full: dict[str, list] = {}
        for d in self.deps:
            self.full.setdefault(f"{d[1]} {d[2]}", []).append(d)
        self.cache: dict[str, tuple[list, str]] = {}

    def candidates(self, page_name: str) -> tuple[list, str]:
        if page_name in self.cache:
            return self.cache[page_name]
        P = norm(page_name)
        if P in self.full:
            res = (self.full[P], "nome")
        else:
            by_sn = [d for d in self.deps if P == d[1] or P.startswith(d[1] + " ")]
            if by_sn:
                top = max(len(d[1]) for d in by_sn)
                by_sn = [d for d in by_sn if len(d[1]) == top]
            if len({d[0] for d in by_sn}) > 1:
                rest = set(P[top + 1:].split())

                def score(d):
                    toks = set(d[2].split())
                    if rest & toks:
                        return 2
                    return 1 if any(x in y or y in x for x in rest for y in toks) else 0
                best = max(score(d) for d in by_sn)
                by_sn = [d for d in by_sn if score(d) == best] if best else by_sn
            res = (by_sn, "cognome")
        self.cache[page_name] = res
        return res

    def match(self, page_name: str, date: str) -> tuple[str | None, bool]:
        """(id del deputato o None, ambiguo?)"""
        cands, _how = self.candidates(page_name)
        if len({c[0] for c in cands}) > 1 and date:
            in_office = [c for c in cands if (not c[3] or c[3] <= date) and (not c[4] or date <= c[4])]
            cands = in_office or cands
        if not cands:
            return None, False
        return cands[0][0], len({c[0] for c in cands}) > 1


# ---------------------------------------------------------------- algoritmo

def missions(rows) -> frozenset:
    """Nomi dei deputati in missione nella scheda."""
    return frozenset(n for n, _s, st in rows if st == "In missione")


def solve(fetch: Fetcher, votes: list[dict], use_cache: bool = True) -> tuple[list[frozenset], list[str]]:
    """Per ogni votazione della seduta: insieme dei deputati in missione e fonte (letta/dedotta)."""
    n = len(votes)
    got: dict[int, frozenset] = {}

    def S(i: int) -> frozenset:
        if i not in got:
            got[i] = missions(fetch.get(votes[i]["id"], votes[i]["url"]))
        return got[i]

    res: list[frozenset | None] = [None] * n

    def rec(i: int, j: int) -> None:
        if S(i) == S(j):
            for k in range(i, j + 1):
                res[k] = S(i)
        elif j - i <= 1:
            res[i], res[j] = S(i), S(j)
        else:
            m = (i + j) // 2
            rec(i, m)
            rec(m, j)

    rec(0, n - 1)
    if use_cache:
        # se una scheda è già stata letta (per esempio da una verifica), vale quella
        for k, v in enumerate(votes):
            if k not in got and (CACHE / f"{v['id']}.tsv").exists():
                got[k] = res[k] = missions(fetch.get(v["id"], v["url"]))
    src = ["letta" if k in got else "dedotta" for k in range(n)]
    return [r if r is not None else frozenset() for r in res], src


# ---------------------------------------------------------------- main

def main() -> None:
    ap = argparse.ArgumentParser(description="Deputati in missione dalle schede ufficiali delle votazioni")
    ap.add_argument("--pausa", type=float, default=1.0)
    ap.add_argument("--verifica", type=int, default=10)
    a = ap.parse_args()
    CACHE.mkdir(parents=True, exist_ok=True)
    for p in CACHE.glob("*.part"):
        p.unlink()

    sedute = load_votazioni()
    deps = Deputati()
    fetch = Fetcher(max(0.2, a.pausa))
    nv = sum(len(v) for v in sedute.values())
    say("Atlante XIX · missioni dalle schede delle votazioni")
    say(f"   sedute: {len(sedute)} · votazioni palesi: {nv:,}".replace(",", "."))

    t0 = time.time()
    result: dict[str, tuple[frozenset, str]] = {}
    failed = []
    keys = list(sedute)
    try:
        for k, s in enumerate(keys, 1):
            try:
                sets, src = solve(fetch, sedute[s])
                for v, ms, so in zip(sedute[s], sets, src):
                    result[v["id"]] = (ms, so)
            except FetchError as e:
                failed.append(s)
                log(f"seduta {s} non completata: {e}")
            el = time.time() - t0
            eta = el / k * (len(keys) - k) if fetch.read else 0
            sys.stdout.write(f"\r   sedute {k}/{len(keys)} · schede lette {fetch.read} · trascorso {fmt_dur(el)} · mancano ~{fmt_dur(eta)}   ")
            sys.stdout.flush()
        print()

        # verifica: alcune sedute lette per intero, sparse lungo la legislatura
        multi = [s for s in keys if len(sedute[s]) >= 8 and s not in failed]
        if len(multi) <= a.verifica:
            pick = multi
        else:
            pick = [multi[int(i * (len(multi) - 1) / max(1, a.verifica - 1))] for i in range(a.verifica)]
        ver_tot = ver_bad = 0
        if pick:
            say(f"   verifica: leggo per intero {len(pick)} sedute")
            for s in pick:
                try:
                    inferred, src = solve(fetch, sedute[s], use_cache=False)
                    actual = [missions(fetch.get(v["id"], v["url"])) for v in sedute[s]]
                except FetchError as e:
                    log(f"verifica seduta {s}: {e}")
                    continue
                for v, inf, so, act in zip(sedute[s], inferred, src, actual):
                    if so == "dedotta":
                        ver_tot += 1
                        if inf != act:
                            ver_bad += 1
                            log(f"verifica: {v['id']} dedotta diversa dalla scheda")
                    result[v["id"]] = (act, "letta")
    except KeyboardInterrupt:
        print()
        say("Interrotto. Rilancia lo stesso comando per riprendere: le schede lette restano salvate.")
        raise SystemExit(1)

    # abbinamento dei nomi e controlli sulle schede lette
    unmatched: dict[str, int] = {}
    ambiguous: dict[str, int] = {}
    rows_out = 0
    with open(OUT / "missioni.csv", "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(["votazione_id", "deputato_id", "fonte"])
        date_of = {v["id"]: v["data"] for vs in sedute.values() for v in vs}
        for vid, (ms, so) in result.items():
            d = date_of.get(vid, "")
            for nome in sorted(ms):
                did, amb = deps.match(nome, d)
                if did is None:
                    unmatched[nome] = unmatched.get(nome, 0) + 1
                    continue
                if amb:
                    ambiguous[nome] = ambiguous.get(nome, 0) + 1
                w.writerow([vid, did, so])
                rows_out += 1

    states: dict[str, int] = {}
    fca_bad = read_pages = 0
    meta = {v["id"]: v for vs in sedute.values() for v in vs}
    for p in CACHE.glob("*.tsv"):
        vid = p.stem
        with open(p, encoding="utf-8") as f:
            rows = [l.rstrip("\n").split("\t") for l in f if l.strip()]
        read_pages += 1
        c = {"Favorevole": 0, "Contrario": 0, "Astensione": 0}
        for r in rows:
            st = r[2] if len(r) > 2 else ""
            states[st] = states.get(st, 0) + 1
            if st in c:
                c[st] += 1
        m = meta.get(vid)
        if m:
            try:
                uff = (int(float(m["F"])), int(float(m["C"])), int(float(m["A"])))
                if uff != (c["Favorevole"], c["Contrario"], c["Astensione"]):
                    fca_bad += 1
                    log(f"{vid}: F/C/A della scheda diversi dai totali ufficiali")
            except (TypeError, ValueError):
                pass
    tot_states = sum(states.values()) or 1
    lines = [
        f"Sedute: {len(sedute)} · votazioni palesi: {nv:,} · con missioni assegnate: {len(result):,}",
        f"Schede lette: {read_pages:,} · dedotte: {sum(1 for x in result.values() if x[1] == 'dedotta'):,}",
        f"Verifica su {len(pick)} sedute lette per intero: {ver_tot - ver_bad}/{ver_tot} votazioni dedotte correttamente" if ver_tot else "Verifica: non eseguita",
        f"Righe in missioni.csv: {rows_out:,}",
        f"Schede con favorevoli/contrari/astenuti diversi dai totali ufficiali: {fca_bad}",
        "Stati trovati nelle schede lette: " + ", ".join(f"{k} {v / tot_states:.1%}" for k, v in sorted(states.items(), key=lambda x: -x[1])),
        "Nomi non abbinati: " + (", ".join(f"{k} ({v})" for k, v in sorted(unmatched.items())) if unmatched else "nessuno"),
        "Nomi ambigui: " + (", ".join(f"{k} ({v})" for k, v in sorted(ambiguous.items())) if ambiguous else "nessuno"),
        f"Sedute non completate: {len(failed)}" + (" (rilancia per riprovarle)" if failed else ""),
    ]
    text = "\n".join(l.replace(",", ".") if "Stati" not in l and "Nomi" not in l else l for l in lines)
    (OUT / "controllo.txt").write_text(text + "\n", encoding="utf-8")
    for l in text.splitlines():
        say("   " + l)
    say(f"Fatto in {fmt_dur(time.time() - t0)}. Mandami missioni/controllo.txt e missioni/missioni.csv.")


if __name__ == "__main__":
    main()
