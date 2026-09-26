import { formatUsage } from '../views/format.js';
import type { Block } from './blocks.js';
import { toolSummary } from './tools.js';

export function transcriptToMarkdown(title: string, blocks: Block[]): string {
  const out: string[] = [`# ${title}`, ''];
  let speaker: 'You' | 'Assistant' | undefined;
  const heading = (who: 'You' | 'Assistant') => {
    if (speaker !== who) out.push(`## ${who}`, '');
    speaker = who;
  };
  for (const b of blocks) {
    switch (b.kind) {
      case 'user':
        heading('You');
        out.push(b.text, '');
        break;
      case 'assistant':
        if (!b.text) break;
        heading('Assistant');
        out.push(b.text, '');
        break;
      case 'tool':
        heading('Assistant');
        out.push(`- \`${toolSummary(b.name, b.args)}\`${b.result?.isError ? ' — failed' : ''}`, '');
        break;
      case 'turn-end':
        if (b.outcome === 'error') out.push(`_error: ${b.message ?? 'the turn failed'}_`, '');
        else if (b.outcome === 'cancelled') out.push('_cancelled_', '');
        else if (b.usage) out.push(`_${formatUsage(b.usage)}_`, '');
        break;
      default:
        break;
    }
  }
  return out.join('\n');
}
