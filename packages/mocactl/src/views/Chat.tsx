import { Box, Static } from 'ink';
import type { ReactNode } from 'react';
import { splitStatic, type BlockState } from '../render/blocks.js';
import { BlockView } from './BlockView.js';
import { InputBox } from './InputBox.js';
import { StatusLine } from './StatusLine.js';
import type { StatusField } from './status.js';

interface Props {
  blocks: BlockState;
  details: boolean;
  thinking: boolean;
  width: number;
  staticKey: number;
  statusFields: StatusField[];
  inputActive: boolean;
  history: string[];
  onSubmit: (text: string) => void;
  onHelp: () => void;
  prefill?: { text: string; nonce: number };
  overlay?: ReactNode;
}

// Settled blocks are printed once through <Static> and never re-rendered, so a long transcript
// costs no more per token than a short one (spec §6.1).
export function Chat({
  blocks,
  details,
  thinking,
  width,
  staticKey,
  statusFields,
  inputActive,
  history,
  onSubmit,
  onHelp,
  prefill,
  overlay,
}: Props) {
  const { settled, live } = splitStatic(blocks.blocks);
  const view = (b: (typeof blocks.blocks)[number]) => (
    <BlockView key={b.id} block={b} details={details} thinking={thinking} width={width} />
  );
  return (
    <Box flexDirection="column">
      <Static key={staticKey} items={settled}>
        {view}
      </Static>
      {live.map(view)}
      {overlay ? (
        <Box marginTop={1} flexDirection="column">
          {overlay}
        </Box>
      ) : null}
      <InputBox
        active={inputActive}
        history={history}
        onSubmit={onSubmit}
        onHelp={onHelp}
        prefill={prefill}
      />
      <StatusLine fields={statusFields} width={width} />
    </Box>
  );
}
