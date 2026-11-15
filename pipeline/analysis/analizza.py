#!/usr/bin/env python3
"""
Atlante XIX · analisi ed export per il sito

Legge pipeline/data/clean/<aula>/ (prepara.py o prepara_senato.py) e alcuni file di
pipeline/data/raw/, calcola metriche, voti contesi, accordo e mappe, e scrive i JSON del sito
in pipeline/data/final/<aula>/.

Uso, dalla cartella atlante-xix:
    python3 pipeline/analysis/analizza.py            Camera
    python3 pipeline/analysis/analizza.py senato     Senato

Richiede numpy (pip3 install numpy).

Regole (le stesse della metodologia pubblica):
- Valide per le metriche: votazioni palesi con voti individuali completi.
- Presenza al voto: voti espressi (F/C/A) sulle votazioni in carica, esclusi i turni di presidenza.
  Al Senato chi è presente senza votare conta tra chi non ha votato.
- Posizione di un gruppo: il voto più frequente tra favorevole, contrario e astenuto dei
  suoi membri presenti; in parità non è definita. Per misurare un deputato rispetto al suo
  gruppo, la posizione si calcola senza il suo voto.
- Maggioranza e opposizione, dai voti di fiducia: sostenere il Governo è votare favorevole su
  una questione di fiducia e contrario su una mozione di sfiducia (art. 115 Reg.). Un gruppo è
  di maggioranza se il voto più frequente dei suoi membri è il sostegno, di opposizione se è il
  voto opposto, "non schierato" se è l'astensione. Le componenti del Misto si classificano allo
  stesso modo; i non iscritti a una componente uno per uno.
- Contesa: la posizione dei deputati di maggioranza è diversa da quella dei deputati di
  opposizione (contati per deputati, non per gruppi).
- Accordo tra due deputati: stesso voto (F/C/A) diviso le votazioni in cui hanno votato
  entrambi. Sotto 50 votazioni in comune non è mostrato.
"""
from __future__ import annotations

import csv
import datetime as dt
import html
import json
import re
import sys
import unicodedata
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve()
AULA = sys.argv[1].lower() if len(sys.argv) > 1 else "camera"
if AULA not in ("camera", "senato"):
    sys.exit("Uso: python3 pipeline/analysis/analizza.py [camera|senato]")
DATA = HERE.parents[1] / "data"
CLEAN = DATA / "clean" / AULA
RAW = DATA / "raw" / AULA
OUT = DATA / "final" / AULA
RAW_CAMERA = DATA / "raw" / "camera"          # i membri del Governo vengono dai dati della Camera
csv.field_size_limit(10_000_000)
MIN_COMMON = 50

