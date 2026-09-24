import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { CursorOverlay, type CursorOverlayHandle } from './CursorOverlay';
import { PAGE_LOAD_MARGIN } from '../constants';

export interface PagesViewHandle {
  getPageScale(pageIndex: number): number;
  getPageRect(pageIndex: number): DOMRect | null;
  getPagesWrapEl(): HTMLElement | null;
  moveCursor(pageIndex: number, x: number, y: number, w: number, h: number): void;
  hideCursor(): void;
}

interface PagesViewProps {
  base: string;
  npages: number;
  layoutMode: 'centered' | 'book';
  zoomLevel: number;
  onPageClick: (pageIndex: number, offsetX: number, offsetY: number) => void;
}

// Each <img>'s src is driven by `loadedPages` state (add on scroll-in,
// delete on scroll-out) rather than imperative DOM history, so a page's
// load state survives the layout switch below remounting its <img> under a
// different parent.
export const PagesView = forwardRef<PagesViewHandle, PagesViewProps>(function PagesView(
  { base, npages, layoutMode, zoomLevel, onPageClick },
  ref,
) {
  const pagesWrapRef = useRef<HTMLElement>(null);
  const pagesRef = useRef<HTMLDivElement>(null);
  const imgRefs = useRef<(HTMLImageElement | null)[]>([]);
  const pageDivRefs = useRef<(HTMLDivElement | null)[]>([]);
  const cursorRefs = useRef<(CursorOverlayHandle | null)[]>([]);
  const sharedDimsRef = useRef({ width: 0, height: 0 });
  const [loadedPages, setLoadedPages] = useState<ReadonlySet<number>>(new Set());

  // Keep the ref arrays sized to npages, done inline during render (not in
  // an effect) so they're already correct *before* commit - an effect here
  // would run after the <img> ref callbacks below have populated them for
  // this render, clobbering the very attachments it's racing against.
  if (imgRefs.current.length !== npages) {
    imgRefs.current = new Array(npages).fill(null);
    pageDivRefs.current = new Array(npages).fill(null);
    cursorRefs.current = new Array(npages).fill(null);
  }

  // New score: reset lazy-load state and the shared natural-size cache.
  useEffect(() => {
    sharedDimsRef.current = { width: 0, height: 0 };
    pagesRef.current?.style.removeProperty('--page-ratio');
    setLoadedPages(new Set());
  }, [base]);

  // Re-observe on every layout switch too: switching centered/book remounts
  // each <img> under a different parent, so the old observer's targets are
  // gone and a fresh one is needed for the new elements.
  useEffect(() => {
    const wrap = pagesWrapRef.current;
    if (!wrap) return;
    const indexByEl = new Map<Element, number>();
    imgRefs.current.forEach((img, i) => {
      if (img) indexByEl.set(img, i);
    });
    const observer = new IntersectionObserver(
      (entries) => {
        setLoadedPages((prev) => {
          let changed = false;
          const next = new Set(prev);
          for (const entry of entries) {
            const idx = indexByEl.get(entry.target);
            if (idx === undefined) continue;
            if (entry.isIntersecting) {
              if (!next.has(idx)) {
                next.add(idx);
                changed = true;
              }
            } else if (next.has(idx)) {
              next.delete(idx);
              changed = true;
            }
          }
          return changed ? next : prev;
        });
      },
      { root: wrap, rootMargin: PAGE_LOAD_MARGIN },
    );
    for (const img of imgRefs.current) if (img) observer.observe(img);
    return () => observer.disconnect();
  }, [npages, layoutMode, base]);

  function handleImgLoad(img: HTMLImageElement) {
    if (!sharedDimsRef.current.width) {
      sharedDimsRef.current = { width: img.naturalWidth, height: img.naturalHeight };
    }
    if (pagesRef.current && !pagesRef.current.style.getPropertyValue('--page-ratio')) {
      pagesRef.current.style.setProperty('--page-ratio', `${img.naturalWidth} / ${img.naturalHeight}`);
    }
  }

  useImperativeHandle(ref, () => ({
    getPageScale(pageIndex) {
      const img = imgRefs.current[pageIndex];
      if (!img) return 0;
      const naturalWidth = img.naturalWidth || sharedDimsRef.current.width;
      return naturalWidth ? img.clientWidth / naturalWidth : 0;
    },
    getPageRect(pageIndex) {
      return pageDivRefs.current[pageIndex]?.getBoundingClientRect() ?? null;
    },
    getPagesWrapEl() {
      return pagesWrapRef.current;
    },
    moveCursor(pageIndex, x, y, w, h) {
      cursorRefs.current.forEach((cursor, i) => {
        if (i === pageIndex) cursor?.moveTo(x, y, w, h);
        else cursor?.hide();
      });
    },
    hideCursor() {
      cursorRefs.current.forEach((cursor) => cursor?.hide());
    },
  }));

  function renderPage(i: number) {
    return (
      <div
        className="page"
        key={i}
        ref={(el) => {
          pageDivRefs.current[i] = el;
        }}
      >
        <img
          ref={(el) => {
            imgRefs.current[i] = el;
          }}
          src={loadedPages.has(i) ? `${base}page-${i}.svg` : undefined}
          alt={`Page ${i + 1}`}
          draggable={false}
          onLoad={(e) => handleImgLoad(e.currentTarget)}
          onClick={(e) => onPageClick(i, e.nativeEvent.offsetX, e.nativeEvent.offsetY)}
        />
        <CursorOverlay
          ref={(el) => {
            cursorRefs.current[i] = el;
          }}
        />
      </div>
    );
  }

  const pageIndices = Array.from({ length: npages }, (_, i) => i);

  return (
    <section id="pagesWrap" ref={pagesWrapRef}>
      <div
        id="pages"
        ref={pagesRef}
        className={layoutMode === 'book' ? 'layout-book' : 'layout-centered'}
        style={{ '--zoom': zoomLevel } as CSSProperties}
      >
        {layoutMode === 'centered'
          ? pageIndices.map((i) => renderPage(i))
          : pageIndices.reduce<JSX.Element[]>((spreads, i) => {
              if (i % 2 === 0) {
                const hasSecond = i + 1 < npages;
                spreads.push(
                  <div className="spread" key={`spread-${i}`}>
                    {renderPage(i)}
                    {hasSecond ? renderPage(i + 1) : <div className="page page-placeholder" />}
                  </div>,
                );
              }
              return spreads;
            }, [])}
      </div>
    </section>
  );
});
