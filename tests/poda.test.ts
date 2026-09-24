import { describe, expect, test } from 'claude-code/testing'

const BS = String.fromCharCode(92)
const SAM = 'C:/Users/Administrator/.gemini/antigravity/playground/sam'
const big = (n: number) => Array.from({ length: Math.ceil(n / 15) }, (_, i) => 'linea ' + String(i).padStart(5, '0') + ' xx' + String.fromCharCode(10)).join('').slice(0, n)

type Opts = { cwd?: string; gateway?: 'off' | 'hang' | 'jev'; project?: string }

function setup(on: any, opts: Opts = {}) {
  const files = new Map<string, string>()
  const calls = { bottom: 0, fetch: 0 }
  const env: Record<string, string | undefined> = {
    CLAUDE_PLUGIN_DATA: 'C:/data/plugin',
    TYPESAFE_API_KEY: 'k',
    CLAUDE_PROJECT_DIR: opts.project,
  }
  on('env.get', async (_$: any, e: any) => ({ value: env[e.name] }))
  on('settings.read', async () => ({ value: {} }))
  on('session.cwd', async () => ({ value: opts.cwd ?? 'C:/work/dir' }))
  on('session.id', async () => ({ value: 'sess1' }))
  on('session.messages', async () => ({ value: [
    { role: 'user', text: 'arregla el test', toolUses: [] },
    { role: 'assistant', text: 'corriendo', toolUses: [] },
  ] }))
  on('fs.write', async (_$: any, e: any) => { files.set(e.path, e.text); return { value: undefined } })
  on('fs.read', async (_$: any, e: any) => ({ value: files.get(e.path) ?? '' }))
  on('http.fetch', async (_$: any, e: any) => {
    calls.fetch++
    if (opts.gateway === 'off') throw new Error('ECONNREFUSED')
    if (opts.gateway === 'hang') return new Promise(() => {})
    const { questions } = JSON.parse(e.init?.body ?? e.body ?? '{}')
    const answers = Object.fromEntries(
      Object.keys(questions).map((k, i) => [k, { type: 'score', score: i % 7 === 0 ? 0.9 : 0.1 }])
    )
    return { value: { status: 200, ok: true, text: JSON.stringify({ answers }) } }
  })
  return { files, calls }
}

function bottom(on: any, calls: { bottom: number }, tool: string, text: string) {
  on('tool.call', async () => {
    calls.bottom++
    return tool === 'Bash'
      ? { result: { stdout: text, stderr: '' }, text }
      : { result: { content: [{ type: 'text', text }] }, text }
  })
}

const bashText = (r: any): string => r.result.stdout

