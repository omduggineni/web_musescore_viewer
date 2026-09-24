import { useLayoutEffect, type RefObject } from 'react';

// Steps #topbar down through two fallbacks as content actually stops
// fitting - not tied to a device breakpoint, since what fits depends on
// the current title/composer text length as much as the window width.
// Each check re-measures with the *previous* step already applied, so a
// long score title alone can trigger the composer to hide, or even the
// controls to collapse, well above any "mobile" width. Runs as a
// useLayoutEffect (not useEffect) to avoid a visible flash, and mutates
// #topbar's classList directly rather than through React state so the
// two-pass remeasurement stays synchronous.
export function useResponsiveTopbar(
  topbarRef: RefObject<HTMLElement>,
  deps: unknown[],
  onCollapseEngage: () => void,
): void {
  useLayoutEffect(() => {
    function layoutTopbar() {
      const topbar = topbarRef.current;
      if (!topbar) return;
      const wasCollapsed = topbar.classList.contains('collapse-controls');
      topbar.classList.remove('hide-composer', 'collapse-controls');

      if (topbar.scrollWidth > topbar.clientWidth) {
        topbar.classList.add('hide-composer');
      }
      if (topbar.scrollWidth > topbar.clientWidth) {
        topbar.classList.add('collapse-controls');
        // Just started collapsing - start with the menu closed rather than
        // carrying over whatever `hidden` happened to be left at before.
        if (!wasCollapsed) onCollapseEngage();
      }
    }
    layoutTopbar();
    window.addEventListener('resize', layoutTopbar);
    return () => window.removeEventListener('resize', layoutTopbar);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
