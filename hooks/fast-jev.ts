import type {
  On,
  PluginOptions,
  Register,
  SessionMessage,
  ToolResultSummary,
  ToolUseSummary,
  TurnCompleteInput,
} from 'claude-code';

import { compact, reductionRatio, resolveOptions } from '../src/compact.js';
import {
  callKey,
  isExcluded,
  isPrunableTool,
  PRUNE_THRESHOLD,
  pruneText,
} from '../src/prune.js';
import { buildJevRequest, DEFAULT_MODEL, parseJevResponse } from '../src/request.js';
import type {
  CompactOptions,
  CompactResult,
  JevAsker,
  Message,
  ToolResult,
  ToolUse,
} from '../src/types.js';

const HOOK_DEFAULTS = {
  compactAtPercent: 60,
  minReductionRatio: 0.25,
  model: DEFAULT_MODEL,
};

export type HookFetchInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};

export type HookFetchResponse = {
  status: number;
  ok: boolean;
  text: string;
};

/** The shape of `$.http.fetch`, so the hook can be driven without an engine. */
export type HookFetch = (url: string, init?: HookFetchInit) => Promise<HookFetchResponse>;

export type HookConfig = CompactOptions & {
  apiKey?: string;
  baseUrl?: string;
  compactAtPercent: number;
  minReductionRatio: number;
  model: string;
};

