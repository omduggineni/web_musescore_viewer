import { useEffect, useState } from 'react';
import type { ScoreIndexEntry } from '../types';

// Fetches scores/index.json once and resolves the score to load: the
// `?score=` URL param if it names a real entry, otherwise the first score
// in the index. Returns null until resolved (or if the index is empty).
export function useScoreIndex(): string | null {
  const [scoreId, setScoreId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch('scores/index.json');
      const list: ScoreIndexEntry[] = await res.json();
      if (cancelled || list.length === 0) return;
      const requested = new URLSearchParams(location.search).get('score');
      const id = list.some((s) => s.id === requested) ? (requested as string) : list[0].id;
      setScoreId(id);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return scoreId;
}
