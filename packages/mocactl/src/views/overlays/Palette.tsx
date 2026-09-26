import type { CommandHost } from '../../commands/builtin.js';
import type { Command, CommandRegistry } from '../../commands/registry.js';
import { SelectList } from '../SelectList.js';

interface Props {
  registry: CommandRegistry<CommandHost>;
  host: CommandHost;
  onClose: () => void;
}

export function PaletteOverlay({ registry, host, onClose }: Props) {
  const items = registry.available(host).map((c) => ({
    key: c.id,
    label: c.title,
    detail: [(c.slash ?? []).map((s) => `/${s}`).join(' '), registry.keybindOf(c.id)]
      .filter(Boolean)
      .join('  '),
    value: c,
  }));
  return (
    <SelectList<Command<CommandHost>>
      title="Commands"
      filter="always"
      items={items}
      onCancel={onClose}
      onSelect={(c) => {
        onClose();
        void c.run(host, '');
      }}
    />
  );
}
