import { describe, expect, it } from 'vitest';
import { register } from '../hooks/fast-jev.ts';

type Handler = (...args: any[]) => Promise<any>;

function harness(options: Record<string, unknown>) {
  const handlers = new Map<string, Handler>();
  register(((name: string, fn: Handler) => handlers.set(name, fn)) as any, options as any);
  const calls = { compact: 0, fetch: 0 };
  const $ = {
    session: {
      usage: async () => ({ context: { percent: 99 } }),
      compact: async () => {
        calls.compact++;
      },
      cwd: async () => 'C:/work/dir',
      id: async () => 's1',
      messages: async () => [{ role: 'user', text: 'arregla', toolUses: [] }],
    },
    env: { get: async (n: string) => (n === 'CLAUDE_PROJECT_DIR' ? undefined : 'k') },
    http: {
      fetch: async () => {
        calls.fetch++;
        return { status: 200, ok: true, text: '{}' };
      },
    },
    fs: { write: async () => undefined },
    ui: { log: () => undefined, toast: () => undefined },
  };
  return { handlers, calls, $ };
}

describe('compactación automática apagada', () => {
  it('contexto al 99%: no registra turn.complete, no llama session.compact ni Jev', async () => {
    const { handlers, calls, $ } = harness({ apiKey: 'k' });
    const tc = handlers.get('turn.complete');
    if (tc) await tc($, {}, async (e: unknown) => e);
    expect(tc).toBeUndefined();
    expect(calls.compact).toBe(0);
    expect(calls.fetch).toBe(0);
  });

  it('la poda (tool.call) sigue registrada y poda 10000 caracteres', async () => {
    const { handlers, calls, $ } = harness({ apiKey: 'k' });
    const tool = handlers.get('tool.call');
    expect(tool).toBeDefined();
    const text = Array.from({ length: 700 }, (_, i) => `linea ${String(i).padStart(5, '0')} xx\n`).join('').slice(0, 10000);
    const r = await tool!($, { tool: 'Bash', command: 'cat x', tool_use_id: 'tu1' }, async () => ({
      result: { stdout: text, stderr: '' },
      text,
    }));
    expect(r.result.stdout.length).toBeLessThan(text.length);
    expect(r.result.stdout).toContain('poda Jev');
    expect(calls.compact).toBe(0);
  });

  it('interruptor compactar: true devuelve el hook y compacta al 99%', async () => {
    const { handlers, calls, $ } = harness({ apiKey: 'k', compactar: true });
    const tc = handlers.get('turn.complete');
    expect(tc).toBeDefined();
    await tc!($, {}, async (e: unknown) => e);
    expect(calls.compact).toBe(1);
  });
});
