import { FileIcon, BookOpenIcon } from './icons';

interface ViewToggleProps {
  layoutMode: 'centered' | 'book';
  onChange: (mode: 'centered' | 'book') => void;
}

export function ViewToggle({ layoutMode, onChange }: ViewToggleProps) {
  return (
    <div id="viewToggle" className="segmented" role="group" aria-label="Page layout">
      <button
        id="viewCenteredBtn"
        type="button"
        className={`segment${layoutMode === 'centered' ? ' active' : ''}`}
        title="Centered view"
        aria-pressed={layoutMode === 'centered'}
        onClick={() => onChange('centered')}
      >
        <FileIcon />
      </button>
      <button
        id="viewBookBtn"
        type="button"
        className={`segment${layoutMode === 'book' ? ' active' : ''}`}
        title="Book view"
        aria-pressed={layoutMode === 'book'}
        onClick={() => onChange('book')}
      >
        <BookOpenIcon />
      </button>
    </div>
  );
}
