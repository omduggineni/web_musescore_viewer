import { useCallback, useEffect, useRef, useState } from 'react';

export interface Dropdown {
  open: boolean;
  buttonRef: React.RefObject<HTMLButtonElement>;
  panelRef: React.RefObject<HTMLDivElement>;
  toggle(): void;
  close(): void;
}

// A click/Escape-outside-closes dropdown, mirroring src/app.js's
// makeDropdown() + the shared document click/keydown listeners it fed -
// but implemented per-instance via containment checks (see useDropdown.ts
// usage in TempoControl/Topbar) instead of relying on stopPropagation
// ordering between React's synthetic events and a native document
// listener, which is fragile to get right.
export function useDropdown(onOpenChange?: (open: boolean) => void): Dropdown {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;

  const close = useCallback(() => {
    setOpen((wasOpen) => {
      if (wasOpen) onOpenChangeRef.current?.(false);
      return false;
    });
  }, []);

  const toggle = useCallback(() => {
    setOpen((wasOpen) => {
      const next = !wasOpen;
      onOpenChangeRef.current?.(next);
      return next;
    });
  }, []);

  useEffect(() => {
    function handlePointerDown(e: MouseEvent) {
      // composedPath() is a snapshot taken at dispatch time, unlike
      // e.target - which matters because toggling `open` swaps the
      // button's icon (MenuIcon <-> XIcon) synchronously, so by the time
      // this listener runs the original target node may already be
      // detached, making a live target.contains() check false negative.
      const path = e.composedPath();
      if ((buttonRef.current && path.includes(buttonRef.current)) || (panelRef.current && path.includes(panelRef.current))) {
        return;
      }
      close();
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') close();
    }
    document.addEventListener('click', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('click', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [close]);

  return { open, buttonRef, panelRef, toggle, close };
}
