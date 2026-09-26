// Spec §7.1: one table drives slash commands, leader keys, the palette and /help, so they cannot
// disagree.

export interface Command<Ctx> {
  id: string;
  title: string;
  slash?: string[];
  keybind?: string;
  when?: (ctx: Ctx) => boolean;
  run: (ctx: Ctx, arg: string) => void | Promise<void>;
}

export function normalizeKeybind(k: string): string {
  return k.trim().toLowerCase().split(/\s+/).join(' ');
}

export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!q) return 0;
  let from = 0;
  let prev = -2;
  let score = 0;
  for (const ch of q) {
    const i = t.indexOf(ch, from);
    if (i === -1) return null;
    score += i === prev + 1 ? 3 : 1;
    if (i === 0 || t[i - 1] === ' ' || t[i - 1] === '/') score += 2;
    prev = i;
    from = i + 1;
  }
  return score - t.length * 0.01;
}

export class CommandRegistry<Ctx> {
  readonly conflicts: string[] = [];
  private readonly bindings = new Map<string, string>(); // keybind -> command id
  private readonly byId = new Map<string, Command<Ctx>>();
  private readonly slashes = new Map<string, Command<Ctx>>();

  constructor(
    private readonly commands: Command<Ctx>[],
    overrides: Record<string, string> = {},
  ) {
    for (const c of commands) {
      this.byId.set(c.id, c);
      for (const s of c.slash ?? []) this.slashes.set(s.toLowerCase(), c);
    }
    for (const id of Object.keys(overrides)) {
      if (!this.byId.has(id)) this.conflicts.push(`keybind override for unknown command "${id}"`);
    }
    // User overrides are placed first so they win any collision with a default binding.
    const effective = [
      ...commands.filter((c) => c.id in overrides).map((c) => [c.id, overrides[c.id]] as const),
      ...commands
        .filter((c) => !(c.id in overrides) && c.keybind)
        .map((c) => [c.id, c.keybind!] as const),
    ];
    for (const [id, raw] of effective) {
      if (!raw) continue;
      const kb = normalizeKeybind(raw);
      const holder = this.bindings.get(kb);
      if (holder) {
        this.conflicts.push(`${kb} is bound to both ${holder} and ${id}; keeping ${holder}`);
        continue;
      }
      this.bindings.set(kb, id);
    }
  }

  keybindOf(id: string): string | undefined {
    for (const [kb, holder] of this.bindings) if (holder === id) return kb;
    return undefined;
  }

  bySlash(input: string): { command: Command<Ctx>; arg: string } | undefined {
    const m = /^\/(\S+)\s*([\s\S]*)$/.exec(input.trim());
    if (!m) return undefined;
    const command = this.slashes.get(m[1].toLowerCase());
    return command ? { command, arg: m[2].trim() } : undefined;
  }

  byKeybind(chord: string): Command<Ctx> | undefined {
    const id = this.bindings.get(normalizeKeybind(chord));
    return id ? this.byId.get(id) : undefined;
  }

  available(ctx: Ctx): Command<Ctx>[] {
    return this.commands.filter((c) => !c.when || c.when(ctx));
  }

  search(query: string, ctx: Ctx): Command<Ctx>[] {
    return this.available(ctx)
      .map((c) => ({
        c,
        score: fuzzyScore(query, [c.title, ...(c.slash ?? []).map((s) => `/${s}`)].join(' ')),
      }))
      .filter((x): x is { c: Command<Ctx>; score: number } => x.score !== null)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.c);
  }

  help(ctx: Ctx): Array<{ title: string; slash: string; keybind: string }> {
    return this.available(ctx).map((c) => ({
      title: c.title,
      slash: (c.slash ?? []).map((s) => `/${s}`).join(', '),
      keybind: this.keybindOf(c.id) ?? '',
    }));
  }
}
