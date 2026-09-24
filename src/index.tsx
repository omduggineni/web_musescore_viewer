import { createRoot } from 'react-dom/client';
import { App } from './components/App';
import './style.css';

const container = document.getElementById('root');
if (!container) throw new Error('#root element missing from index.html');

// StrictMode deliberately omitted: createMediaElementSource() throws if
// called twice on the same <audio> element, and StrictMode's dev-only
// double-invoked effects would trigger exactly that in useScorePlayer's
// score-load effect.
createRoot(container).render(<App />);
