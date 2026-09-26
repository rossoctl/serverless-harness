import { Box, Text } from 'ink';
import { useEffect, useMemo, useState } from 'react';
import type { ControlPlaneApi, CredentialDescriptor } from '../../api/types.js';
import { describeError } from '../../core/messages.js';
import { sanitizeRemote } from '../../core/sanitize.js';
import { useTheme } from '../../theme/context.js';
import { Confirm } from '../Confirm.js';
import { Form } from '../Form.js';
import { SelectList } from '../SelectList.js';
import { Spinner } from '../Spinner.js';
import { credentialFields, toPutRequest, validateCredential } from './credential-form.js';

interface Props {
  cp: ControlPlaneApi;
  hint?: string;
  startInAdd?: boolean;
  onChanged?: () => void;
  onCancel: () => void;
  /**
   * Offered every control-plane error first; returning true means the host has handled it (an
   * expired login opens the Login overlay), so this overlay shows nothing of its own.
   */
  onError?: (err: unknown) => boolean;
  /**
   * Called with true while the current screen takes no input (a spinner or an error), so the
   * host can let Esc close the overlay from there; this overlay adds no key handler of its own.
   */
  onInputless?: (inputless: boolean) => void;
}

type Mode =
  | { kind: 'list' }
  | { kind: 'add'; error?: string; saving?: boolean }
  | { kind: 'confirm'; name: string };

export function CredentialsOverlay({
  cp,
  hint,
  startInAdd,
  onChanged,
  onCancel,
  onError,
  onInputless,
}: Props) {
  const { tokens: t } = useTheme();
  const [creds, setCreds] = useState<CredentialDescriptor[]>();
  const [error, setError] = useState<string>();
  const [mode, setMode] = useState<Mode>(startInAdd ? { kind: 'add' } : { kind: 'list' });
  const [reload, setReload] = useState(0);
  const fields = useMemo(credentialFields, []);
  const handled = (err: unknown) => onError?.(err) === true;

  useEffect(() => {
    cp.listCredentials()
      .then(setCreds)
      .catch((err) => {
        if (!handled(err)) setError(describeError(err));
      });
  }, [reload]);

  const inputless = mode.kind === 'list' && (!!error || !creds);
  useEffect(() => {
    onInputless?.(inputless);
  }, [inputless]);

  if (mode.kind === 'add') {
    return (
      <Box flexDirection="column">
        {hint ? <Text color={t.info}>{hint}</Text> : null}
        <Form
          title="Add credential"
          fields={fields}
          validate={validateCredential}
          error={mode.error}
          onCancel={() => setMode({ kind: 'list' })}
          onSubmit={(values) => {
            const { name, req } = toPutRequest(values);
            setMode({ kind: 'add', saving: true });
            cp.putCredential(name, req)
              .then(() => {
                onChanged?.();
                setReload((n) => n + 1);
                setMode({ kind: 'list' });
              })
              .catch((err) => {
                if (!handled(err)) setMode({ kind: 'add', error: describeError(err) });
              });
          }}
        />
        {mode.saving ? <Spinner label="saving" /> : null}
      </Box>
    );
  }

  if (mode.kind === 'confirm') {
    return (
      <Confirm
        // The confirmation text is shown terminal-safe; deleteCredential below keeps the raw name.
        message={`Delete credential "${sanitizeRemote(mode.name)}"?`}
        onYes={() => {
          setMode({ kind: 'list' });
          cp.deleteCredential(mode.name)
            .then(() => {
              onChanged?.();
              setReload((n) => n + 1);
            })
            .catch((err) => {
              if (!handled(err)) setError(describeError(err));
            });
        }}
        onNo={() => setMode({ kind: 'list' })}
      />
    );
  }

  if (error) return <Text color={t.error}>{error}</Text>;
  if (!creds) return <Spinner label="loading credentials" />;

  return (
    <Box flexDirection="column">
      {hint ? <Text color={t.info}>{hint}</Text> : null}
      <SelectList
        title="Credentials"
        filter="off"
        emptyText="no credentials yet — press a to add one"
        items={creds.map((c) => ({
          key: c.name,
          // Credential metadata is the server's: names, kinds and endpoints are shown terminal-safe.
          label: sanitizeRemote(c.name),
          detail: sanitizeRemote([c.kind, c.consumer, c.endpoint].filter(Boolean).join(' · ')),
          value: c.name,
        }))}
        onSelect={() => undefined}
        onCancel={onCancel}
        keys={{
          a: () => setMode({ kind: 'add' }),
          d: (name) => name && setMode({ kind: 'confirm', name }),
        }}
      />
      <Text color={t.muted}>
        a add · d delete · esc close · values are write-only and never shown
      </Text>
    </Box>
  );
}
