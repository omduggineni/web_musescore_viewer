import { ZoomOutIcon, ZoomInIcon } from './icons';
import { ZOOM_STEP, ZOOM_MIN, ZOOM_MAX } from '../constants';

interface ZoomControlProps {
  zoomLevel: number;
  onZoom: (level: number) => void;
}

export function ZoomControl({ zoomLevel, onZoom }: ZoomControlProps) {
  return (
    <div id="zoomGroup" className="segmented">
      <button
        id="zoomOutBtn"
        type="button"
        className="segment"
        title="Zoom out"
        disabled={zoomLevel <= ZOOM_MIN}
        onClick={() => onZoom(zoomLevel - ZOOM_STEP)}
      >
        <ZoomOutIcon />
      </button>
      <button
        id="zoomInBtn"
        type="button"
        className="segment"
        title="Zoom in"
        disabled={zoomLevel >= ZOOM_MAX}
        onClick={() => onZoom(zoomLevel + ZOOM_STEP)}
      >
        <ZoomInIcon />
      </button>
    </div>
  );
}
