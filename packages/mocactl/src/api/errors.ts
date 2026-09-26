export type ErrorSource = 'control-plane' | 'harness';

export class ApiError extends Error {
  constructor(
    readonly source: ErrorSource,
    readonly status: number,
    readonly code: string,
    message?: string,
    readonly retryAfterS?: number,
  ) {
    super(message ?? code);
    this.name = 'ApiError';
  }
}

export class TurnCancelledError extends Error {
  constructor() {
    super('turn cancelled');
    this.name = 'TurnCancelledError';
  }
}

export async function errorFromResponse(source: ErrorSource, res: Response): Promise<ApiError> {
  const text = await res.text().catch(() => '');
  let code = `http_${res.status}`;
  let message: string | undefined;
  try {
    const body = JSON.parse(text) as { error?: unknown; message?: unknown };
    if (typeof body.error === 'string') code = body.error;
    if (typeof body.message === 'string') message = body.message;
  } catch {
    // Non-JSON error body (a proxy's HTML page, say): keep the status-derived code.
  }
  const retryAfter = Number.parseInt(res.headers.get('retry-after') ?? '', 10);
  return new ApiError(
    source,
    res.status,
    code,
    message,
    Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter : undefined,
  );
}

export function networkError(source: ErrorSource, err: unknown): ApiError {
  return new ApiError(source, 0, 'network_error', err instanceof Error ? err.message : String(err));
}

export const TOKEN_CODES: ReadonlySet<string> = new Set([
  'token_required',
  'token_invalid',
  'token_expired',
]);

const UNAVAILABLE = new Set(['redis_unavailable', 'credential_unavailable', 'internal_error']);

export type UiAction =
  | { kind: 'login' }
  | { kind: 'harness-token-rejected' }
  | { kind: 'session-gone' }
  | { kind: 'endpoint-unresolved'; message: string }
  | { kind: 'retry-after'; seconds: number }
  | { kind: 'unavailable'; source: ErrorSource }
  | { kind: 'connection'; source: ErrorSource; message: string }
  | { kind: 'show'; message: string };

/** Spec §8.1: one mapping from the API's error codes to what the UI does. */
export function classify(err: ApiError): UiAction {
  if (err.status === 0) return { kind: 'connection', source: err.source, message: err.message };
  if (TOKEN_CODES.has(err.code)) {
    return err.source === 'harness' ? { kind: 'harness-token-rejected' } : { kind: 'login' };
  }
  if (err.code === 'session_not_found') return { kind: 'session-gone' };
  if (err.code === 'endpoint_unresolved')
    return { kind: 'endpoint-unresolved', message: err.message };
  if (err.source === 'harness' && err.status === 503 && err.retryAfterS !== undefined) {
    return { kind: 'retry-after', seconds: err.retryAfterS };
  }
  if (UNAVAILABLE.has(err.code) || err.status >= 500)
    return { kind: 'unavailable', source: err.source };
  return { kind: 'show', message: err.message };
}
