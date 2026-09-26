import { describe, expect, it } from 'vitest';
import { ApiError, TurnCancelledError } from '../src/api/errors.js';
import type { TurnFrame } from '../src/api/frames.js';
import { HarnessClient } from '../src/api/harness.js';
import { json, scriptedFetch } from './helpers/fake-fetch.js';
import { sseResponse, sseText } from './helpers/sse.js';

const done = { type: 'done', sessionId: 's1', stopReason: 'end_turn' };

async function collect(it: AsyncGenerator<TurnFrame>): Promise<TurnFrame[]> {
  const out: TurnFrame[] = [];
  for await (const f of it) out.push(f);
  return out;
}

describe('HarnessClient.streamTurn', () => {
  it('posts to /v1/turn with SSE accept and the session token', async () => {
    const { fetch, calls } = scriptedFetch(
      sseResponse([
        sseText([
          { type: 'text', delta: 'hi' },
          { type: 'done', sessionId: 's1', stopReason: 'end_turn' },
        ] as any[]),
      ]),
    );
    const frames = await collect(
      new HarnessClient('http://h/', fetch).streamTurn({
        sessionId: 's1',
        prompt: 'p',
        token: 'st',
      }),
    );
    expect(frames.map((f) => f.type)).toEqual(['text', 'done']);
    expect(calls[0]).toMatchObject({
      url: 'http://h/v1/turn',
      method: 'POST',
      body: { sessionId: 's1', prompt: 'p' },
    });
    expect(calls[0].headers.accept).toBe('text/event-stream');
    expect(calls[0].headers.authorization).toBe('Bearer st');
  });

  it('stops at the terminal frame even if more bytes follow', async () => {
    const { fetch } = scriptedFetch(
      sseResponse([
        sseText([
          { type: 'done', sessionId: 's1', stopReason: 'end_turn' },
          { type: 'text', delta: 'late' },
        ] as any[]),
      ]),
    );
    const frames = await collect(
      new HarnessClient('http://h', fetch).streamTurn({ sessionId: 's1', prompt: 'p', token: 't' }),
    );
    expect(frames).toHaveLength(1);
  });

  it('throws a typed error before any frame on a non-2xx response', async () => {
    const { fetch } = scriptedFetch(json({ error: 'saturated' }, 503, { 'retry-after': '5' }));
    const err = await collect(
      new HarnessClient('http://h', fetch).streamTurn({ sessionId: 's', prompt: 'p', token: 't' }),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({
      source: 'harness',
      status: 503,
      code: 'saturated',
      retryAfterS: 5,
    });
  });

  it('ends with stream_truncated when the stream closes early', async () => {
    const { fetch } = scriptedFetch(
      sseResponse([sseText([{ type: 'text', delta: 'partial' }] as any[])]),
    );
    const seen: TurnFrame[] = [];
    const err = await (async () => {
      for await (const f of new HarnessClient('http://h', fetch).streamTurn({
        sessionId: 's',
        prompt: 'p',
        token: 't',
      }))
        seen.push(f);
    })().catch((e) => e);
    expect(seen).toHaveLength(1);
    expect(err).toMatchObject({ code: 'stream_truncated', status: 0, source: 'harness' });
    expect(err.message).toBe('the harness closed the stream before the turn finished');
  });

  it('synthesizes frames from a plain JSON reply', async () => {
    const { fetch } = scriptedFetch(
      json({ sessionId: 's1', response: 'hello', stopReason: 'end_turn' }),
    );
    const frames = await collect(
      new HarnessClient('http://h', fetch).streamTurn({ sessionId: 's1', prompt: 'p', token: 't' }),
    );
    expect(frames).toEqual([
      { type: 'text', delta: 'hello' },
      { type: 'done', sessionId: 's1', stopReason: 'end_turn' },
    ]);
  });

  it('throws TurnCancelledError when aborted before the response', async () => {
    const ac = new AbortController();
    ac.abort();
    const { fetch } = scriptedFetch(new DOMException('aborted', 'AbortError'));
    const err = await collect(
      new HarnessClient('http://h', fetch).streamTurn({
        sessionId: 's',
        prompt: 'p',
        token: 't',
        signal: ac.signal,
      }),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(TurnCancelledError);
  });
});

describe('HarnessClient.probeTrust', () => {
  it('reports trusted on session_mismatch, sending a mismatched id', async () => {
    const { fetch, calls } = scriptedFetch(json({ error: 'session_mismatch' }, 400));
    expect(await new HarnessClient('http://h', fetch).probeTrust('st', 's1')).toBe('trusted');
    expect(calls[0].body.sessionId).not.toBe('s1');
    expect(calls[0].headers.authorization).toBe('Bearer st');
  });

  it.each([
    [json({ error: 'token_invalid' }, 401)],
    [json({ error: 'session_not_found' }, 404)],
    [json({ sessionId: 'x', response: 'ran', stopReason: 'end_turn' }, 200)],
  ])('reports untrusted for %#', async (res) => {
    const { fetch } = scriptedFetch(res);
    expect(await new HarnessClient('http://h', fetch).probeTrust('st', 's1')).toBe('untrusted');
  });

  it('throws on an unrelated server error', async () => {
    const { fetch } = scriptedFetch(json({ error: 'internal_error' }, 500));
    await expect(
      new HarnessClient('http://h', fetch).probeTrust('st', 's1'),
    ).rejects.toBeInstanceOf(ApiError);
  });
});

describe('HarnessClient.health', () => {
  it('GETs /health', async () => {
    const { fetch, calls } = scriptedFetch(new Response('ok'));
    await new HarnessClient('http://h', fetch).health();
    expect(calls[0]).toMatchObject({ url: 'http://h/health', method: 'GET' });
  });
});
