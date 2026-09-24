import { Channel } from './Channel';
import { XIcon } from './icons';
import type { TrackUiState } from '../hooks/useScorePlayer';

interface MixerProps {
  open: boolean;
  tracks: TrackUiState[];
  onClose: () => void;
  onVolumeInput: (id: string, volume: number) => void;
  onPanInput: (id: string, pan: number) => void;
  onToggleMute: (id: string) => void;
  onToggleSolo: (id: string) => void;
}

// Never conditionally unmounted - `hidden` is a plain attribute here
// (matches src/app.js's `els.mixer.hidden = !open`), since #mixer has no
// author `display` override to fight, unlike #rightControls below.
export function Mixer({ open, tracks, onClose, onVolumeInput, onPanInput, onToggleMute, onToggleSolo }: MixerProps) {
  return (
    <aside id="mixer" hidden={!open}>
      <div id="mixerHeader">
        <h2>Mixer</h2>
        <button id="mixerCloseBtn" type="button" className="icon-btn" title="Close mixer" onClick={onClose}>
          <XIcon />
        </button>
      </div>
      <div id="channels">
        {tracks.map((t) => (
          <Channel
            key={t.id}
            id={t.id}
            name={t.name}
            initialVolume={t.initialVolume}
            muted={t.muted}
            solo={t.solo}
            onVolumeInput={onVolumeInput}
            onPanInput={onPanInput}
            onToggleMute={onToggleMute}
            onToggleSolo={onToggleSolo}
          />
        ))}
      </div>
    </aside>
  );
}
