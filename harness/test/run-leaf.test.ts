import { describe, it, expect, vi } from "vitest";

// realProduceVerdict (exercised via the exported runLeaf() below, with no `deps.produceVerdict`
// override) drives real Redis/Pi/model machinery in production. Mock those module boundaries so
// the transport-wiring tests stay hermetic — mirrors the whole-module vi.mock style already used
// for @sh/harness/run-leaf in packages/knative-server/test/run-leaf-route.test.ts.
// vi.mock factories are hoisted above the rest of this module, so any value a factory returns
// DIRECTLY (as opposed to referencing lazily inside a closure) must already be initialized by
// the time the hoisted factory runs. vi.hoisted() runs its callback as part of that same hoisted
// block, in declaration order, so classes/spies built there are safe to return directly below.
const { selectPoolSandboxMock, FakeSandboxPoolSaturatedError } = vi.hoisted(() => {
  class FakeSandboxPoolSaturatedError extends Error {
    constructor(selector: string) {
      super(`sandbox pool '${selector}' saturated: all pods at capacity`);
      this.name = "SandboxPoolSaturatedError";
    }
  }
  return { selectPoolSandboxMock: vi.fn(), FakeSandboxPoolSaturatedError };
});
vi.mock("../src/select-sandbox.js", () => ({
  selectPoolSandbox: (...args: unknown[]) => selectPoolSandboxMock(...args),
  SandboxPoolSaturatedError: FakeSandboxPoolSaturatedError,
}));

const { k8sSandboxExtensionMock, kubectlTransportMock } = vi.hoisted(() => ({
  k8sSandboxExtensionMock: vi.fn(() => () => {}),
  kubectlTransportMock: vi.fn(() => ({
    exec: vi.fn(async () => ({ stdout: Buffer.from(""), exitCode: 0 })),
    close: vi.fn(async () => {}),
  })),
}));
vi.mock("@sh/k8s-sandbox", () => ({
  k8sSandboxExtension: (...args: unknown[]) => k8sSandboxExtensionMock(...args),
  KubectlTransport: (...args: unknown[]) => kubectlTransportMock(...args),
}));

const { FakeRedisSessionBackend } = vi.hoisted(() => {
  class FakeRedisSessionBackend {
    async read(_sid: string) { return []; }
    async latestWhere(_sid: string, _pred: unknown) { return null; }
    async append(_sid: string, _entry: unknown, _piType: string) { return {}; }
    async list() { return []; }
    async close() {}
  }
  return { FakeRedisSessionBackend };
});
vi.mock("@sh/session-backend", () => ({
  RedisSessionBackend: FakeRedisSessionBackend,
}));

const { FakeSessionManager, FakeResourceLoader, createAgentSessionMock } = vi.hoisted(() => {
  class FakeSessionManager {
    constructor(private sid: string) {}
    getSessionId() { return this.sid; }
    appendCustomEntry(_type: string, _data?: unknown) { return "entry-id"; }
  }
  class FakeResourceLoader {
    constructor(public opts: unknown) {}
    async reload() {}
  }
  return {
    FakeSessionManager,
    FakeResourceLoader,
    createAgentSessionMock: vi.fn(async () => ({ session: { prompt: async () => {} } })),
  };
});
vi.mock("@earendil-works/pi-coding-agent", () => ({
  createAgentSession: (...args: unknown[]) => createAgentSessionMock(...args),
  DefaultResourceLoader: FakeResourceLoader,
  getAgentDir: () => "/fake/agent-dir",
  SessionManager: {
    create: (_cwd: string, _snapshot: unknown, opts: { id: string }) => new FakeSessionManager(opts.id),
    openFromCheckpoint: async (sid: string) => new FakeSessionManager(sid),
  },
  SettingsManager: { create: () => ({}) },
}));

import { runLeaf, buildLeafPrompt, buildSolvePrompt, leafSessionId, validateItem } from "../src/run-leaf.js";
import type { LeafEnvelope } from "../src/run-leaf.js";
import { SandboxPoolSaturatedError } from "../src/select-sandbox.js";

