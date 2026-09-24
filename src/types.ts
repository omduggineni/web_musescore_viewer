export interface ScoreIndexEntry {
  id: string;
  title: string;
  composer?: string;
}

export interface TrackMeta {
  id: string;
  name: string;
  order: number;
  file: string;
}

export interface ScoreMeta {
  id: string;
  title: string;
  composer?: string;
  tempoText?: string;
  bpm?: number;
  duration: number;
  npages: number;
  tracks: TrackMeta[];
}

export interface PositionElement {
  id: number;
  x: number;
  y: number;
  sx: number;
  sy: number;
  page: number;
}

export interface PositionEvent {
  elid: number;
  position: number; // ms
}

export interface Positions {
  elements: PositionElement[];
  events: PositionEvent[];
}

export interface TempoMapEntry {
  time: number; // sec
  bpm: number;
}

export interface BeatMapEntry {
  time: number; // sec
  downbeat: boolean;
}

export interface TrackState {
  audioEl: HTMLAudioElement | null;
  gain: GainNode | null;
  panner: StereoPannerNode | null;
  volume: number;
  pan: number;
  muted: boolean;
  solo: boolean;
}
