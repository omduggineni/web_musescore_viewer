import { forwardRef, useRef } from 'react';
import { useDropdown } from '../hooks/useDropdown';
import { useResponsiveTopbar } from '../hooks/useResponsiveTopbar';
import { MaximizeIcon, MenuIcon, MetronomeIcon, MinimizeIcon, XIcon } from './icons';
import { TempoControl, type TempoControlHandle } from './TempoControl';
import { ViewToggle } from './ViewToggle';
import { ZoomControl } from './ZoomControl';
import { MixerToggleButton } from './MixerToggleButton';

interface TopbarProps {
  title: string;
  composer: string;
  speed: number;
  onSpeedChange: (speed: number) => void;
  metronomeOn: boolean;
  onToggleMetronome: () => void;
  layoutMode: 'centered' | 'book';
  onLayoutChange: (mode: 'centered' | 'book') => void;
  zoomLevel: number;
  onZoom: (level: number) => void;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
  mixerOpen: boolean;
  onToggleMixer: () => void;
}

export const Topbar = forwardRef<TempoControlHandle, TopbarProps>(function Topbar(
  {
    title,
    composer,
    speed,
    onSpeedChange,
    metronomeOn,
    onToggleMetronome,
    layoutMode,
    onLayoutChange,
    zoomLevel,
    onZoom,
    fullscreen,
    onToggleFullscreen,
    mixerOpen,
    onToggleMixer,
  },
  tempoControlRef,
) {
  const topbarRef = useRef<HTMLElement>(null);
  const menu = useDropdown();

  useResponsiveTopbar(topbarRef, [title, composer], () => menu.close());

  return (
    <header id="topbar" ref={topbarRef}>
      <div id="scoreInfo">
        <span id="scoreTitle">{title}</span>
        <span id="scoreComposer">{composer}</span>
      </div>
      <button
        id="menuBtn"
        ref={menu.buttonRef}
        type="button"
        className="icon-btn"
        title="More controls"
        aria-haspopup="true"
        aria-expanded={menu.open}
        onClick={() => menu.toggle()}
      >
        {menu.open ? <XIcon /> : <MenuIcon />}
      </button>
      {/* Never conditionally unmounted - see PagesView/Mixer's own note and
          the #rightControls[hidden] override in style.css, which is what
          makes `hidden` work here despite #rightControls setting its own
          `display: flex`. */}
      <div id="rightControls" ref={menu.panelRef} hidden={!menu.open}>
        <TempoControl ref={tempoControlRef} speed={speed} onSpeedChange={onSpeedChange} />
        <button
          id="metronomeBtn"
          type="button"
          className={`icon-btn${metronomeOn ? ' active' : ''}`}
          title="Metronome"
          aria-pressed={metronomeOn}
          onClick={onToggleMetronome}
        >
          <MetronomeIcon />
        </button>
        <ViewToggle layoutMode={layoutMode} onChange={onLayoutChange} />
        <ZoomControl zoomLevel={zoomLevel} onZoom={onZoom} />
        <button
          id="fullscreenBtn"
          type="button"
          className={`icon-btn${fullscreen ? ' active' : ''}`}
          title={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          aria-pressed={fullscreen}
          onClick={onToggleFullscreen}
        >
          {fullscreen ? <MinimizeIcon /> : <MaximizeIcon />}
        </button>
        <MixerToggleButton open={mixerOpen} onToggle={onToggleMixer} />
      </div>
    </header>
  );
});