describe("LeafEnvelope repo ref fields", () => {
  it("accepts optional repoUrl and ref", () => {
    const env: LeafEnvelope = {
      sessionId: "run-a/item-1",
      item: { item_id: "item-1", file: "a.ts", pattern: "x" },
      repoUrl: "https://git.example/r.git",
      ref: "abc123",
    };
    expect(env.repoUrl).toBe("https://git.example/r.git");
    expect(env.ref).toBe("abc123");
  });
});

describe("validateItem", () => {
  it("accepts a well-formed item", () => {
    expect(validateItem({ item_id: "i", file: "f", pattern: "p" })).toEqual({ item_id: "i", file: "f", pattern: "p", require_approval: false });
  });
  it("rejects a missing field and non-objects", () => {
    expect(validateItem({ item_id: "i", file: "f" })).toBeNull();
    expect(validateItem(null)).toBeNull();
  });
});

describe("buildLeafPrompt", () => {
  it("includes the file, pattern, and submit_verdict instruction", () => {
    const p = buildLeafPrompt({ item_id: "i1", file: "a.py", pattern: "eval(" });
    expect(p).toContain("a.py");
    expect(p).toContain("eval(");
    expect(p).toContain("submit_verdict");
  });
});

describe("buildSolvePrompt", () => {
  it("embeds the problem statement and the absolute worktree root", () => {
    const p = buildSolvePrompt("Fix the off-by-one in paginate().", "/workspace/leaves/run-1/");
    expect(p).toContain("Fix the off-by-one in paginate().");
    // trailing slash trimmed; root given as an absolute path
    expect(p).toContain("/workspace/leaves/run-1");
    expect(p).not.toContain("/workspace/leaves/run-1/\n");
    // solve prompt must NOT instruct submit_verdict (that is the converge path)
    expect(p).not.toContain("submit_verdict");
  });
});

describe("runLeaf", () => {
  it("fails with bad_inputs when item is missing", async () => {
    const r = await runLeaf({ sessionId: "s" } as any, undefined, { produceVerdict: async () => {} });
    expect(r).toEqual({ status: "failed", reason: "bad_inputs" });
  });

  it("returns the verdict inline on success", async () => {
    const env = { sessionId: "run/i1", item: { item_id: "i1", file: "f", pattern: "p" } };
    const r = await runLeaf(env, undefined, {
      produceVerdict: async (_i, _e, _c, cap) => { cap.verdict = { item_id: "i1", verdict: "FLAGGED", reason: "x" }; },
    });
    expect(r).toEqual({ status: "done", verdict: { item_id: "i1", verdict: "FLAGGED", reason: "x" } });
  });

  it("returns the gate inline when paused", async () => {
    const env = { sessionId: "run/i1", item: { item_id: "i1", file: "f", pattern: "p", require_approval: true } };
    const r = await runLeaf(env, undefined, {
      produceVerdict: async (_i, _e, _c, cap) => { cap.gate = { gateId: 2, summary: "s", proposed_action: "a" }; },
    });
    expect(r).toEqual({ status: "paused", gateId: 2, gate: { summary: "s", proposed_action: "a" } });
  });

  it("returns aborted when the capture is aborted", async () => {
    const env = { sessionId: "run/i1", item: { item_id: "i1", file: "f", pattern: "p" } };
    const r = await runLeaf(env, undefined, { produceVerdict: async (_i, _e, _c, cap) => { cap.aborted = true; } });
    expect(r).toEqual({ status: "aborted" });
  });

  it("fails with no_verdict when nothing is captured", async () => {
    const env = { sessionId: "run/i1", item: { item_id: "i1", file: "f", pattern: "p" } };
    const r = await runLeaf(env, undefined, { produceVerdict: async () => {} });
    expect(r).toEqual({ status: "failed", reason: "no_verdict" });
  });

  it("fails with invalid_verdict when the captured verdict is off-shape", async () => {
    const env = { sessionId: "run/i1", item: { item_id: "i1", file: "f", pattern: "p" } };
    const r = await runLeaf(env, undefined, { produceVerdict: async (_i, _e, _c, cap) => { cap.verdict = { item_id: "i1", verdict: "MAYBE", reason: "x" } as any; } });
    expect(r.status).toBe("failed");
    if (r.status === "failed") expect(r.reason).toBe("invalid_verdict");
  });

  it("returns failed:error when produceVerdict throws", async () => {
    const env = { sessionId: "run/i1", item: { item_id: "i1", file: "f", pattern: "p" } };
    const produceVerdict = async () => { throw new Error("boom"); };
    const r = await runLeaf(env, undefined, { produceVerdict });
    expect(r.status).toBe("failed");
    if (r.status === "failed") expect(r.reason).toBe("error");
  });

  it("returns failed:saturated (not error) when the pool is saturated", async () => {
    // Distinguishing saturation from a generic error lets the sync /runs path implement the
    // spec §4.3 bounded-wait + 503 Retry-After behavior without touching the async path.
    const env = { sessionId: "run/i1", item: { item_id: "i1", file: "f", pattern: "p" } };
    const produceVerdict = async () => { throw new SandboxPoolSaturatedError("pool=x"); };
    const r = await runLeaf(env, undefined, { produceVerdict });
    expect(r.status).toBe("failed");
    if (r.status === "failed") expect(r.reason).toBe("saturated");
  });
});

