import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { runTurn, type TurnConfig } from "@sh/harness/run-turn";
import { runLeaf, leafSessionId, validateItem, type LeafEnvelope, type LeafResult } from "@sh/harness/run-leaf";
import { RedisWorkQueue } from "@sh/work-queue";
import { RedisResultStore, toResultRecord, writeResult, readResult } from "@sh/harness/leaf-result-store";

const PORT = parseInt(process.env.PORT || "8080", 10);
const JSON_HEADERS = { "Content-Type": "application/json" };
const RESULT_TTL_SECONDS = parseInt(process.env.LEAF_RESULT_TTL_SECONDS ?? "86400", 10);

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Parse an integer env knob, falling back to `def` when unset or malformed. Without the finite
// guard a typo (e.g. WAIT_MS=abc) yields NaN, which poisons `Date.now() < deadline` (always false,
// skipping the bounded wait) and emits "Retry-After: NaN"; negatives are rejected for the same reason.
function intEnv(name: string, def: number): number {
  const raw = process.env[name];
  if (raw === undefined) return def;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : def;
}

// Spec §4.3 sync-path saturation handling: how long to bound-wait (re-attempting pool acquisition
// with exponential backoff) before returning 503, and what Retry-After to advertise. Read per
// request so overrides take effect without a restart (and so tests can shrink the budget).
function saturationWaitConfig() {
  return {
    waitMs: intEnv("KAGENTI_SYNC_SATURATION_WAIT_MS", 30000),
    backoffMs: intEnv("KAGENTI_SYNC_SATURATION_BACKOFF_MS", 250),
    maxBackoffMs: intEnv("KAGENTI_SYNC_SATURATION_MAX_BACKOFF_MS", 5000),
    retryAfterS: intEnv("KAGENTI_SYNC_SATURATION_RETRY_AFTER_S", 5),
  };
}

const isSaturated = (r: LeafResult): boolean => r.status === "failed" && r.reason === "saturated";

