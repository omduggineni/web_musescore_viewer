import { forwardRef, useImperativeHandle, useRef } from 'react';

export interface CursorOverlayHandle {
  moveTo(x: number, y: number, w: number, h: number): void;
  hide(): void;
}

export const CursorOverlay = forwardRef<CursorOverlayHandle>(function CursorOverlay(_props, ref) {
  const elRef = useRef<HTMLDivElement>(null);

  useImperativeHandle(ref, () => ({
    moveTo(x, y, w, h) {
      const el = elRef.current;
      if (!el) return;
      el.style.display = 'block';
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
      el.style.width = `${w}px`;
      el.style.height = `${h}px`;
    },
    hide() {
      if (elRef.current) elRef.current.style.display = 'none';
    },
  }));

  return <div className="cursor-hl" ref={elRef} />;
});