# ---------------------------------------------------------------- gruppi
# Gruppi canonici: più identificativi della Camera possono indicare lo stesso gruppo
# (cambi di nome). Azione–Italia Viva (gr4135) fino alla scissione del novembre 2023,
# poi Azione (gr4212, erede del gruppo) e Italia Viva (gr4211, poi gr4291).
GRUPPI_CAMERA = [
    # id, nome, sigla breve, colore, chiavi nei dati
    ("FDI", "Fratelli d'Italia", "FdI", "#1E3A6E", ["gr4133"]),
    ("LEGA", "Lega", "Lega", "#2E7D46", ["gr4132"]),
    ("FI", "Forza Italia", "FI", "#3E8ED0", ["gr4134"]),
    ("NM", "Noi Moderati", "NM", "#E08A2E", ["gr4153", "gr4234", "sigla:M-NM"]),
    ("PD", "Partito Democratico", "PD", "#D0464E", ["gr4136"]),
    ("M5S", "Movimento 5 Stelle", "M5S", "#E9BE12", ["gr4131"]),
    ("AVS", "Alleanza Verdi e Sinistra", "AVS", "#7DAF3C", ["gr4154", "sigla:M-AVS"]),
    ("AZIV", "Azione – Italia Viva", "Az–IV", "#6F5FB8", ["gr4135"]),
    ("AZ", "Azione", "Azione", "#3A4FB0", ["gr4212"]),
    ("IV", "Italia Viva", "IV", "#C2449A", ["gr4211", "gr4291"]),
    ("MIN", "Misto · Minoranze linguistiche", "Min. ling.", "#6B6A66", ["sigla:M-MIN"]),
    ("EUR", "Misto · +Europa", "+Europa", "#8E7D9E", ["sigla:M-+EUR", "sigla:M-+E-S"]),
    ("FNV", "Misto · Futuro Nazionale", "FN", "#5C4A3A", ["sigla:M-FNVF"]),
    ("SCN", "Misto · Sud chiama Nord", "SCN", "#9A8C6E", ["sigla:M-SCN"]),
    ("ALT", "Misto · non iscritti a componenti", "Misto", "#A39E93", ["sigla:M-ALT"]),
]
# Senato: le chiavi sono "gr<id>:<inizio della denominazione>" (prepara_senato.py); una chiave
# senza data vale per tutte le denominazioni del gruppo. Azione–Italia Viva (gruppo 91) diventa
# Italia Viva il 9 novembre 2023: i senatori di Azione passano al Misto. Il Misto del Senato non
# ha componenti nei dati aperti: come i non iscritti della Camera, ogni senatore conta da solo
# (identificativo "ALT", lo stesso usato dal sito per chi si classifica uno per uno).
GRUPPI_SENATO = [
    ("FDI", "Fratelli d'Italia", "FdI", "#1E3A6E", ["gr85"]),
    ("LEGA", "Lega – Partito Sardo d'Azione", "Lega", "#2E7D46", ["gr33"]),
    ("FI", "Forza Italia", "FI", "#3E8ED0", ["gr56"]),
    ("CDI", "Civici d'Italia – Noi Moderati – MAIE", "Cd'I–NM", "#E08A2E", ["gr92"]),
    ("PD", "Partito Democratico", "PD", "#D0464E", ["gr49"]),
    ("M5S", "Movimento 5 Stelle", "M5S", "#E9BE12", ["gr71"]),
    ("AZIV", "Azione – Italia Viva", "Az–IV", "#6F5FB8", ["gr91:20221013"]),
    ("IV", "Italia Viva", "IV", "#C2449A", ["gr91"]),
    ("AUT", "Per le Autonomie", "Aut.", "#6B6A66", ["gr69"]),
    ("ALT", "Misto", "Misto", "#A39E93", ["gr9"]),
]
GRUPPI = GRUPPI_CAMERA if AULA == "camera" else GRUPPI_SENATO
PLACEHOLDER = "gr9999"
MISTO_IDS = {"MIN", "EUR", "FNV", "SCN", "ALT"} if AULA == "camera" else {"ALT"}
VERT_REF = "AZ" if AULA == "camera" else "IV"   # gruppo che fissa il verso dell'asse verticale della mappa
PRESIDENTE = "Presidente della Camera" if AULA == "camera" else "Presidente del Senato"
FONTE = "Camera dei Deputati — dati.camera.it (CC BY)" if AULA == "camera" else "Senato della Repubblica — dati.senato.it (CC BY)"
MESI = ["gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno", "luglio", "agosto",
        "settembre", "ottobre", "novembre", "dicembre"]


def last(u: str) -> str:
    return u.rsplit("/", 1)[-1]


def plain_name(s: str) -> str:
    """per confrontare i nomi: maiuscolo, senza accenti, apostrofi e spazi"""
    s = unicodedata.normalize("NFKD", s or "")
    return re.sub(r"[^A-Z]", "", "".join(c for c in s if not unicodedata.combining(c)).upper())


# Membri del Governo che i dati della Camera chiamano diversamente dal Senato: cognome|nome
NOMI_GOVERNO = {"MUSUMECI|SEBASTIANO": "MUSUMECI|NELLO"}


def same_person(gov_surname: str, gov_first: str, surname: str, first: str) -> bool:
    """stesso nome e cognomi compatibili ("ALBERTI" alla Camera, "Alberti Casellati" al Senato)"""
    key = NOMI_GOVERNO.get(plain_name(gov_surname) + "|" + plain_name(gov_first))
    if key:
        return key == plain_name(surname) + "|" + plain_name(first)
    if plain_name(gov_first) != plain_name(first):
        return False
    a = {plain_name(w) for w in re.split(r"[\s-]+", gov_surname) if plain_name(w)}
    b = {plain_name(w) for w in re.split(r"[\s-]+", surname) if plain_name(w)}
    return bool(a) and bool(b) and (a <= b or b <= a)


def num(x, default=None):
    try:
        return int(float(x))
    except (TypeError, ValueError):
        return default


# ---------------------------------------------------------------- MDS

def classical_mds(D: np.ndarray) -> np.ndarray:
    n = len(D)
    J = np.eye(n) - 1 / n
    B = -0.5 * J @ (D ** 2) @ J
    w, v = np.linalg.eigh(B)
    idx = np.argsort(w)[::-1][:2]
    return v[:, idx] * np.sqrt(np.maximum(w[idx], 1e-12))


def smacof(D: np.ndarray, W: np.ndarray, X0: np.ndarray, iters: int = 300) -> np.ndarray:
    V = -W.copy()
    np.fill_diagonal(V, W.sum(1))
    Vp = np.linalg.pinv(V)
    Y = X0 - X0.mean(0)
    prev = np.inf
    for _ in range(iters):
        d = np.sqrt(((Y[:, None] - Y[None]) ** 2).sum(-1))
        d[d == 0] = 1e-9
        B = -W * D / d
        np.fill_diagonal(B, 0)
        np.fill_diagonal(B, -B.sum(1))
        Y = Vp @ B @ Y
        d = np.sqrt(((Y[:, None] - Y[None]) ** 2).sum(-1))
        s = (W * (D - d) ** 2).sum()
        if prev - s < 1e-7 * prev:
            break
        prev = s
    return Y


