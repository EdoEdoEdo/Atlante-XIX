// Tipi dei dati prodotti da pipeline/analysis/analizza.py

export type RGB = [number, number, number];
export type XY = [number, number] | null;

export interface Meta {
  aggiornato: string;
  generato: string;
  votazioni: number;
  valide: number;
  contese: number;
  segrete: number;
  incomplete: number;
  incomplete_ids: string[];
  deputati: number;
  mesi: string[];
  cambi: Record<string, number>;
  finali: number;
  fiducie: number;
  sedute: number;
  pesi: Record<string, number>;
  fonte: string;
}

export interface Group {
  id: string;
  nome: string;
  sigla: string;
  colore: string;
  lato: number; // 1 maggioranza · 2 opposizione · 0 non schierato
  misto: boolean;
  membri_oggi: number;
  ordine: number;
  rgb: RGB;
  k: number;
}

export interface Change {
  da: string;
  a: string;
  data: string;
  tipo: "individuale" | "scissione" | "componente" | string;
}

export interface Role {
  ruolo: string;
  da: string;
  a: string;
}

export interface DeputyMetrics {
  votazioni: number;
  votati: number;
  nonpart: number;
  missioni: number;
  presiede: number;
  presenza: number | null;
  dissenso: number | null;
  trasv: number | null;
  dissensi: number;
  base_diss: number;
  trasv_n: number;
  base_trasv: number;
}

export interface Deputy {
  i: number;
  id: string;
  cognome: string;
  nome: string;
  genere: string;
  mandato: [string, string];
  elezione: { tipo: string; circoscrizione: string; collegio: string; lista: string };
  gruppi: { g: string; da: string; a: string }[];
  gruppo: string | null;
  lato: number;
  ruoli: Role[];
  cambi: Change[];
  m: DeputyMetrics;
  xy: XY;
  // derivati nel browser
  name: string;
  nz: string;
  gov: boolean;
  president: boolean;
}

export interface Vote {
  i: number;
  id: string;
  data: string;
  tipo: string;
  titolo: string;
  atto: string;
  flag: number; // 1 finale · 2 fiducia · 4 segreta
  F: number;
  C: number;
  A: number;
  presenti: number;
  esito: number;
  margine: number;
  contesa: number;
  gruppi: string; // posizione di ogni gruppo, nell'ordine di votes_index.gruppi: . F C A
  dissensi: number;
  stato: number; // 0 completi · 1 incompleti · 2 segreta
  seduta: number;
  n: number;
  t: number;
  day: number;
}

export interface Day {
  i: number;
  data: string;
  v0: number;
  v1: number;
  seduta: number;
  t: number;
}

export interface MapData {
  complessiva: XY[];
  anni: Record<string, XY[] | null>;
  mesi: string[];
  mensili: (XY[] | null)[];
}

export interface MonthFile {
  mese: string;
  ids: string[];
  voti: string[];
  descrizioni: string[];
  schede: string[];
  /** totali ufficiali (null se mancano) */
  votanti?: (number | null)[];
  maggioranze?: (number | null)[];
  /** Senato: identificativi dei disegni di legge di ogni votazione (separati da spazio) */
  ddl?: string[];
}

export interface AgreementBlock {
  totale: Record<string, [number, number]>;
  mensile: Record<string, (number | null)[]>;
}

export interface DeputyFile {
  id: string;
  barcode: string;
  mensile: Record<string, number[]>;
  accordo_gruppi: { contese: AgreementBlock; tutte: AgreementBlock };
  accordo_deputati: { contese: (number | null)[]; tutte: (number | null)[]; comuni_contese: number[] };
  vicini: { i: number; accordo: number; comuni: number }[];
  voti_notevoli: string[];
  traiettoria: XY[];
}

export interface MonthlyMetrics {
  mesi: string[];
  votazioni: number[][];
  votati: number[][];
  nonpart: number[][];
  missioni: number[][];
  base_diss: number[][];
  dissensi: number[][];
  base_trasv: number[][];
  trasv: number[][];
}

export interface Intro {
  voto: string;
  data: string;
  descrizione: string;
  regola: string;
}