function buildConfig(): TurnConfig {
  return {
    redisUrl: process.env.REDIS_URL,
    cwd: process.env.HARNESS_CWD || process.cwd(),
    anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL,
    anthropicAuthToken: process.env.ANTHROPIC_AUTH_TOKEN,
  };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

async function handleTurn(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: string;
  try {
    body = await readBody(req);
  } catch {
    res.writeHead(400, JSON_HEADERS).end(JSON.stringify({ error: "read_error" }));
    return;
  }

  let parsed: { sessionId?: string; prompt?: string };
  try {
    parsed = JSON.parse(body);
  } catch {
    res.writeHead(400, JSON_HEADERS).end(JSON.stringify({ error: "invalid_json" }));
    return;
  }

  const { sessionId, prompt } = parsed;
  if (!prompt) {
    res.writeHead(400, JSON_HEADERS).end(JSON.stringify({ error: "prompt_required" }));
    return;
  }

  try {
    const result = await runTurn(prompt, sessionId, buildConfig());
    res.writeHead(200, JSON_HEADERS).end(JSON.stringify(result));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message.includes("no session in backend") ? 404 : 500;
    res.writeHead(status, JSON_HEADERS).end(
      JSON.stringify({
        error: status === 404 ? "session_not_found" : message,
        ...(sessionId ? { sessionId } : {}),
      }),
    );
  }
}

export function isLeafEnvelope(o: any): o is LeafEnvelope {
  return o && typeof o.sessionId === "string" && validateItem(o.item) !== null;
}

export function isSolveEnvelope(o: any): boolean {
  return o && typeof o.sessionId === "string" && o.kind === "solve"
    && typeof o.problemStatement === "string"
    && typeof o.repoUrl === "string" && typeof o.ref === "string";
}

export function isRunEnvelope(o: any): boolean {
  return isLeafEnvelope(o) || isSolveEnvelope(o);
}

let queue: RedisWorkQueue | undefined;
function getQueue(): RedisWorkQueue {
  if (!queue) queue = new RedisWorkQueue(process.env.REDIS_URL);
  return queue;
}

let resultStore: RedisResultStore | undefined;
function getResultStore(): RedisResultStore {
  if (!resultStore) resultStore = new RedisResultStore(process.env.REDIS_URL);
  return resultStore;
}

async function handleEnqueueLeafParsed(body: any, res: ServerResponse): Promise<void> {
  if (!isRunEnvelope(body)) { res.writeHead(400, JSON_HEADERS).end(JSON.stringify({ error: "envelope_invalid" })); return; }
  const q = getQueue();
  await q.ensureGroup();
  await q.enqueue(body);
  res.writeHead(202, JSON_HEADERS).end(JSON.stringify({ status: "accepted", sessionId: body.sessionId }));
}

async function handleRunLeafParsed(body: any, _raw: string, res: ServerResponse): Promise<void> {
  if (!isRunEnvelope(body)) { res.writeHead(400, JSON_HEADERS).end(JSON.stringify({ error: "envelope_invalid" })); return; }

  // Spec §4.3: on pool saturation the sync path bounded-waits with backoff, then 503 Retry-After.
  // selectPoolSandbox throws before taking any lease or doing agent work, so re-running runLeaf on a
  // "saturated" result only re-attempts acquisition — the preceding steps (validate, model resolve,
  // Redis verdict fast-path) are idempotent. The async path is untouched (queue drains as leases free).
  const cfg = saturationWaitConfig();
  const deadline = Date.now() + cfg.waitMs;
  let delay = cfg.backoffMs;
  let result = await runLeaf(body, buildConfig());
  while (isSaturated(result) && Date.now() < deadline) {
    await sleep(Math.min(delay, Math.max(0, deadline - Date.now())));
    delay = Math.min(delay * 2, cfg.maxBackoffMs);
    result = await runLeaf(body, buildConfig());
  }

  if (isSaturated(result)) {
    // Still saturated after the budget: tell the client to retry. Do NOT persist a result record —
    // a 503 is "retry", not a terminal failure, and /runs/status must not report it as one.
    res.writeHead(503, { ...JSON_HEADERS, "Retry-After": String(cfg.retryAfterS) })
      .end(JSON.stringify({ status: "failed", reason: "saturated" }));
    return;
  }

  await writeResult(getResultStore(), leafSessionId(body), toResultRecord(result, body.sessionId, new Date().toISOString()), RESULT_TTL_SECONDS);
  res.writeHead(200, JSON_HEADERS).end(JSON.stringify(result));
}

async function handleLeafStatus(url: URL, res: ServerResponse): Promise<void> {
  const sessionId = url.searchParams.get("sessionId");
  if (!sessionId) { res.writeHead(400, JSON_HEADERS).end(JSON.stringify({ error: "sessionId_required" })); return; }
  const tenant = url.searchParams.get("tenant") ?? undefined;
  const record = await readResult(getResultStore(), leafSessionId({ sessionId, tenant }));
  if (!record) { res.writeHead(200, JSON_HEADERS).end(JSON.stringify({ status: "queued" })); return; }
  if (record.status === "done") { res.writeHead(200, JSON_HEADERS).end(JSON.stringify({ status: "done", verdict: record.verdict })); return; }
  if (record.status === "solved") { res.writeHead(200, JSON_HEADERS).end(JSON.stringify({ status: "solved", patch: record.patch })); return; }
  if (record.status === "paused") { res.writeHead(200, JSON_HEADERS).end(JSON.stringify({ status: "paused", gateId: record.gate?.gateId, gate: record.gate })); return; }
  if (record.status === "failed") { res.writeHead(200, JSON_HEADERS).end(JSON.stringify({ status: "failed", reason: record.reason ?? undefined })); return; }
  res.writeHead(200, JSON_HEADERS).end(JSON.stringify({ status: record.status }));
}

// Pre-rename wire paths kept as aliases (issue #37). The public execution route is now the
// industry-standard "run" noun (`/runs`); the internal `runLeaf`/`LeafEnvelope` vocabulary is
// unchanged. Aliases warn once per path and are removed in a later release.
const DEPRECATED_ROUTE_ALIASES: Record<string, string> = {
  "/run-leaf": "/runs",
  "/run-leaf/status": "/runs/status",
};
const warnedDeprecatedRoutes = new Set<string>();
function warnDeprecatedRoute(oldPath: string): void {
  if (warnedDeprecatedRoutes.has(oldPath)) return;
  warnedDeprecatedRoutes.add(oldPath);
  console.warn(
    `[deprecation] ${oldPath} is deprecated and will be removed in a future release; use ${DEPRECATED_ROUTE_ALIASES[oldPath]} instead`,
  );
}

function handler(req: IncomingMessage, res: ServerResponse): void {
  const url = req.url ?? "";

  if (req.method === "GET" && url === "/health") {
    res.writeHead(200).end("ok");
    return;
  }

  // Run-status endpoint: canonical `/runs/status`, plus the deprecated `/run-leaf/status` alias.
  if (req.method === "GET" && (url.startsWith("/runs/status") || url.startsWith("/run-leaf/status"))) {
    if (url.startsWith("/run-leaf/status")) warnDeprecatedRoute("/run-leaf/status");
    handleLeafStatus(new URL(url, "http://localhost"), res).catch((err) => {
      if (!res.headersSent) res.writeHead(500, JSON_HEADERS).end(JSON.stringify({ error: String(err) }));
    });
    return;
  }

  // Run endpoint: canonical `POST /runs`, plus the deprecated `POST /run-leaf` alias.
  if (req.method === "POST" && (url === "/runs" || url === "/run-leaf")) {
    if (url === "/run-leaf") warnDeprecatedRoute("/run-leaf");
    const route = async () => {
      const raw = await readBody(req);
      let parsed: any = {};
      try { parsed = JSON.parse(raw); } catch { /* handled below */ }
      // Pool selection is internal routing state. Never accept a Kubernetes selector directly
      // from an external run request; a workload resolver may add one after this boundary.
      if (parsed && typeof parsed === "object") delete parsed.sandboxPoolSelector;
      if (parsed && parsed.async === true) return handleEnqueueLeafParsed(parsed, res);
      return handleRunLeafParsed(parsed, raw, res);
    };
    route().catch((err) => { if (!res.headersSent) res.writeHead(500, JSON_HEADERS).end(JSON.stringify({ error: String(err) })); });
    return;
  }

  if (req.method === "POST" && req.url === "/turn") {
    handleTurn(req, res).catch((err) => {
      if (!res.headersSent) {
        res.writeHead(500, JSON_HEADERS).end(
          JSON.stringify({ error: String(err) }),
        );
      }
    });
    return;
  }

  res.writeHead(404).end();
}

export function startServer(port = PORT): ReturnType<typeof createServer> {
  const server = createServer(handler);

  process.on("SIGTERM", () => {
    server.close(() => process.exit(0));
  });

  server.listen(port, () => {
    console.log(`serverless-harness listening on :${port}`);
  });

  return server;
}

// Exact entrypoint match (matches cron-dispatch.ts) — avoids a fragile substring
// match that would misfire for any argv path containing "knative-server".
const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  startServer();
}
