import { useEffect } from 'react';

interface KeyboardShortcutHandlers {
  onTogglePlay: () => void;
  onStepPage: (direction: 1 | -1) => void;
  onToggleMetronome: () => void;
}

// Space play/pause, Page Up/Down (same as Fn+Up/Fn+Down on a Mac keyboard -
// the browser reports those identically as "PageUp"/"PageDown") scroll a
// page, M toggles the metronome. Skipped while a form control has focus
// (e.g. a mixer slider), so its own native arrow-key/space handling still
// works, and skipped for any shortcut-style modifier combo.
export function useKeyboardShortcuts({ onTogglePlay, onStepPage, onToggleMetronome }: KeyboardShortcutHandlers): void {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      switch (e.key) {
        case ' ':
        case 'Spacebar':
          e.preventDefault();
          onTogglePlay();
          break;
        case 'PageUp':
          e.preventDefault();
          onStepPage(-1);
          break;
        case 'PageDown':
          e.preventDefault();
          onStepPage(1);
          break;
        case 'm':
        case 'M':
          e.preventDefault();
          onToggleMetronome();
          break;
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onTogglePlay, onStepPage, onToggleMetronome]);
}
