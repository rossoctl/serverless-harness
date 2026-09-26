// Mirrors harness/src/turn-stream.ts's TurnStreamFrame. Redeclared, not imported (spec §3.1);
// test/contract.test.ts keeps the two in step.
export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export type TextFrame = { type: 'text'; delta: string };
export type ThinkingFrame = { type: 'thinking'; delta: string };
export type ToolUseFrame = { type: 'tool_use'; id: string; name: string; args: unknown };
export type ToolResultFrame = {
  type: 'tool_result';
  id: string;
  isError: boolean;
  preview: string;
};
export type DoneFrame = { type: 'done'; sessionId: string; stopReason: string; usage?: Usage };
export type ErrorFrame = {
  type: 'error';
  sessionId: string;
  stopReason: string;
  errorMessage?: string;
  usage?: Usage;
};
export type UnknownFrame = { type: 'unknown'; event: string; data: unknown };

export type TurnFrame =
  | TextFrame
  | ThinkingFrame
  | ToolUseFrame
  | ToolResultFrame
  | DoneFrame
  | ErrorFrame
  | UnknownFrame;

export const KNOWN_FRAME_TYPES = [
  'text',
  'thinking',
  'tool_use',
  'tool_result',
  'done',
  'error',
] as const;

export function isTerminal(f: TurnFrame): f is DoneFrame | ErrorFrame {
  return f.type === 'done' || f.type === 'error';
}
