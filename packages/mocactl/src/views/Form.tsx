import { Box, Text, useInput } from 'ink';
import { useRef, useState } from 'react';
import { useTheme } from '../theme/context.js';

export interface FormField {
  key: string;
  label: string;
  masked?: boolean;
  hint?: string;
  initial?: string;
  optional?: boolean;
  suggestions?: string[];
  visible?: (values: Record<string, string>) => boolean;
}

interface Props {
  title: string;
  fields: FormField[];
  onSubmit: (values: Record<string, string>) => void;
  onCancel: () => void;
  validate?: (values: Record<string, string>) => string | undefined;
  error?: string;
}

export function Form({ title, fields, onSubmit, onCancel, validate, error }: Props) {
  const { tokens: t } = useTheme();
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map((f) => [f.key, f.initial ?? ''])),
  );
  const [focus, setFocus] = useState(0);
  const [problem, setProblem] = useState<string>();

  // A burst of keystrokes delivered before React re-renders (key repeat, a pasted "\n") invokes
  // this same useInput closure several times with no render in between, so reading `values` /
  // `focus` state (this render's snapshot) would make every call in the burst see the *same*
  // snapshot — e.g. two Enters on the last field would both read "not yet submitted" and both
  // call onSubmit. `values`/`focus` are mirrored into refs that are mutated synchronously
  // alongside every state update; the handler derives `shown`/`at`/`field` from the refs (so
  // each keystroke sees the previous keystroke's effect), while the JSX below still renders
  // from state, which catches up once React flushes.
  const valuesRef = useRef(values);
  const focusRef = useRef(focus);
  // Guards a repeated Enter on an already-submitted last field from calling onSubmit twice.
  // Cleared on the next value change, so fixing a validation error and resubmitting still
  // works; a fresh mount of the form also starts unblocked.
  const submittedRef = useRef(false);

  const shownOf = (vals: Record<string, string>) =>
    fields.filter((f) => !f.visible || f.visible(vals));

  const setFieldValue = (key: string, next: string) => {
    valuesRef.current = { ...valuesRef.current, [key]: next };
    submittedRef.current = false;
    setValues(valuesRef.current);
  };

  const setFocusNow = (next: number) => {
    focusRef.current = next;
    setFocus(next);
  };

  const submit = (vals: Record<string, string>, shownFields: FormField[]) => {
    const out = Object.fromEntries(shownFields.map((f) => [f.key, vals[f.key] ?? '']));
    const missing = shownFields.find((f) => !f.optional && !out[f.key].trim());
    if (missing) return setProblem(`${missing.label} is required`);
    const msg = validate?.(out);
    if (msg) return setProblem(msg);
    setProblem(undefined);
    submittedRef.current = true;
    onSubmit(out);
  };

  const shown = shownOf(values);
  const at = Math.min(focus, shown.length - 1);

  useInput((input, key) => {
    const valuesNow = valuesRef.current;
    const shownNow = shownOf(valuesNow);
    const atNow = Math.min(focusRef.current, shownNow.length - 1);
    const fieldNow = shownNow[atNow];
    if (!fieldNow) return;
    if (key.escape) return onCancel();
    if (key.upArrow) return setFocusNow(Math.max(0, atNow - 1));
    if (key.downArrow) return setFocusNow(Math.min(shownNow.length - 1, atNow + 1));
    if (key.return) {
      if (atNow === shownNow.length - 1) {
        if (!submittedRef.current) submit(valuesNow, shownNow);
      } else setFocusNow(atNow + 1);
      return;
    }
    if (key.tab) {
      const s = fieldNow.suggestions;
      if (s && s.length > 0) {
        const next = s[(s.indexOf(valuesNow[fieldNow.key]) + 1) % s.length];
        setFieldValue(fieldNow.key, next);
      } else setFocusNow(Math.min(shownNow.length - 1, atNow + 1));
      return;
    }
    if (key.backspace || key.delete) {
      setFieldValue(fieldNow.key, (valuesNow[fieldNow.key] ?? '').slice(0, -1));
      return;
    }
    if (input && !key.ctrl && !key.meta)
      setFieldValue(fieldNow.key, (valuesNow[fieldNow.key] ?? '') + input);
  });

  return (
    <Box flexDirection="column">
      <Text bold color={t.primary}>
        {title}
      </Text>
      {shown.map((f, i) => {
        const v = values[f.key] ?? '';
        const display = f.masked ? '•'.repeat(Array.from(v).length) : v;
        return (
          <Box key={f.key} flexDirection="column">
            <Text color={i === at ? t.primary : t.text}>
              {i === at ? '› ' : '  '}
              {f.label}: {display}
              {i === at ? '▌' : ''}
            </Text>
            {i === at && f.hint ? <Text color={t.muted}> {f.hint}</Text> : null}
            {i === at && f.suggestions ? (
              <Text color={t.muted}> tab: {f.suggestions.join(' / ')}</Text>
            ) : null}
          </Box>
        );
      })}
      {problem ? <Text color={t.warning}>{problem}</Text> : null}
      {error ? <Text color={t.error}>{error}</Text> : null}
    </Box>
  );
}
