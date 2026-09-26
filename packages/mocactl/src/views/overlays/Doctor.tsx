import { Box, Text, useInput } from 'ink';
import { useEffect, useRef, useState } from 'react';
import type { CheckResult } from '../../core/diagnostics.js';
import { describeError } from '../../core/messages.js';
import { useTheme } from '../../theme/context.js';
import { Spinner } from '../Spinner.js';

export function DoctorOverlay({
  run,
  onClose,
  onError,
}: {
  run: () => Promise<CheckResult[]>;
  onClose: () => void;
  /** Offered a failed run first; returning true means the host handled it (see Sessions). */
  onError?: (err: unknown) => boolean;
}) {
  const { tokens: t } = useTheme();
  const [results, setResults] = useState<CheckResult[]>();
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);

  // Guards against a still-running `run()` from a previous attempt settling after this overlay
  // has been unmounted (the parent closing it while a check is in flight) — set false only on
  // unmount so a still-mounted re-render never trips it.
  const mountedRef = useRef(true);
  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    setResults(undefined);
    setError(undefined);
    run()
      .then((r) => {
        if (mountedRef.current) setResults(r);
      })
      .catch((err) => {
        if (mountedRef.current && !onError?.(err)) setError(describeError(err));
      });
  }, [attempt]);

  useInput((input, key) => {
    if (key.escape) onClose();
    else if (input === 'r' && (results || error)) setAttempt((a) => a + 1);
  });

  return (
    <Box flexDirection="column">
      <Text bold color={t.primary}>
        Doctor
      </Text>
      {!results && !error ? <Spinner label="checking" /> : null}
      {error ? <Text color={t.error}>{error}</Text> : null}
      {results?.map((r) => (
        <Box key={r.id} flexDirection="column">
          <Text color={r.status === 'pass' ? t.success : t.error}>
            {r.status === 'pass' ? '✓' : '✗'} {r.id} {r.name}
          </Text>
          {r.fix ? <Text color={t.warning}> {r.fix}</Text> : null}
        </Box>
      ))}
      <Text color={t.muted}>r re-run · esc close</Text>
    </Box>
  );
}