function optionNumber(options: PluginOptions, key: string, fallback: number): number {
  const value = options[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function optionString(options: PluginOptions, key: string): string | undefined {
  const value = options[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Reads the plugin's `userConfig` values; anything missing takes the defaults. */
export function resolveHookConfig(options: PluginOptions): HookConfig {
  const numbers: Partial<Omit<CompactOptions, 'goal'>> = {};
  for (const key of [
    'keepThreshold',
    'preserveRecentMessages',
    'maxStateTokens',
    'maxRequestTokens',
    'truncateHeadChars',
  ] as const) {
    const value = options[key];
    if (typeof value === 'number' && Number.isFinite(value)) numbers[key] = value;
  }
  const config: HookConfig = {
    ...numbers,
    compactAtPercent: optionNumber(options, 'compactAtPercent', HOOK_DEFAULTS.compactAtPercent),
    minReductionRatio: optionNumber(
      options,
      'minReductionRatio',
      HOOK_DEFAULTS.minReductionRatio,
    ),
    model: optionString(options, 'model') ?? HOOK_DEFAULTS.model,
  };
  const apiKey = optionString(options, 'apiKey');
  if (apiKey) config.apiKey = apiKey;
  // VelvetLabs: los clientes nunca hablan con TypeSafe/OpenRouter directo; todo pasa por el gateway de Jev.
  const baseUrl = optionString(options, 'baseUrl');
  if (baseUrl) config.baseUrl = baseUrl;
  const goal = optionString(options, 'goal');
  if (goal) config.goal = goal;
  return config;
}

/** Cabeceras de identidad hacia el gateway; si la cwd falla, solo el origen. */
async function jevHeaders($: { session: { cwd(): Promise<string> } }): Promise<Record<string, string>> {
  const headers: Record<string, string> = { 'x-jev-origen': 'org' };
  try {
    headers['x-jev-cwd'] = await $.session.cwd();
  } catch {}
  return headers;
}

// Tope por llamada a Jev para no colgar el turno (4s).
const JEV_ASK_TIMEOUT_MS = 4_000;

/** A `JevAsker` over the engine's `$.http.fetch`. */
export function jevAsker(
  fetchFn: HookFetch,
  apiKey: string,
  model: string,
  baseUrl?: string,
  extraHeaders?: Record<string, string>,
): JevAsker {
  return {
    async ask(state, questions) {
      const request = buildJevRequest({ apiKey, model, baseUrl, headers: extraHeaders }, state, questions);
      // Si Jev tarda más del tope, el timeout hace fail-open y el hook cae a su fallback.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Jev ask timeout after ${JEV_ASK_TIMEOUT_MS} ms`)), JEV_ASK_TIMEOUT_MS);
      });
      try {
        const response = await Promise.race([
          fetchFn(request.url, {
            method: request.method,
            headers: request.headers,
            body: request.body,
          }),
          timeout,
        ]);
        return parseJevResponse(response.status, response.ok, response.text);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
  };
}

function toolUseSummary(tool: ToolUse): ToolUseSummary {
  const summary: ToolUseSummary = {
    tool_use_id: tool.tool_use_id,
    tool: tool.tool,
    input: tool.input,
  };
  if (tool.text !== undefined) summary.text = tool.text;
  if (tool.isError) summary.isError = true;
  return summary;
}

function toolResultSummary(result: ToolResult): ToolResultSummary {
  return {
    tool_use_id: result.tool_use_id,
    text: result.text,
    isError: result.isError ?? false,
  };
}

/**
 * Maps the library's output back onto session messages. Whatever came back
 * unchanged (a message, a tool use, a tool result) is the engine's own object,
 * handle included; anything rebuilt is a fresh message without a handle, so the
 * engine takes the edited content instead of its original.
 */
export function toSessionMessages(
  input: readonly SessionMessage[],
  output: readonly Message[],
): SessionMessage[] {
  const messages = new Map<Message, SessionMessage>();
  const uses = new Map<ToolUse, ToolUseSummary>();
  const results = new Map<ToolResult, ToolResultSummary>();
  for (const message of input) {
    messages.set(message, message);
    for (const tool of message.toolUses) uses.set(tool, tool);
    for (const result of message.toolResults ?? []) results.set(result, result);
  }
  return output.map((message) => {
    const own = messages.get(message);
    if (own) return own;
    const rebuilt: SessionMessage = {
      role: message.role,
      text: message.text,
      toolUses: message.toolUses.map((tool) => uses.get(tool) ?? toolUseSummary(tool)),
    };
    if (message.toolResults && message.toolResults.length > 0) {
      rebuilt.toolResults = message.toolResults.map(
        (result) => results.get(result) ?? toolResultSummary(result),
      );
    }
    return rebuilt;
  });
}

export type SessionCompaction = {
  result: CompactResult;
  messages: SessionMessage[];
};

/** Runs the library over a session transcript; throws when the key is missing or Jev fails. */
export async function compactSession(
  messages: readonly SessionMessage[],
  config: HookConfig,
  fetchFn: HookFetch,
  extraHeaders?: Record<string, string>,
): Promise<SessionCompaction> {
  if (!config.apiKey) throw new Error('TYPESAFE_API_KEY is not configured');
  const result = await compact(
    messages,
    jevAsker(fetchFn, config.apiKey, config.model, config.baseUrl, extraHeaders),
    config,
  );
  return { result, messages: toSessionMessages(messages, result.messages) };
}

function percent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

export function summarize(result: CompactResult): string {
  const { stats } = result;
  const parts = [
    stats.kept > 0 ? `${stats.kept} kept` : '',
    stats.resultsDropped > 0 ? `${stats.resultsDropped} results truncated` : '',
    stats.callsDropped > 0 ? `${stats.callsDropped} call_dropped` : '',
    stats.pinned > 0 ? `${stats.pinned} pinned` : '',
  ].filter(Boolean);
  return `${percent(reductionRatio(result))} reduction; ${
    parts.join(', ') || 'no tool calls'
  }; state ~${stats.stateTokens} tokens (${stats.stateStage}) in ${stats.requests} request(s)`;
}

const UI_LOG_MAX_CHARS = 4096;

export function decisionLog(result: CompactResult): string {
  return result.decisions
    .filter((d) => d.reason !== 'pinned')
    .map(
      (d) =>
        `${d.id}:${d.tool}:${d.action}/call=${d.keepCall.toFixed(2)}/result=${d.keepResult.toFixed(2)}`,
    )
    .join(' ');
}

export function decisionLogLines(
  result: CompactResult,
  maxChars: number = UI_LOG_MAX_CHARS,
): string[] {
  const entries = decisionLog(result).split(' ').filter(Boolean);
  if (entries.length === 0) return ['decisions: (none)'];
  const chunks: string[] = [];
  let current = '';
  for (const entry of entries) {
    const next = current ? `${current} ${entry}` : entry;
    if (current && next.length > maxChars - 24) {
      chunks.push(current);
      current = entry;
    } else current = next;
  }
  chunks.push(current);
  return chunks.map((chunk, index) =>
    chunks.length === 1
      ? `decisions: ${chunk}`
      : `decisions (${index + 1}/${chunks.length}): ${chunk}`,
  );
}

async function getApiKey(
  $: {
    env: { get: (name: string) => Promise<string | undefined> };
    settings: { read: () => Promise<Readonly<Record<string, unknown>>> };
  },
  config: HookConfig,
): Promise<string | undefined> {
  if (config.apiKey) return config.apiKey;
  const fromEnv = await $.env.get('TYPESAFE_API_KEY');
  if (fromEnv) return fromEnv;
  const settings = await $.settings.read();
  const env = settings['env'];
  if (env && typeof env === 'object') {
    const value = (env as Record<string, unknown>)['TYPESAFE_API_KEY'];
    if (typeof value === 'string' && value) return value;
  }
  // Con gateway propio no hay llave en el cliente: el gateway la tiene (vault). Un marcador basta.
  if (config.baseUrl) return 'gateway';
  return undefined;
}

/** VelvetLabs: URL del gateway de Jev (`baseUrl` del plugin, o FAST_JEV_BASE_URL en el env / settings). */
async function getBaseUrl(
  $: {
    env: { get: (name: string) => Promise<string | undefined> };
    settings: { read: () => Promise<Readonly<Record<string, unknown>>> };
  },
  config: HookConfig,
): Promise<string | undefined> {
  if (config.baseUrl) return config.baseUrl;
  const fromEnv = await $.env.get('FAST_JEV_BASE_URL');
  if (fromEnv) return fromEnv;
  const settings = await $.settings.read();
  const env = settings['env'];
  if (env && typeof env === 'object') {
    const value = (env as Record<string, unknown>)['FAST_JEV_BASE_URL'];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

function notify(
  $: {
    ui: {
      log: (text: string) => void;
      toast: (text: string, options?: { timeoutMs?: number }) => void;
    };
  },
  text: string,
): void {
  $.ui.log(text);
  $.ui.toast(text, { timeoutMs: 15_000 });
}

export const register: Register = (on: On, options: PluginOptions) => {
  const configured = resolveHookConfig(options);
  let compacting = false;

  on('session.compact', async ($, event, next) => {
    try {
      const withUrl = { ...configured, baseUrl: await getBaseUrl($, configured) };
      const config = { ...withUrl, apiKey: await getApiKey($, withUrl) };
      const { result, messages } = await compactSession(event.messages, config, async (url, init) => {
        const response = await $.http.fetch(url, init);
        return { status: response.status, ok: response.ok, text: response.text };
      }, await jevHeaders($));
      for (const line of decisionLogLines(result)) $.ui.log(line);
      if (reductionRatio(result) < config.minReductionRatio) {
        notify(
          $,
          `fallback to built-in summary (below ${percent(config.minReductionRatio)} minimum: ${summarize(result)})`,
        );
        return next(event);
      }
      notify(
        $,
        `kept ${messages.length}/${event.messages.length} messages, no summary (${summarize(result)})`,
      );
      return { messages };
    } catch (error) {
      notify(
        $,
        `fallback to built-in summary (${error instanceof Error ? error.message : String(error)})`,
      );
      return next(event);
    }
  });

  const pruned = new Set<string>();

  on('tool.call', async ($, event, next) => {
    const r = await next(event);
    try {
      const e = event as unknown as Record<string, unknown> & { tool: string; tool_use_id?: string };
      if (!isPrunableTool(e.tool)) return r;
      const res = r as unknown as { result?: any; text?: string; isError?: boolean };
      if (res.isError || res.result?.isError) return r;
      const isBash = e.tool === 'Bash';
      const out = res.result as any;
      const text: string | undefined = isBash
        ? typeof out?.stdout === 'string' ? out.stdout : undefined
        : Array.isArray(out?.content) && out.content.length === 1 && out.content[0]?.type === 'text'
          ? out.content[0].text
          : undefined;
      if (typeof text !== 'string' || text.length <= PRUNE_THRESHOLD) return r;
      const cwd = await $.session.cwd();
      const projectDir = await $.env.get('CLAUDE_PROJECT_DIR');
      if (isExcluded(cwd, projectDir, event)) return r;
      const { tool_use_id: _id, ...sameInput } = e;
      const key = callKey(e.tool, sameInput);
      if (pruned.has(key)) return r; // loop-guard: repeated after a prune -> enters whole
      const base = (await $.env.get('CLAUDE_PLUGIN_DATA')) ?? `${(await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '.'}/.claude/spill`;
      const sessionId = await $.session.id();
      const path = `${base}/spill/${sessionId}/${e.tool_use_id ?? String(Date.now())}.txt`;
      const withUrl = { ...configured, baseUrl: await getBaseUrl($, configured) };
      const apiKey = await getApiKey($, withUrl);
      const messages = await $.session.messages();
      const lastText = (role: string) => [...messages].reverse().find((m) => m.role === role && m.text)?.text ?? '';
      const asker = apiKey
        ? jevAsker(async (url, init) => {
            const response = await $.http.fetch(url, init);
            return { status: response.status, ok: response.ok, text: response.text };
          }, apiKey, configured.model, withUrl.baseUrl, await jevHeaders($))
        : undefined;
      const replacement = await pruneText(
        text,
        path,
        { userPrompt: lastText('user'), assistantText: lastText('assistant'), tool: e.tool, input: event },
        asker,
        (p, t) => $.fs.write(p, t),
      );
      pruned.add(key);
      const newResult = isBash
        ? { ...out, stdout: replacement, stderr: typeof out.stderr === 'string' ? out.stderr.slice(0, 1000) : out.stderr }
        : { ...out, content: [{ type: 'text', text: replacement }] };
      return { ...res, result: newResult, text: replacement } as typeof r;
    } catch {
      return r; // fail-open: never break the tool call
    }
  });

  on('turn.complete', async ($, event: TurnCompleteInput, next) => {
    if (compacting) return next(event);
    try {
      const { context } = await $.session.usage();
      if ((context.percent ?? 0) < configured.compactAtPercent) return next(event);
      compacting = true;
      await $.session.compact();
    } catch (error) {
      $.ui.log(
        `auto-compact skipped (${error instanceof Error ? error.message : String(error)})`,
      );
    } finally {
      compacting = false;
    }
    return next(event);
  });
};

export { resolveOptions };