describe("leafSessionId", () => {
  it("sanitizes the bare sessionId when no tenant is set", () => {
    expect(leafSessionId({ sessionId: "run-1/i1" })).toBe("run-1-i1");
  });
  it("prefixes and sanitizes with the tenant for per-tenant id isolation", () => {
    expect(leafSessionId({ sessionId: "run-1/i1", tenant: "acme" })).toBe("acme-run-1-i1");
  });
});

describe("realProduceVerdict transport wiring (Task 9)", () => {
  const FAKE_CONFIG = { pod: "sandbox-0", namespace: "default", context: undefined, podCwd: "/workspace", headCwd: "/head" };

  it("pod path: builds a fresh KubectlTransport per phase and passes no transport to the extension", async () => {
    selectPoolSandboxMock.mockReset().mockResolvedValue({
      config: FAKE_CONFIG,
      heartbeat: vi.fn(async () => {}),
      release: vi.fn(async () => {}),
    });
    kubectlTransportMock.mockClear();
    k8sSandboxExtensionMock.mockClear();

    const env: LeafEnvelope = {
      sessionId: "run/pod-1",
      item: { item_id: "i1", file: "f", pattern: "p" },
      repoUrl: "https://git.example/r.git",
      ref: "abc123",
    };
    await runLeaf(env);

    // Built once for converge and once for cleanup — the pod path never shares a transport
    // across phases, exactly like the pre-Task-9 code.
    expect(kubectlTransportMock).toHaveBeenCalledTimes(2);
    for (const call of kubectlTransportMock.mock.calls) expect(call[0]).toBe(FAKE_CONFIG);
    // Each per-phase transport is closed once, right after its own phase.
    for (const result of kubectlTransportMock.mock.results) {
      expect(result.value.close).toHaveBeenCalledTimes(1);
    }

    expect(k8sSandboxExtensionMock).toHaveBeenCalledWith({ config: FAKE_CONFIG, transport: undefined });
  });

  it("uses a request-scoped sandbox pool selector", async () => {
    selectPoolSandboxMock.mockReset().mockResolvedValue({
      config: FAKE_CONFIG,
      heartbeat: vi.fn(async () => {}),
      release: vi.fn(async () => {}),
    });

    await runLeaf({
      sessionId: "run/workload-1",
      sandboxPoolSelector: "sh.kagenti.io/sandbox-pool=workload-1",
      item: { item_id: "i1", file: "f", pattern: "p" },
    });

    expect(selectPoolSandboxMock).toHaveBeenCalledWith(
      expect.objectContaining({ KAGENTI_SANDBOX_POOL_SELECTOR: "sh.kagenti.io/sandbox-pool=workload-1" }),
      expect.any(String),
      expect.any(String),
      expect.any(Object),
    );
  });

  it("grpc path: reuses selected.transport for converge + cleanup and closes it exactly once", async () => {
    const close = vi.fn(async () => {});
    const transport = {
      exec: vi.fn(async () => ({ stdout: Buffer.from(""), exitCode: 0 })),
      close,
    };
    selectPoolSandboxMock.mockReset().mockResolvedValue({
      config: FAKE_CONFIG,
      transport,
      heartbeat: vi.fn(async () => {}),
      release: vi.fn(async () => {}),
    });
    kubectlTransportMock.mockClear();
    k8sSandboxExtensionMock.mockClear();

    const env: LeafEnvelope = {
      sessionId: "run/grpc-1",
      item: { item_id: "i1", file: "f", pattern: "p" },
      repoUrl: "https://git.example/r.git",
      ref: "abc123",
    };
    await runLeaf(env);

    // The shared transport serves both converge and cleanup — KubectlTransport is never built.
    expect(kubectlTransportMock).not.toHaveBeenCalled();
    expect(transport.exec).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(1);
    expect(k8sSandboxExtensionMock).toHaveBeenCalledWith({ config: FAKE_CONFIG, transport });
  });
});

