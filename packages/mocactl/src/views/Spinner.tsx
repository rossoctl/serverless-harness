import { Text } from 'ink';
import { useEffect, useState } from 'react';
import { useTheme } from '../theme/context.js';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export function Spinner({ label }: { label?: string }) {
  const theme = useTheme();
  const [i, setI] = useState(0);
  useEffect(() => {
    if (theme.reducedMotion) return;
    const t = setInterval(() => setI((n) => (n + 1) % FRAMES.length), 80);
    return () => clearInterval(t);
  }, [theme.reducedMotion]);
  const glyph = theme.reducedMotion ? '…' : FRAMES[i];
  return (
    <Text color={theme.tokens.accent}>
      {glyph}
      {label ? ` ${label}` : ''}
    </Text>
  );
}
