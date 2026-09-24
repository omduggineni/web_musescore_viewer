interface ChannelProps {
  id: string;
  name: string;
  initialVolume: number;
  muted: boolean;
  solo: boolean;
  onVolumeInput: (id: string, volume: number) => void;
  onPanInput: (id: string, pan: number) => void;
  onToggleMute: (id: string) => void;
  onToggleSolo: (id: string) => void;
}

export function Channel({
  id,
  name,
  initialVolume,
  muted,
  solo,
  onVolumeInput,
  onPanInput,
  onToggleMute,
  onToggleSolo,
}: ChannelProps) {
  return (
    <div className="channel">
      <div className="channel-name" title={name}>
        {name}
      </div>
      <div className="channel-row">
        <label>Vol</label>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          defaultValue={initialVolume}
          onInput={(e) => onVolumeInput(id, Number(e.currentTarget.value))}
        />
      </div>
      <div className="channel-row">
        <label>Pan</label>
        <input
          type="range"
          min={-1}
          max={1}
          step={0.01}
          defaultValue={0}
          onInput={(e) => onPanInput(id, Number(e.currentTarget.value))}
        />
      </div>
      <div className="channel-toggles">
        <button
          type="button"
          className={`toggle-btn${muted ? ' active-mute' : ''}`}
          onClick={() => onToggleMute(id)}
        >
          Mute
        </button>
        <button
          type="button"
          className={`toggle-btn${solo ? ' active-solo' : ''}`}
          onClick={() => onToggleSolo(id)}
        >
          Solo
        </button>
      </div>
    </div>
  );
}