describe("buildLeafPrompt with require_approval", () => {
  it("adds a request_approval instruction when the item requires approval", () => {
    const p = buildLeafPrompt({ item_id: "i1", file: "a.py", pattern: "eval(", require_approval: true });
    expect(p).toContain("request_approval");
  });
  it("withholds the submit_verdict instruction in the gated turn (verdict comes after approval)", () => {
    const p = buildLeafPrompt({ item_id: "i1", file: "a.py", pattern: "eval(", require_approval: true });
    expect(p).not.toContain("submit_verdict");
  });
  it("omits the gate instruction by default", () => {
    const p = buildLeafPrompt({ item_id: "i1", file: "a.py", pattern: "eval(" });
    expect(p).not.toContain("request_approval");
  });
});

describe("runLeaf — solve routing", () => {
  const base: LeafEnvelope = {
    sessionId: "run-1", item: { item_id: "x", file: "f", pattern: "p" },
    kind: "solve", problemStatement: "do the thing", repoUrl: "git://x/repo.git", ref: "work",
  };
  it("maps a captured patch to status solved", async () => {
    const r = await runLeaf(base, undefined, { produceSolve: async (_e, _c, cap) => { cap.patch = "PATCH"; } });
    expect(r).toEqual({ status: "solved", patch: "PATCH" });
  });
  it("treats an unset patch as an empty (still solved) patch", async () => {
    const r = await runLeaf(base, undefined, { produceSolve: async () => { /* no edits */ } });
    expect(r).toEqual({ status: "solved", patch: "" });
  });
  it("fails bad_inputs when problemStatement/repoUrl/ref are missing", async () => {
    const r = await runLeaf({ sessionId: "s", item: base.item, kind: "solve" });
    expect(r).toEqual({ status: "failed", reason: "bad_inputs" });
  });
  it("maps pool saturation to a saturated failure", async () => {
    const r = await runLeaf(base, undefined, {
      produceSolve: async () => { throw new SandboxPoolSaturatedError("full"); },
    });
    expect(r.status).toBe("failed");
    expect((r as { reason?: string }).reason).toBe("saturated");
  });
});

it("solve without env_key uses convergeWorkspace, not swebench setup", async () => {
  // produceSolve is injectable; assert the swebench branch is NOT taken when env_key is absent.
  // (Structural: import isSwebenchEnvelope and check the predicate.)
  const { isSwebenchEnvelope } = await import("../src/run-leaf.js");
  expect(isSwebenchEnvelope({ kind: "solve", problemStatement: "x", repoUrl: "git://h/r.git", ref: "main" })).toBe(false);
  expect(isSwebenchEnvelope({ kind: "solve", problemStatement: "x", repoUrl: "/repos/a/b.git", ref: "c", env_key: "k:latest" })).toBe(true);
});
