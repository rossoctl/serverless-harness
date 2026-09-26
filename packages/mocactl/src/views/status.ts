import { truncate } from '../render/tools.js';
import { formatDuration } from './format.js';

export type TurnPhase = 'idle' | 'waiting' | 'streaming' | 'retrying';

export interface TurnState {
  phase: TurnPhase;
  startedAt?: number;
  retryUntil?: number;
  queued: number;
  lastTtftMs?: number;
}

// Spec §5.7: silence reads as a hang, so every phase says how long it has lasted.
export function describeTurn(s: TurnState, nowMs: number): string {
  let text: string;
  switch (s.phase) {
    case 'waiting':
      text = `waiting for harness… ${formatDuration(nowMs - (s.startedAt ?? nowMs))}`;
      break;
    case 'streaming':
      text = `streaming ${formatDuration(nowMs - (s.startedAt ?? nowMs))}`;
      break;
    case 'retrying':
      text = `no capacity — retrying in ${Math.max(0, Math.ceil(((s.retryUntil ?? nowMs) - nowMs) / 1000))}s`;
      break;
    default:
      text =
        s.lastTtftMs !== undefined ? `idle · first token ${formatDuration(s.lastTtftMs)}` : 'idle';
  }
  return s.queued > 0 ? `${text} · queued: ${s.queued}` : text;
}

export interface StatusField {
  key: 'subject' | 'title' | 'turn' | 'usage' | 'warning';
  text: string;
}

const SEP = ' · ';
const NARROW = 60;

export function fitStatus(fields: StatusField[], width: number): StatusField[] {
  let kept = width < NARROW ? fields.filter((f) => f.key === 'turn') : [...fields];
  const length = () => kept.map((f) => f.text).join(SEP).length;
  while (length() > width && kept.length > 1) {
    let i = kept.length - 1;
    while (i >= 0 && kept[i].key === 'turn') i--;
    if (i < 0) break;
    kept = kept.filter((_, j) => j !== i);
  }
  return kept.map((f) => (f.text.length > width ? { ...f, text: truncate(f.text, width) } : f));
}
