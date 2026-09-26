import { Box, Text } from 'ink';
import { useEffect, useRef, useState } from 'react';
import type { ControlPlaneApi, HarnessApi } from '../../api/types.js';
import { normalizeUrl, type CachedAuth, type Endpoints } from '../../config.js';
import type { LoginDeps } from '../../core/auth.js';
import { describeError } from '../../core/messages.js';
import { useTheme } from '../../theme/context.js';
import { Form } from '../Form.js';
import { Spinner } from '../Spinner.js';
import { CredentialsOverlay } from './Credentials.js';
import { LoginOverlay } from './Login.js';

/** The one URL onboarding asks for, plus any harness override the user already set. */
type Chosen = Endpoints & { controlPlaneUrl: string };

interface Props {
  initial: Endpoints;
  connect: (e: Chosen) => { cp: ControlPlaneApi; harness: HarnessApi };
  hasValidLogin: () => boolean;
  loginDeps: () => LoginDeps;
  onLoggedIn: (auth: CachedAuth) => void;
  copy?: (text: string) => void | Promise<void>;
  openUrl?: (url: string) => void;
  /** The control plane and the harness it points at both answered: the host may persist them. */
  onConnected?: (e: Chosen) => void;
  onDone: () => void;
  onCancel: () => void;
  /**
   * Called with true while the current screen takes no input (a spinner, or the embedded
   * credentials step's loading/error screen), so the host can let Esc cancel from there.
   */
  onInputless?: (inputless: boolean) => void;
}

type Step =
  | { kind: 'endpoints'; error?: string }
  | { kind: 'probing' }
  | { kind: 'login'; controlPlaneUrl: string }
  | { kind: 'checking' }
  | { kind: 'credential' };

const isHttpUrl = (s: string) => {
  try {
    return ['http:', 'https:'].includes(new URL(s).protocol);
  } catch {
    return false;
  }
};

// Spec §6.8: every step is skipped when it is already satisfied, so `--setup` on a configured
// machine is a confirmation, not a chore.
export function OnboardingOverlay({
  initial,
  connect,
  hasValidLogin,
  loginDeps,
  onLoggedIn,
  copy,
  openUrl,
  onConnected,
  onDone,
  onCancel,
  onInputless,
}: Props) {
  const { tokens: t } = useTheme();
  const [step, setStep] = useState<Step>({ kind: 'endpoints' });
  const [endpoints, setEndpoints] = useState(initial);
  const [cp, setCp] = useState<ControlPlaneApi>();
  const [credentialInputless, setCredentialInputless] = useState(false);

  const inputless =
    step.kind === 'probing' ||
    step.kind === 'checking' ||
    (step.kind === 'credential' && credentialInputless);
  useEffect(() => {
    onInputless?.(inputless);
  }, [inputless]);

  // Guards every state update that follows an `await` below: `probe`/`checkCredential` keep
  // running after this overlay is unmounted (the parent swapping it out, or the process closing
  // it mid-check) — set false only on unmount so a still-mounted re-render never trips it.
  const mountedRef = useRef(true);
  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const checkCredential = async (api: ControlPlaneApi) => {
    setStep({ kind: 'checking' });
    try {
      const creds = await api.listCredentials();
      if (!mountedRef.current) return;
      if (creds.some((c) => c.consumer === 'inference')) onDone();
      else setStep({ kind: 'credential' });
    } catch (err) {
      if (!mountedRef.current) return;
      setStep({ kind: 'endpoints', error: describeError(err) });
    }
  };

  const probe = async (e: Chosen) => {
    setEndpoints(e);
    setStep({ kind: 'probing' });
    const clients = connect(e);
    setCp(clients.cp);
    // The harness is found through the control plane (or a local override), before any login.
    const [c, h] = await Promise.allSettled([clients.cp.healthz(), clients.harness.health()]);
    if (!mountedRef.current) return;
    const failures = [
      c.status === 'rejected' ? `control plane: ${describeError(c.reason)}` : undefined,
      h.status === 'rejected' ? `harness: ${describeError(h.reason)}` : undefined,
    ].filter(Boolean);
    if (failures.length > 0) return setStep({ kind: 'endpoints', error: failures.join('\n') });
    onConnected?.(e);
    if (!hasValidLogin()) return setStep({ kind: 'login', controlPlaneUrl: e.controlPlaneUrl });
    await checkCredential(clients.cp);
  };

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={t.primary}
      paddingX={2}
      paddingY={1}
    >
      <Text bold>Welcome to mocactl</Text>
      <Text color={t.muted}>1 endpoints · 2 login · 3 credential · 4 first session</Text>
      {step.kind === 'endpoints' ? (
        <Form
          title="Where is your MOCA server?"
          fields={[
            {
              key: 'controlPlaneUrl',
              label: 'Server URL',
              initial: endpoints.controlPlaneUrl,
              hint: 'the control plane — it tells mocactl where everything else is',
            },
          ]}
          validate={(v) =>
            !isHttpUrl(v.controlPlaneUrl) ? 'the server URL must be an http(s) URL' : undefined
          }
          error={step.error}
          onCancel={onCancel}
          onSubmit={(v) =>
            // Normalized here, not only when persisted: the login step caches its token under
            // this URL, and the next launch looks it up under the one config.json holds.
            void probe({
              controlPlaneUrl: normalizeUrl(v.controlPlaneUrl)!,
              harnessUrl: endpoints.harnessUrl,
            })
          }
        />
      ) : null}
      {step.kind === 'probing' ? <Spinner label="connecting" /> : null}
      {step.kind === 'checking' ? <Spinner label="looking for an inference credential" /> : null}
      {step.kind === 'login' ? (
        <LoginOverlay
          deps={loginDeps()}
          controlPlaneUrl={step.controlPlaneUrl}
          copy={copy}
          openUrl={openUrl}
          onCancel={onCancel}
          onLoggedIn={(auth) => {
            onLoggedIn(auth);
            if (cp) void checkCredential(cp);
          }}
        />
      ) : null}
      {step.kind === 'credential' && cp ? (
        <CredentialsOverlay
          cp={cp}
          startInAdd
          hint="an inference credential is the key and gateway your sessions use to reach a model"
          onChanged={() => void checkCredential(cp)}
          onCancel={onDone}
          onInputless={setCredentialInputless}
        />
      ) : null}
    </Box>
  );
}
