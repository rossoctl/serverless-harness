import { Box, Text } from 'ink';
import type { JSX } from 'react';
import { sanitizeRemote as safe } from '../core/sanitize.js';
import type { Block } from '../render/blocks.js';
import { buildEditDiff } from '../render/diff.js';
import { renderMarkdown } from '../render/markdown.js';
import { TOOL_RENDERERS, toolSummary, truncate } from '../render/tools.js';
import { useTheme } from '../theme/context.js';
import { formatUsage } from './format.js';
import { Spinner } from './Spinner.js';

const PREVIEW_LINES = 12;

interface Props {
  block: Block;
  details: boolean;
  thinking: boolean;
  width: number;
}

// Every string shown here came from the server (frames) or a transcript of them, so each passes
// through safe() before it reaches the terminal; the theme's colours are applied on top.
export function BlockView({ block, details, thinking, width }: Props) {
  const theme = useTheme();
  const t = theme.tokens;
  switch (block.kind) {
    case 'user':
      return (
        <Box marginTop={1}>
          <Text color={t.primary} bold>
            ›{' '}
          </Text>
          <Text color={t.text}>{safe(block.text)}</Text>
          {block.queued ? <Text color={t.muted}> (queued)</Text> : null}
        </Box>
      );
    case 'assistant':
      return (
        <Box flexDirection="column">
          {thinking && block.thinking ? (
            <Text color={t.muted} italic>
              {safe(block.thinking)}
            </Text>
          ) : null}
          {block.text ? (
            <Text color={t.text}>
              {block.final ? renderMarkdown(block.text, theme, width) : safe(block.text)}
            </Text>
          ) : null}
        </Box>
      );
    case 'tool':
      return <ToolBlock block={block} details={details} width={width} />;
    case 'turn-end':
      if (block.outcome === 'error')
        return <Text color={t.error}>✗ {safe(block.message ?? 'the turn failed')}</Text>;
      if (block.outcome === 'cancelled') return <Text color={t.muted}>■ cancelled</Text>;
      return block.usage ? <Text color={t.muted}>· {formatUsage(block.usage)}</Text> : null;
    case 'event':
      return (
        <Text color={t.muted}>
          • {safe(block.label)}{' '}
          {truncate(
            safe(JSON.stringify(block.data) ?? ''),
            Math.max(20, width - block.label.length - 4),
          )}
        </Text>
      );
    case 'notice':
      return (
        <Text
          color={block.tone === 'error' ? t.error : block.tone === 'warning' ? t.warning : t.info}
        >
          {safe(block.text)}
        </Text>
      );
  }
}

// Shared by the tool preview and the generic-args JSON dump: render up to `shown.length` lines
// (the caller has already applied the cap), each truncated to the render width, plus a trailing
// "N more lines" note in the theme's muted colour when the caller found more than it kept.
function CappedLines({
  shown,
  hiddenCount,
  maxWidth,
  lineColor,
}: {
  shown: string[];
  hiddenCount: number;
  maxWidth: number;
  lineColor?: string;
}) {
  const { tokens: t } = useTheme();
  return (
    <Box flexDirection="column" marginLeft={2}>
      {shown.map((l, i) => (
        <Text key={i} color={lineColor}>
          {truncate(safe(l), maxWidth)}
        </Text>
      ))}
      {hiddenCount > 0 ? <Text color={t.muted}>… {hiddenCount} more lines</Text> : null}
    </Box>
  );
}

function ToolBlock({
  block,
  details,
  width,
}: {
  block: Extract<Block, { kind: 'tool' }>;
  details: boolean;
  width: number;
}) {
  const { tokens: t } = useTheme();
  const summary = truncate(safe(toolSummary(block.name, block.args)), Math.max(20, width - 2));
  const maxLineWidth = Math.max(20, width - 4);
  const r = block.result;
  const head = r ? (
    <Text>
      <Text color={r.isError ? t.error : t.success}>{r.isError ? '✗' : '✓'}</Text>
      <Text color={t.text}> {summary}</Text>
    </Text>
  ) : (
    <Spinner label={summary} />
  );

  // Spec §5.5: an edit renders as a diff when expanded, regardless of outcome.
  let diffBody: JSX.Element | null = null;
  if (details && block.name === 'edit') {
    const diff = buildEditDiff(block.args);
    if (diff) {
      diffBody = (
        <Box flexDirection="column" marginLeft={2}>
          {diff.lines.map((l, i) =>
            l.kind === 'hunk' ? (
              <Text key={i} color={t.info}>
                {truncate(safe(l.text), maxLineWidth)}
              </Text>
            ) : (
              <Text
                key={i}
                color={l.kind === 'add' ? t.diffAdd : l.kind === 'remove' ? t.diffRemove : t.muted}
              >
                {truncate(
                  (l.kind === 'add' ? '+ ' : l.kind === 'remove' ? '- ' : '  ') + safe(l.text),
                  maxLineWidth,
                )}
              </Text>
            ),
          )}
        </Box>
      );
    }
  }

  // Spec §5.5 "anything else" row: a tool with no dedicated renderer shows its args as
  // pretty-printed JSON when expanded, ahead of the preview.
  let argsBody: JSX.Element | null = null;
  if (details && !TOOL_RENDERERS[block.name]) {
    let json: string | undefined;
    try {
      json = JSON.stringify(block.args, null, 2);
    } catch {
      json = undefined;
    }
    if (json !== undefined) {
      const lines = json.split('\n');
      const shown = lines.slice(0, PREVIEW_LINES);
      argsBody = (
        <CappedLines
          shown={shown}
          hiddenCount={lines.length - shown.length}
          maxWidth={maxLineWidth}
          lineColor={t.muted}
        />
      );
    }
  }

  // An error always shows its preview, even alongside a diff; a settled edit that isn't an error
  // shows the diff instead of the raw preview text.
  let previewBody: JSX.Element | null = null;
  if (r && (details || r.isError) && (!diffBody || r.isError)) {
    const lines = r.preview.split('\n');
    const shown = details ? lines.slice(0, PREVIEW_LINES) : lines.slice(0, 1);
    previewBody = (
      <CappedLines
        shown={shown}
        hiddenCount={details ? lines.length - shown.length : 0}
        maxWidth={maxLineWidth}
        lineColor={r.isError ? t.error : t.muted}
      />
    );
  }

  return (
    <Box flexDirection="column">
      {head}
      {argsBody}
      {previewBody}
      {diffBody}
    </Box>
  );
}
