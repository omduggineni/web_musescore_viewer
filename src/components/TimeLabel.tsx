import { forwardRef, useImperativeHandle, useRef } from 'react';

export interface TimeLabelHandle {
  setText(current: number, duration: number): void;
}

function fmtTime(sec: number): string {
  sec = Math.max(0, Math.floor(sec));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export const TimeLabel = forwardRef<TimeLabelHandle>(function TimeLabel(_props, ref) {
  const spanRef = useRef<HTMLSpanElement>(null);

  useImperativeHandle(ref, () => ({
    setText(current, duration) {
      if (spanRef.current) {
        spanRef.current.textContent = `${fmtTime(current)} / ${fmtTime(duration)}`;
      }
    },
  }));

  return (
    <span id="timeLabel" ref={spanRef}>
      0:00 / 0:00
    </span>
  );
});