describe('poda', () => {
  test('20k de Bash entra en <=3000, completo idéntico en disco y orden original', async ($, on) => {
    const { files, calls } = setup(on, { gateway: 'jev' })
    const full = big(20000)
    bottom(on, calls, 'Bash', full)
    const r: any = await $.tool.call({ tool: 'Bash', command: 'cat x', tool_use_id: 'tu1' })
    const out = bashText(r)
    expect(out.length).toBeLessThanOrEqual(3000)
    const path = [...files.keys()][0]!
    expect(files.get(path)).toBe(full)
    expect(out).toContain(path.split(BS).join('/'))
    expect(out).toContain('poda Jev')
    const nums = [...out.matchAll(/linea (\d{5})/g)].map((m) => Number(m[1]))
    expect(nums.length).toBeGreaterThan(2)
    expect([...nums].sort((a, b) => a - b)).toEqual(nums)
  })

  test('MCP largo también se poda', async ($, on) => {
    const { calls } = setup(on, { gateway: 'jev' })
    bottom(on, calls, 'mcp__x__y', big(20000))
    const r: any = await $.tool.call({ tool: 'mcp__x__y', tool_use_id: 'tu2' } as any)
    expect(r.result.content[0].text.length).toBeLessThanOrEqual(3000)
  })

  test('gateway apagado: fail-open en <=1.6s con cabeza+cola+ruta', async ($, on) => {
    const { files, calls } = setup(on, { gateway: 'hang' })
    const full = big(20000)
    bottom(on, calls, 'Bash', full)
    const t0 = Date.now()
    const r: any = await $.tool.call({ tool: 'Bash', command: 'cat x', tool_use_id: 'tu3' })
    expect(Date.now() - t0).toBeLessThan(1600)
    const out = bashText(r)
    expect(out.length).toBeLessThanOrEqual(3000)
    expect(out.startsWith('[poda Jev')).toBe(true)
    expect(out).toContain(full.slice(0, 200).split(String.fromCharCode(10))[0]!)
    expect(out).toContain(full.slice(-30).trim().split(String.fromCharCode(10)).pop()!)
    expect(out).toContain([...files.keys()][0]!.split(BS).join('/'))
  })

  test('Read de 20k no se toca', async ($, on) => {
    const { files, calls } = setup(on, { gateway: 'jev' })
    const full = big(20000)
    bottom(on, calls, 'Read', full)
    const r: any = await $.tool.call({ tool: 'Read', file_path: 'a.txt' })
    expect(r.text).toBe(full)
    expect(files.size).toBe(0)
    expect(calls.fetch).toBe(0)
  })

  test('bajo el umbral no se toca', async ($, on) => {
    const { files, calls } = setup(on, { gateway: 'jev' })
    bottom(on, calls, 'Bash', big(5000))
    const r: any = await $.tool.call({ tool: 'Bash', command: 'ls' })
    expect(bashText(r).length).toBe(5000)
    expect(files.size).toBe(0)
  })

  test('loop-guard: la misma llamada repetida tras una poda entra completa', async ($, on) => {
    const { calls } = setup(on, { gateway: 'jev' })
    const full = big(20000)
    bottom(on, calls, 'Bash', full)
    const a: any = await $.tool.call({ tool: 'Bash', command: 'cat x', tool_use_id: 'a' })
    const b: any = await $.tool.call({ tool: 'Bash', command: 'cat x', tool_use_id: 'b' })
    expect(bashText(a).length).toBeLessThanOrEqual(3000)
    expect(bashText(b)).toBe(full)
    const c: any = await $.tool.call({ tool: 'Bash', command: 'cat y', tool_use_id: 'c' })
    expect(bashText(c).length).toBeLessThanOrEqual(3000)
  })

  describe('exclusión de Sam', () => {
    const cws = [SAM, SAM + '/sub/dir']
    for (const cwd of cws)
      test('cwd ' + cwd, async ($, on) => {
        const { files, calls } = setup(on, { cwd, gateway: 'jev' })
        const full = big(20000)
        bottom(on, calls, 'Bash', full)
        const r: any = await $.tool.call({ tool: 'Bash', command: 'cat x' })
        expect(bashText(r)).toBe(full)
        expect(files.size).toBe(0)
        expect(calls.fetch).toBe(0)
      })

    test('CLAUDE_PROJECT_DIR de Sam', async ($, on) => {
      const { files, calls } = setup(on, { project: SAM + '/p', gateway: 'jev' })
      const full = big(20000)
      bottom(on, calls, 'Bash', full)
      const r: any = await $.tool.call({ tool: 'Bash', command: 'cat x' })
      expect(bashText(r)).toBe(full)
      expect(files.size).toBe(0)
    })

    test('input que menciona Delta', async ($, on) => {
      const { files, calls } = setup(on, { gateway: 'jev' })
      const full = big(20000)
      bottom(on, calls, 'Bash', full)
      const r: any = await $.tool.call({
        tool: 'Bash',
        command: ['cat C:', 'Users', 'Administrator', 'Documents', 'Claude', 'Projects', 'Delta', 'a.md'].join(BS),
      })
      expect(bashText(r)).toBe(full)
      expect(files.size).toBe(0)
      expect(calls.fetch).toBe(0)
    })
  })
})