def procrustes(Y: np.ndarray, ref: np.ndarray) -> np.ndarray:
    """Ruota, scala e trasla Y sul riferimento (solo righe senza NaN in entrambi)."""
    ok = np.isfinite(Y).all(1) & np.isfinite(ref).all(1)
    if ok.sum() < 3:
        return Y
    a, b = Y[ok], ref[ok]
    ma, mb = a.mean(0), b.mean(0)
    a0, b0 = a - ma, b - mb
    U, S, Vt = np.linalg.svd(a0.T @ b0)
    R = U @ Vt
    sc = S.sum() / (a0 ** 2).sum()
    return (Y - ma) @ R * sc + mb


# ---------------------------------------------------------------- caricamento

def load():
    vz = list(csv.DictReader(open(CLEAN / "votazioni.csv", encoding="utf-8", newline="")))
    deps = list(csv.DictReader(open(CLEAN / "deputati.csv", encoding="utf-8", newline="")))
    codes = list(csv.DictReader(open(CLEAN / "codici_gruppi.csv", encoding="utf-8", newline="")))
    Mv, Mg = [], []
    with open(CLEAN / "matrice_voti.txt", encoding="utf-8") as f:
        for line in f:
            Mv.append(np.frombuffer(line.rstrip("\n").split("\t")[1].encode(), dtype=np.uint8))
    with open(CLEAN / "matrice_gruppi.txt", encoding="utf-8") as f:
        for line in f:
            Mg.append(np.frombuffer(line.rstrip("\n").split("\t")[1].encode(), dtype=np.uint8))
    return vz, deps, codes, np.vstack(Mv), np.vstack(Mg)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "votes").mkdir(exist_ok=True)
    (OUT / "deputati").mkdir(exist_ok=True)
    vz, deps, codes, M, Gm = load()
    V, N = M.shape
    print(f"Votazioni {V:,} · deputati {N}")
    c = ord

    # ---- gruppi canonici per deputato e votazione
    gid = [g[0] for g in GRUPPI]
    gi = {g: i for i, g in enumerate(gid)}
    key2g = {k: g[0] for g in GRUPPI for k in g[4]}
    lut = np.full(256, -1, np.int16)
    placeholder_ch = None
    unknown_keys = []
    for r in codes:
        k = r["gruppo_id"]
        if k == PLACEHOLDER:
            placeholder_ch = ord(r["carattere"])
        elif k in key2g or k.split(":")[0] in key2g:
            lut[ord(r["carattere"])] = gi[key2g.get(k) or key2g[k.split(":")[0]]]
        else:
            unknown_keys.append(k)
    if unknown_keys:
        print("ATTENZIONE: gruppi non mappati:", unknown_keys)
    GC = lut[Gm].astype(np.int16)
    # gr4135 dopo la scissione non dovrebbe comparire; se compare è Azione
    # segnaposto "------": il gruppo più vicino nel tempo per lo stesso deputato
    if placeholder_ch is not None:
        for j in np.where((Gm == placeholder_ch).any(0))[0]:
            col = GC[:, j]
            known = np.where(col >= 0)[0]
            for v in np.where(Gm[:, j] == placeholder_ch)[0]:
                if len(known):
                    col[v] = col[known[np.abs(known - v).argmin()]]
    # ---- codici voto
    X = np.zeros((V, N), np.int8)
    for k, ch in ((1, "F"), (2, "C"), (3, "A")):
        X[M == c(ch)] = k
    stato = np.array([r["stato_voti"] for r in vz])
    valid = np.isin(stato, ["completi", "corretti"])
    X[~valid] = 0
    PRES = (M == c("P")) & valid[:, None]
    NP = np.isin(M, [c("N"), c("V")]) & valid[:, None]        # V: al Senato, presente non votante
    MIS = (M == c("M")) & valid[:, None]
    INOFF = np.isin(M, [c(x) for x in "FCANMV"]) & valid[:, None]    # contano per la presenza
    dates = np.array([r["data"] for r in vz])
    months = sorted({d[:6] for d in dates})
    mi = np.array([months.index(d[:6]) for d in dates])
    NM_ = len(months)

    # ---- maggioranza e opposizione dalle fiducie
    tipo = np.array([r["tipo"] for r in vz])
    fid = np.where((np.array([r["fiducia"] for r in vz]) == "1") & valid)[0]
    # mozioni di sfiducia (art. 115, comma 3): sostegno = contrario.
    # La mozione di fiducia iniziale al Governo è anch'essa una mozione, ma si sostiene col sì.
    if "sfiducia" in vz[0]:
        sfid = np.array([r["sfiducia"] == "1" for r in vz])     # Senato: dal testo della votazione
    else:
        sfid = np.array([tipo[v] == "Mozione" and "mozione di fiducia" not in (vz[v].get("descrizione") or "").lower() for v in range(V)])
    gov = np.where(sfid[fid], 2, 1)
    sup = X[fid] == gov[:, None]
    opp = X[fid] == (3 - gov)[:, None]
    abst = X[fid] == 3

    def side_of(m) -> int:
        s, o, a = int((sup & m).sum()), int((opp & m).sum()), int((abst & m).sum())
        if s > max(o, a):
            return 1
        if o > max(s, a):
            return 2
        return 0                                              # prevale l'astensione, o nessun voto
    side_g = {g: side_of(GC[fid] == i) for g, i in gi.items() if g != "ALT"}
    side_d = np.zeros(N, np.int8)                             # per i non iscritti, deputato per deputato
    for j in range(N):
        m = np.zeros_like(sup)
        m[:, j] = GC[fid, j] == gi["ALT"]
        side_d[j] = side_of(m)
    SIDE = np.zeros((V, N), np.int8)
    for g, s in side_g.items():
        SIDE[GC == gi[g]] = s
    alt = GC == gi["ALT"]
    SIDE[alt] = np.broadcast_to(side_d, (V, N))[alt]
    print("Lati:", {g: s for g, s in side_g.items() if s})

    # ---- posizioni dei gruppi e della maggioranza/opposizione
    def counts(mask):
        return np.stack([((X == k) & mask).sum(1) for k in (1, 2, 3)], 1)

    def pos_from(cnt):
        mx = cnt.max(-1)
        top = cnt.argmax(-1) + 1
        tie = (cnt == mx[..., None]).sum(-1) > 1
        return np.where((mx == 0) | tie, 0, top).astype(np.int8)

    G = len(gid)
    GCNT = np.zeros((V, G, 3), np.int32)
    for i in range(G):
        GCNT[:, i] = counts(GC == i)
    GPOS = pos_from(GCNT)
    pm, po = pos_from(counts(SIDE == 1)), pos_from(counts(SIDE == 2))
    contested = (pm > 0) & (po > 0) & (pm != po) & valid
    print(f"Contese: {contested.sum():,} su {valid.sum():,} valide ({contested.sum() / valid.sum():.1%})")

    # posizione del proprio gruppo senza il voto del deputato
    rowsV = np.arange(V)
    own = np.zeros((V, N), np.int8)
    for j in range(N):
        g = GC[:, j]
        okg = g >= 0
        cnt = np.zeros((V, 3), np.int32)
        cnt[okg] = GCNT[rowsV[okg], g[okg]]
        k = X[:, j]
        for kk in (1, 2, 3):
            cnt[k == kk, kk - 1] -= 1
        own[:, j] = np.where(okg, pos_from(cnt), 0)
    party = np.isin(GC, [gi[g] for g in gid if g not in MISTO_IDS])
    VOTED = X > 0
    DIS_BASE = VOTED & party & (own > 0)
    DISS = DIS_BASE & (X != own)
    other_pos = np.where(SIDE == 1, po[:, None], np.where(SIDE == 2, pm[:, None], 0))
    CROSS_BASE = VOTED & contested[:, None] & (other_pos > 0)
    CROSS = CROSS_BASE & (X == other_pos)

    # ---- metriche per deputato (totali e mensili)
    def monthly(A):
        out = np.zeros((NM_, N), np.int32)
        np.add.at(out, mi, A.astype(np.int32))
        return out
    mT, mV_, mN, mM = monthly(INOFF), monthly(VOTED), monthly(NP), monthly(MIS)
    mDB, mD, mCB, mC = monthly(DIS_BASE), monthly(DISS), monthly(CROSS_BASE), monthly(CROSS)
    T, Vt, Nn, Mm = mT.sum(0), mV_.sum(0), mN.sum(0), mM.sum(0)
    DB, Dd, CB, Cc = mDB.sum(0), mD.sum(0), mCB.sum(0), mC.sum(0)
    Pp = PRES.sum(0)

    def ratio(a, b, lim=30):
        return [round(float(x) / float(y), 4) if y >= lim else None for x, y in zip(a, b)]

    # ---- deputati: anagrafica, ruoli, gruppi
    did = [d["deputato_id"] for d in deps]
    dnum = [re.sub(r"\D", "", x.split("_")[0]) for x in did]
    gov_roles = defaultdict(list)
    gfile = RAW_CAMERA / "esplora" / "membri_governo_via_governo.csv"
    if gfile.exists():
        mg = defaultdict(dict)
        for r in csv.DictReader(open(gfile, encoding="utf-8", newline="")):
            mg[r["m"]][last(r["p"]).split("#")[-1]] = r["o"]
        # alla Camera si collega per persona; al Senato per cognome e nome
        for m in mg.values():
            if AULA == "camera":
                pn = re.sub(r"\D", "", last(m.get("rif_persona", "")))
            else:
                hit = [dnum[j] for j, d in enumerate(deps)
                       if same_person(m.get("surname", ""), m.get("firstName", ""), d.get("cognome", ""), d.get("nome", ""))]
                if len(hit) != 1:
                    continue
                pn = hit[0]
            label = re.sub(r"\s*\(.*\)\s*$", "", m.get("label", ""))
            role = {"ruolo": label, "da": m.get("startDate", ""), "a": m.get("endDate", "")}
            if role not in gov_roles[pn]:
                gov_roles[pn].append(role)
    president = int(np.argmax(Pp - 1000 * Vt))          # presiede e non vota mai
    if Pp[president] == 0:
        president = int(np.argmax(Pp))

    # cambi di gruppo dai voti (gruppo canonico nel tempo)
    def timeline(j):
        col = GC[:, j]
        seq = []
        for v in np.where(col >= 0)[0]:
            g = int(col[v])
            if not seq or seq[-1][0] != g:
                seq.append([g, v, v])
            else:
                seq[-1][2] = v
        return seq

    def change_kind(a: str, b: str, date: str) -> str | None:
        if a == b:
            return None
        if date <= "20221115":
            return "costituzione"            # Misto → gruppo nei primi giorni della legislatura
        if AULA == "camera" and a == "AZIV" and b == "AZ":
            return None                      # Azione eredita il gruppo
        if AULA == "camera" and a == "AZIV" and b == "IV":
            return "scissione"
        if AULA == "senato" and a == "AZIV" and b == "IV":
            return None                      # al Senato è Italia Viva a ereditare il gruppo
        if AULA == "senato" and a == "AZIV" and b == "ALT" and "20231101" <= date <= "20231130":
            return "scissione"               # i senatori di Azione passano al Misto
        if a in MISTO_IDS and b in MISTO_IDS:
            return "componente"              # cambio di componente dentro il Misto
        return "individuale"

    tl = [timeline(j) for j in range(N)]
    changes = []
    for j in range(N):
        ch = []
        for (g1, _a1, _b1), (g2, a2, _b2) in zip(tl[j], tl[j][1:]):
            k = change_kind(gid[g1], gid[g2], dates[a2])
            if k:
                ch.append({"da": gid[g1], "a": gid[g2], "data": dates[a2], "tipo": k})
        changes.append(ch)

    # ---- accordo tra deputati
    def agreement(rows):
        Xs = X[rows]
        P = (Xs > 0).astype(np.float32)
        same = sum(((Xs == k).astype(np.float32)).T @ ((Xs == k).astype(np.float32)) for k in (1, 2, 3))
        return same, P.T @ P
    sameC, bothC = agreement(contested)
    sameA, bothA = agreement(valid)

    # ---- mappe
    def make_map(rows, ref=None, min_votes=MIN_COMMON):
        same, both = agreement(rows)
        act = np.where(np.diag(both) >= min_votes)[0]
        if len(act) < 10:
            return None
        S, B = same[np.ix_(act, act)].astype(np.float64), both[np.ix_(act, act)].astype(np.float64)
        A = np.where(B > 0, S / np.maximum(B, 1), np.nan)
        D = np.nan_to_num(1 - A, nan=0.0)
        W = np.where(B >= min_votes, np.minimum(B, 400) / 400, 0.0)
        np.fill_diagonal(W, 0)
        Di = np.where(np.isfinite(A), 1 - A, np.nanmean(1 - A))
        np.fill_diagonal(Di, 0)
        Y = smacof(D, W, classical_mds(Di))
        full = np.full((N, 2), np.nan)
        full[act] = Y
        if ref is not None:
            full = procrustes(full, ref)
        return full

    print("Mappa complessiva…")
    Yall = make_map(contested)
    lastg = np.array([tl[j][-1][0] if tl[j] else -1 for j in range(N)])
    maj = np.isin(lastg, [gi[g] for g, s in side_g.items() if s == 1])
    ok = np.isfinite(Yall).all(1)
    if Yall[maj & ok, 0].mean() < Yall[~maj & ok, 0].mean():
        Yall[:, 0] *= -1                    # maggioranza a destra, come nell'emiciclo
    if np.nanmean(Yall[lastg == gi[VERT_REF], 1]) > 0:
        Yall[:, 1] *= -1                    # orientamento verticale fissato e dichiarato
    years = {}
    for y in sorted({d[:4] for d in dates}):
        rows = contested & (np.char.startswith(dates, y) if y != "2022" else np.char.startswith(dates, "2022"))
        if y == "2022":
            continue
        if y == "2023":
            rows = contested & ((np.char.startswith(dates, "2022")) | (np.char.startswith(dates, "2023")))
        print(f"Mappa {y}…")
        years[y if y != "2023" else "2022-23"] = make_map(rows, ref=Yall)
    frames = []
    for k in range(NM_):
        lo, hi = max(0, k - 1), min(NM_ - 1, k + 1)
        rows = contested & (mi >= lo) & (mi <= hi)
        Yk = make_map(rows, ref=Yall, min_votes=25)
        frames.append(Yk)
    print(f"Mappe mensili: {sum(f is not None for f in frames)}")
    # normalizzazione comune in [0,1] (stessa scala per x e y)
    allpts = np.vstack([Yall] + [y for y in years.values() if y is not None] + [f for f in frames if f is not None])
    allpts = allpts[np.isfinite(allpts).all(1)]
    lo, hi = np.percentile(allpts, 0.5, 0), np.percentile(allpts, 99.5, 0)
    scale = 0.9 / max(hi - lo)
    center = (lo + hi) / 2

    def norm(Y):
        if Y is None:
            return None
        Z = (Y - center) * scale + 0.5
        return [[round(float(a), 4), round(float(b), 4)] if np.isfinite(a) and np.isfinite(b) else None for a, b in Z]

    # ---- votazioni: indice
    gpos_s = ["".join(".FCA"[p] for p in row) for row in GPOS]
    titles, acts = [], []
    for r in vz:
        t = re.sub(r"^Votazione\s+(?=[A-Z])", "", r["titolo"]).strip()
        if t in ("", "Votazione"):
            t = r["tipo"] or "Votazione"
        titles.append(t)
        acts.append(" ".join(last(a).replace("ac19_", "") for a in r["atto"].split()) if r.get("atto") else "")
    TYPES = sorted({t for t in tipo})
    tcode = {t: i for i, t in enumerate(TYPES)}
    margin = []
    for r in vz:
        F, C = num(r["favorevoli"], 0), num(r["contrari"], 0)
        margin.append(round(abs(F - C) / (F + C), 3) if F + C else 0)
    dis_count = DISS.sum(1)
    votes_index = {
        "campi": ["id", "data", "tipo", "titolo", "atto", "flag", "F", "C", "A", "presenti", "esito",
                  "margine", "contesa", "gruppi", "dissensi", "stato"],
        "tipi": TYPES,
        "gruppi": gid,
        "righe": [],
    }
    for v, r in enumerate(vz):
        flag = (1 if r["finale"] == "1" else 0) | (2 if r["fiducia"] == "1" else 0) | (4 if r["segreta"] == "1" else 0) | (8 if sfid[v] else 0)
        votes_index["righe"].append([
            r["id"], r["data"], tcode[tipo[v]], titles[v], acts[v], flag,
            num(r["favorevoli"], 0), num(r["contrari"], 0), num(r["astenuti"], 0), num(r["presenti"], 0),
            1 if r["approvato"] == "1" else 0, margin[v], int(contested[v]), gpos_s[v], int(dis_count[v]),
            {"completi": 0, "corretti": 0, "incompleti": 1, "segreta": 2}[stato[v]],
        ])
    # descrizioni (atto e oggetto) a parte: servono solo nella scheda votazione
    descr = {r["id"]: re.sub(r"&amp;", "&", r["descrizione"]) for r in vz}

    # ---- atti: titolo dalla votazione finale (o dalla fiducia), per cercare per tema nella barra comandi
    def plain(t):
        return html.unescape(html.unescape(re.sub(r"\s+", " ", t or ""))).strip()
    atti = {}
    for v, r in enumerate(vz):
        for a in acts[v].split():
            e = atti.setdefault(a, {"n": 0, "d": r["data"], "t": "", "rank": 9, "fin": ""})
            e["n"] += 1
            e["d"] = max(e["d"], r["data"])
            rank = 0 if r["finale"] == "1" else 1 if r["fiducia"] == "1" else 2 if tipo[v] in ("Questione pregiudiziale", "Articolo unico") else 9
            if rank < e["rank"] and len(plain(r["descrizione"])) > 25:
                e.update(rank=rank, t=plain(r["descrizione"]))
            if r["finale"] == "1":
                e["fin"] = r["id"]
    atti_json = {"campi": ["atto", "titolo", "votazioni", "ultima", "finale"],
                 "righe": [[a, e["t"], e["n"], e["d"], e["fin"]] for a, e in sorted(atti.items(), key=lambda x: x[1]["d"]) if e["t"]]}
    (OUT / "atti.json").write_text(json.dumps(atti_json, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"Atti con titolo: {len(atti_json['righe'])} su {len(atti)}")

    # ---- votazioni: matrici mensili
    for k, m in enumerate(months):
        rows = np.where(mi == k)[0]
        data = {"mese": m, "ids": [vz[v]["id"] for v in rows],
                "voti": [M[v].tobytes().decode() for v in rows],
                "descrizioni": [descr[vz[v]["id"]] for v in rows],
                "schede": [vz[v]["scheda"] for v in rows],
                # totali ufficiali: al Senato gli astenuti sono tra i votanti; alcune votazioni chiedono
                # la maggioranza assoluta dei componenti
                "votanti": [num(vz[v]["votanti"]) for v in rows],
                "maggioranze": [num(vz[v]["maggioranza"]) for v in rows]}
        if "ddl" in vz[0]:
            data["ddl"] = [vz[v]["ddl"] for v in rows]          # Senato: schede dei disegni di legge
        (OUT / "votes" / f"{m[:4]}-{m[4:]}.json").write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    # ---- deputati
    pres = ratio(Vt, T)
    dis = ratio(Dd, DB)
    crs = ratio(Cc, CB)
    def elezione(d):
        if "circoscrizione" in d:                                       # Senato
            return {"tipo": d.get("tipo_elezione", ""), "circoscrizione": d["circoscrizione"],
                    "collegio": d.get("collegio", ""), "lista": d.get("lista", "")}
        return {"tipo": d.get("tipo_elezione", ""), "circoscrizione": d.get("collegio", "").split(" - ")[0].strip(),
                "collegio": (d.get("collegio", "").split(" - ") + [""])[1].strip(), "lista": d.get("lista", "")}

    deputies = []
    for j, d in enumerate(deps):
        roles = list(gov_roles.get(dnum[j], []))
        if j == president:
            roles.insert(0, {"ruolo": PRESIDENTE, "da": d.get("inizio_mandato", ""), "a": ""})
        hist = [{"g": gid[g], "da": dates[a], "a": dates[b]} for g, a, b in tl[j]]
        deputies.append({
            "i": j, "id": dnum[j], "cognome": d.get("cognome", "").title(), "nome": d.get("nome", "").title(),
            "genere": d.get("genere", ""), "mandato": [d.get("inizio_mandato", ""), d.get("fine_mandato", "")],
            "elezione": elezione(d),
            "gruppi": hist, "gruppo": gid[lastg[j]] if lastg[j] >= 0 else None,
            "lato": int(side_g.get(gid[lastg[j]], side_d[j]) if lastg[j] >= 0 and gid[lastg[j]] != "ALT" else side_d[j]),
            "ruoli": roles, "cambi": changes[j],
            "m": {"votazioni": int(T[j]), "votati": int(Vt[j]), "nonpart": int(Nn[j]), "missioni": int(Mm[j]),
                  "presiede": int(Pp[j]), "presenza": pres[j], "dissenso": dis[j], "trasv": crs[j],
                  "dissensi": int(Dd[j]), "base_diss": int(DB[j]), "trasv_n": int(Cc[j]), "base_trasv": int(CB[j])},
            "xy": norm(Yall[j:j + 1])[0],
        })

    # ---- file per deputato
    for j, d in enumerate(deputies):
        own_g = GC[:, j]
        voted = X[:, j] > 0
        ag = {}
        for base, rows in (("contese", contested), ("tutte", valid)):
            tot, mon = {}, {}
            for i, g in enumerate(gid):
                pos = np.where(own_g == i, own[:, j], GPOS[:, i])
                m = rows & voted & (pos > 0)
                n = int(m.sum())
                if n < MIN_COMMON:
                    continue
                e = m & (X[:, j] == pos)
                tot[g] = [round(int(e.sum()) / n, 4), n]
                mm_ = np.bincount(mi[m], minlength=NM_)
                me = np.bincount(mi[e], minlength=NM_)
                mon[g] = [round(int(a) / int(b), 3) if b >= 8 else None for a, b in zip(me, mm_)]
            ag[base] = {"totale": tot, "mensile": mon}
        simC = [round(float(sameC[j, k] / bothC[j, k]), 3) if bothC[j, k] >= MIN_COMMON else None for k in range(N)]
        simA = [round(float(sameA[j, k] / bothA[j, k]), 3) if bothA[j, k] >= MIN_COMMON else None for k in range(N)]
        nC = [int(x) for x in bothC[j]]
        my = lastg[j]
        near = sorted([(simC[k], k) for k in range(N) if k != j and simC[k] is not None and lastg[k] != my and lastg[k] >= 0],
                      reverse=True)[:3]
        notable = [vz[v]["id"] for v in np.where(DISS[:, j] & ((np.array([r["finale"] for r in vz]) == "1") | (np.array([r["fiducia"] for r in vz]) == "1")))[0]]
        traj = [norm(f[j:j + 1])[0] if f is not None else None for f in frames]
        out = {
            "id": d["id"], "barcode": M[:, j].tobytes().decode(),
            "mensile": {"votazioni": mT[:, j].tolist(), "votati": mV_[:, j].tolist(), "nonpart": mN[:, j].tolist(),
                        "missioni": mM[:, j].tolist(), "base_diss": mDB[:, j].tolist(), "dissensi": mD[:, j].tolist()},
            "accordo_gruppi": ag,
            "accordo_deputati": {"contese": simC, "tutte": simA, "comuni_contese": nC},
            "vicini": [{"i": k, "accordo": s, "comuni": int(bothC[j, k])} for s, k in near],
            "voti_notevoli": notable,
            "traiettoria": traj,
        }
        (OUT / "deputati" / f"{d['id']}.json").write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    # ---- mappa, gruppi, intro, meta
    (OUT / "map.json").write_text(json.dumps({
        "complessiva": norm(Yall),
        "anni": {k: norm(v) for k, v in years.items()},
        "mesi": months, "mensili": [norm(f) for f in frames],
    }, separators=(",", ":")), encoding="utf-8")
    groups_json = []
    for g in GRUPPI:
        members_now = int(((lastg == gi[g[0]]) & np.array([not d["mandato"][1] for d in deputies])).sum())
        groups_json.append({"id": g[0], "nome": g[1], "sigla": g[2], "colore": g[3],
                            "lato": side_g.get(g[0], 0), "misto": g[0] in MISTO_IDS, "membri_oggi": members_now})
    (OUT / "groups.json").write_text(json.dumps(groups_json, ensure_ascii=False, indent=1), encoding="utf-8")
    (OUT / "deputies.json").write_text(json.dumps(deputies, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    (OUT / "votes_index.json").write_text(json.dumps(votes_index, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    bil = [v for v, r in enumerate(vz) if r["finale"] == "1" and "bilancio di previsione dello stato" in r["descrizione"].lower()
           and valid[v]]
    intro_v = bil[-1] if bil else int(np.where(valid & (np.array([r["finale"] for r in vz]) == "1"))[0][-1])
    (OUT / "intro.json").write_text(json.dumps({
        "voto": vz[intro_v]["id"], "data": vz[intro_v]["data"], "descrizione": descr[vz[intro_v]["id"]],
        "regola": "Voto finale sull'ultima legge di bilancio approvata",
    }, ensure_ascii=False, indent=1), encoding="utf-8")

    mm = {"votazioni": mT, "votati": mV_, "nonpart": mN, "missioni": mM,
          "base_diss": mDB, "dissensi": mD, "base_trasv": mCB, "trasv": mC}
    (OUT / "metriche_mensili.json").write_text(json.dumps(
        {"mesi": months, **{k: v.T.tolist() for k, v in mm.items()}}, separators=(",", ":")), encoding="utf-8")

    # ordine dei gruppi nell'emiciclo: posizione media dei loro membri sull'asse principale della mappa
    gx = {}
    for i, g in enumerate(gid):
        xs = [Yall[j, 0] for j in range(N) if any(t[0] == i for t in tl[j]) and np.isfinite(Yall[j, 0])]
        gx[g] = float(np.mean(xs)) if xs else 0.0
    order = sorted(gid, key=lambda g: gx[g])
    for gj in groups_json:
        gj["ordine"] = order.index(gj["id"])
    (OUT / "groups.json").write_text(json.dumps(groups_json, ensure_ascii=False, indent=1), encoding="utf-8")

    n_changes = Counter(ch["tipo"] for cs in changes for ch in cs)
    meta = {
        "aggiornato": max(dates), "generato": dt.date.today().isoformat(),
        "votazioni": V, "valide": int(valid.sum()), "contese": int(contested.sum()),
        "segrete": int((stato == "segreta").sum()), "incomplete": int((stato == "incompleti").sum()),
        "incomplete_ids": [vz[v]["id"] for v in np.where(stato == "incompleti")[0]],
        "deputati": N, "mesi": months, "cambi": dict(n_changes),
        "finali": int((np.array([r["finale"] for r in vz]) == "1").sum()),
        "fiducie": int((np.array([r["fiducia"] for r in vz]) == "1").sum()),
        "sedute": len({re.split(r"[_-]", r["id"])[1] for r in vz}),
        "pesi": {f: (OUT / f).stat().st_size for f in
                 ["groups.json", "deputies.json", "map.json", "votes_index.json", "intro.json"]},
        "fonte": FONTE,
    }
    (OUT / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")

    # ---- riepilogo
    print("\nRiepilogo")
    print(f"  valide {valid.sum():,} · contese {contested.sum():,} · segrete {meta['segrete']} · incomplete {meta['incomplete']}")
    print(f"  cambi di gruppo: {dict(n_changes)}")
    print(f"  {PRESIDENTE} (dai dati): {deps[president]['cognome']} {deps[president]['nome']}")
    print(f"  membri del Governo trovati: {sum(1 for j in range(N) if gov_roles.get(dnum[j]))}")
    print(f"  voto dell'intro: {vz[intro_v]['id']} del {vz[intro_v]['data']}")
    size = sum(p.stat().st_size for p in OUT.rglob("*.json"))
    print(f"  file scritti in {OUT} · {size / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
