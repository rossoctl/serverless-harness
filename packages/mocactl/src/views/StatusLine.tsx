import { Text } from 'ink';
import { useTheme } from '../theme/context.js';
import { fitStatus, type StatusField } from './status.js';

export function StatusLine({ fields, width }: { fields: StatusField[]; width: number }) {
  const { tokens: t } = useTheme();
  const kept = fitStatus(fields, width);
  return (
    <Text wrap="truncate">
      {kept.map((f, i) => (
        <Text key={f.key} color={f.key === 'warning' ? t.warning : t.muted}>
          {i > 0 ? ' · ' : ''}
          {f.text}
        </Text>
      ))}
    </Text>
  );
}
