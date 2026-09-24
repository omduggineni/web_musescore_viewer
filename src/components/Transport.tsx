import type { RefObject } from 'react';
import { PlayIcon, PauseIcon, LoaderIcon } from './icons';
import { SeekBar, type SeekBarHandle } from './SeekBar';
import { TimeLabel, type TimeLabelHandle } from './TimeLabel';

interface TransportProps {
  playing: boolean;
  disabled: boolean;
  showSpinner: boolean;
  seekBarRef: RefObject<SeekBarHandle>;
  timeLabelRef: RefObject<TimeLabelHandle>;
  onTogglePlay: () => void;
  onSeekInput: (fraction: number) => void;
  onSeekChange: (fraction: number) => void;
}

export function Transport({
  playing,
  disabled,
  showSpinner,
  seekBarRef,
  timeLabelRef,
  onTogglePlay,
  onSeekInput,
  onSeekChange,
}: TransportProps) {
  return (
    <footer id="transport">
      <button
        id="playBtn"
        className="icon-btn"
        title={showSpinner ? 'Loading' : playing ? 'Pause' : 'Play'}
        aria-pressed={playing}
        disabled={disabled}
        onClick={onTogglePlay}
      >
        {showSpinner ? <LoaderIcon className="spin" /> : playing ? <PauseIcon /> : <PlayIcon />}
      </button>
      <SeekBar ref={seekBarRef} disabled={disabled} onInput={onSeekInput} onChange={onSeekChange} />
      <TimeLabel ref={timeLabelRef} />
    </footer>
  );
}
