import { Box, Text, useInput } from 'ink';
import { useEffect, useState } from 'react';
import { useTheme } from '../theme/context.js';

interface Props {
  active: boolean;
  history: string[];
  onSubmit: (text: string) => void;
  onHelp: () => void;
  prefill?: { text: string; nonce: number };
  placeholder?: string;
}

export function InputBox({ active, history, onSubmit, onHelp, prefill, placeholder }: Props) {
  const { tokens: t } = useTheme();
  const [value, setValue] = useState('');
  // -1 = editing a fresh line; 0 = newest history entry; history.length - 1 = oldest.
  const [historyIndex, setHistoryIndex] = useState(-1);

  // Keyed on the nonce, not the text: re-applying the same prefill text (e.g. re-opening
  // the same slash command) must still land, which a text-only dependency would miss.
  useEffect(() => {
    if (prefill) {
      setValue(prefill.text);
      setHistoryIndex(-1);
    }
  }, [prefill?.nonce]);

  useInput(
    (input, key) => {
      if (key.ctrl || key.escape || key.tab) return;
      if (key.return) {
        if (key.meta || key.shift) {
          setValue((v) => v + '\n');
          return;
        }
        const text = value.trim();
        if (!text) return;
        onSubmit(text);
        setValue('');
        setHistoryIndex(-1);
        return;
      }
      if (key.backspace || key.delete) {
        setValue((v) => Array.from(v).slice(0, -1).join(''));
        return;
      }
      if (key.upArrow || key.downArrow) {
        if (value !== '' && historyIndex === -1) return;
        const newest = [...history].reverse();
        const next = key.upArrow
          ? Math.min(historyIndex + 1, newest.length - 1)
          : Math.max(-1, historyIndex - 1);
        setHistoryIndex(next);
        setValue(next >= 0 ? (newest[next] ?? '') : '');
        return;
      }
      if (key.leftArrow || key.rightArrow || key.pageUp || key.pageDown) return;
      if (input === '?' && value === '') {
        onHelp();
        return;
      }
      if (input) {
        setValue((v) => v + input.replace(/\r\n?/g, '\n'));
        setHistoryIndex(-1);
      }
    },
    { isActive: active },
  );

  const lines = value.split('\n');
  return (
    <Box
      borderStyle="round"
      borderColor={active ? t.primary : t.border}
      paddingX={1}
      flexDirection="column"
    >
      {value === '' ? (
        <Text color={t.muted}>
          {placeholder ?? 'type a message · ctrl+p for commands · ? for help'}
        </Text>
      ) : (
        lines.map((l, i) => (
          <Text key={i} color={t.text}>
            {l}
            {i === lines.length - 1 && active ? '▌' : ''}
          </Text>
        ))
      )}
    </Box>
  );
}
