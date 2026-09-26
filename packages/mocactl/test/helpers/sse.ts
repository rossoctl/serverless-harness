export function sseText(frames: Array<{ type: string }>): string {
  return frames.map((f) => `event: ${f.type}\ndata: ${JSON.stringify(f)}\n\n`).join('');
}

export function streamOf(chunks: Array<string | Uint8Array>): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(typeof c === 'string' ? enc.encode(c) : c);
      controller.close();
    },
  });
}

export function sseResponse(chunks: string[], init: ResponseInit = {}): Response {
  return new Response(streamOf(chunks), {
    status: 200,
    ...init,
    headers: { 'content-type': 'text/event-stream', ...(init.headers ?? {}) },
  });
}
