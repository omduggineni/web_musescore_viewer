import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useScoreIndex } from '../hooks/useScoreIndex';
import { useScorePlayer } from '../hooks/useScorePlayer';
import { useFullscreenState } from '../hooks/useFullscreenState';
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts';
import { Topbar } from './Topbar';
import { PagesView } from './PagesView';
import { Mixer } from './Mixer';
import { Transport } from './Transport';

type LayoutMode = 'centered' | 'book';

export function App() {
  const scoreId = useScoreIndex();
  const mainRef = useRef<HTMLElement>(null);
  const player = useScorePlayer({ scoreId, mainRef });
  const fullscreen = useFullscreenState();

  const [layoutMode, setLayoutModeState] = useState<LayoutMode>('centered');
  // Sidebar on desktop defaults open; fullscreen dialog on mobile (see the
  // 700px breakpoint in style.css) defaults closed, since it would
  // otherwise cover the just-loaded score immediately.
  const [mixerOpen, setMixerOpen] = useState(() => !window.matchMedia('(max-width: 700px)').matches);

  // Book mode can only be entered while the view toggle is visible (above
  // 700px), but shrinking the window afterward doesn't re-run that choice
  // on its own, so a resize down past that point falls back to centered.
  useEffect(() => {
    function onResize() {
      if (layoutMode === 'book' && window.matchMedia('(max-width: 700px)').matches) {
        setLayoutModeState('centered');
      }
    }
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [layoutMode]);

  // Layout/mixer changes shift page positions on screen - recompute (not
  // force-scroll) the cursor after the DOM settles into the new shape.
  useLayoutEffect(() => {
    player.recomputeCursor(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutMode, mixerOpen]);

  useKeyboardShortcuts({
    onTogglePlay: player.togglePlay,
    onStepPage: player.stepPage,
    onToggleMetronome: player.toggleMetronome,
  });

  const base = scoreId ? `scores/${scoreId}/` : '';

  return (
    <>
      <Topbar
        ref={player.tempoControlRef}
        title={player.scoreMeta?.title ?? ''}
        composer={player.scoreMeta?.composer ?? ''}
        speed={player.speed}
        onSpeedChange={player.setSpeedValue}
        metronomeOn={player.metronomeOn}
        onToggleMetronome={player.toggleMetronome}
        layoutMode={layoutMode}
        onLayoutChange={setLayoutModeState}
        zoomLevel={player.zoomLevel}
        onZoom={player.setZoom}
        fullscreen={fullscreen.fullscreen}
        onToggleFullscreen={fullscreen.toggle}
        mixerOpen={mixerOpen}
        onToggleMixer={() => setMixerOpen((o) => !o)}
      />

      <main id="main" ref={mainRef}>
        <PagesView
          ref={player.pagesViewRef}
          base={base}
          npages={player.scoreMeta?.npages ?? 0}
          layoutMode={layoutMode}
          zoomLevel={player.zoomLevel}
          onPageClick={player.onPageClick}
        />

        <Mixer
          open={mixerOpen}
          tracks={player.trackList}
          onClose={() => setMixerOpen(false)}
          onVolumeInput={player.setTrackVolume}
          onPanInput={player.setTrackPan}
          onToggleMute={player.toggleTrackMute}
          onToggleSolo={player.toggleTrackSolo}
        />
      </main>

      <Transport
        playing={player.playing}
        disabled={player.loading}
        seekBarRef={player.seekBarRef}
        timeLabelRef={player.timeLabelRef}
        onTogglePlay={player.togglePlay}
        onSeekInput={player.onSeekInput}
        onSeekChange={player.onSeekChange}
      />
    </>
  );
}
