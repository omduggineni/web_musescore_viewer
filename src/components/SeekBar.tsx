import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { SEEK_RESOLUTION } from '../constants';

export interface SeekBarHandle {
  setValue(fraction: number): void;
}

interface SeekBarProps {
  disabled: boolean;
  onInput: (fraction: number) => void;
  onChange: (fraction: number) => void;
}

// Native 'input' (fires continuously while dragging) and 'change' (fires
// once on commit/release) are distinct DOM events, but React's onChange
// prop is normalized to behave like 'input' for range elements - so both
// listeners are wired manually here to keep that distinction, matching
// src/app.js's original els.seek.addEventListener('input'/'change', ...).
export const SeekBar = forwardRef<SeekBarHandle, SeekBarProps>(function SeekBar(
  { disabled, onInput, onChange },
  ref,
) {
  const inputRef = useRef<HTMLInputElement>(null);

  useImperativeHandle(ref, () => ({
    setValue(fraction) {
      if (inputRef.current) {
        inputRef.current.value = String(Math.round(fraction * SEEK_RESOLUTION));
      }
    },
  }));

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const handleInput = () => onInput(Number(el.value) / SEEK_RESOLUTION);
    const handleChange = () => onChange(Number(el.value) / SEEK_RESOLUTION);
    el.addEventListener('input', handleInput);
    el.addEventListener('change', handleChange);
    return () => {
      el.removeEventListener('input', handleInput);
      el.removeEventListener('change', handleChange);
    };
  }, [onInput, onChange]);

  return (
    <input
      id="seek"
      ref={inputRef}
      type="range"
      min={0}
      max={SEEK_RESOLUTION}
      defaultValue={0}
      step={1}
      disabled={disabled}
    />
  );
});
