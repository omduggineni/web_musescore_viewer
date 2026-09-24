import { forwardRef, useImperativeHandle, useRef } from 'react';
import { useDropdown } from '../hooks/useDropdown';

export interface TempoControlHandle {
  // Written on every rAF tick while playing (currentBaseBpm() depends on
  // playhead position), so - like SeekBar/TimeLabel/CursorOverlay - this
  // stays an imperative DOM write instead of React state to avoid a
  // re-render on every animation frame.
  updateLabel(baseBpm: number, speed: number): void;
}

interface TempoControlProps {
  speed: number;
  onSpeedChange: (speed: number) => void;
}

export const TempoControl = forwardRef<TempoControlHandle, TempoControlProps>(function TempoControl(
  { speed, onSpeedChange },
  ref,
) {
  const tempoLabelRef = useRef<HTMLSpanElement>(null);
  const speedValueRef = useRef<HTMLSpanElement>(null);
  const dropdown = useDropdown();

  useImperativeHandle(ref, () => ({
    updateLabel(baseBpm, currentSpeed) {
      if (speedValueRef.current) {
        speedValueRef.current.textContent = `${currentSpeed.toFixed(2)}×`;
      }
      if (tempoLabelRef.current) {
        tempoLabelRef.current.textContent = baseBpm ? `♪ = ${Math.round(baseBpm * currentSpeed)}` : '';
      }
    },
  }));

  return (
    <div id="tempoGroup" className="dropdown">
      <button
        id="tempoBtn"
        ref={dropdown.buttonRef}
        type="button"
        className="tempo-btn"
        title="Click to change tempo"
        aria-haspopup="true"
        aria-expanded={dropdown.open}
        onClick={() => dropdown.toggle()}
      >
        <span id="tempoLabel" ref={tempoLabelRef} />
      </button>
      <div id="tempoPanel" ref={dropdown.panelRef} className="dropdown-panel" hidden={!dropdown.open}>
        <input
          id="speedSlider"
          type="range"
          min={0.7}
          max={1}
          step={0.02}
          value={speed}
          title="Tempo"
          aria-label="Tempo"
          onChange={(e) => onSpeedChange(Number(e.currentTarget.value))}
        />
        <span id="speedValue" ref={speedValueRef}>
          1.00×
        </span>
      </div>
    </div>
  );
});
