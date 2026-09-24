import { SlidersHorizontalIcon } from './icons';

interface MixerToggleButtonProps {
  open: boolean;
  onToggle: () => void;
}

export function MixerToggleButton({ open, onToggle }: MixerToggleButtonProps) {
  return (
    <button
      id="mixerToggleBtn"
      type="button"
      className={`icon-btn${open ? ' active' : ''}`}
      title="Toggle mixer"
      aria-pressed={open}
      onClick={onToggle}
    >
      <SlidersHorizontalIcon />
    </button>
  );
}
