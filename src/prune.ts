import type { JevAsker, JevQuestions } from './types.js';

declare function setTimeout(fn: () => void, ms: number): unknown;
declare function clearTimeout(handle: unknown): void;

/** Pruning applies only above this many characters. */
export const PRUNE_THRESHOLD = 6000;
/** The pruned text never exceeds this many characters. */
export const PRUNE_MAX_CHARS = 3000;
/** Jev gets this long before the deterministic head+tail cut takes over. */
export const PRUNE_JEV_TIMEOUT_MS = 1_500;

const FRAGMENT_CHARS = 300;
const MAX_FRAGMENTS = 80;
const HEAD_CHARS = 500;
const TAIL_CHARS = 500;
const PICK_BUDGET = 1500;
const FALLBACK_HEAD = 1500;
const FALLBACK_TAIL = 1000;

/** Sam's workspace and his employer's second brain: nothing of it goes through Jev. */
export const EXCLUDED_ROOT = 'c:/users/administrator/.gemini/antigravity/playground/sam';
export const EXCLUDED_MENTION = 'c:/users/administrator/documents/claude/projects/delta';

/** Slashes forward, lower case, no trailing slash. */
export function normalizePath(path: string): string {
  return path.split('\\').join('/').replace(new RegExp('/+', 'g'), '/').replace(new RegExp('/$'), '').toLowerCase();
}

export function isUnderExcludedRoot(path: string | undefined): boolean {
  if (!path) return false;
  const p = normalizePath(path);
  return p === EXCLUDED_ROOT || p.startsWith(`${EXCLUDED_ROOT}/`);
}

/** True when cwd/project dir is Sam's, or the tool input mentions his employer's data. */
export function isExcluded(
  cwd: string | undefined,
  projectDir: string | undefined,
  input: unknown,
): boolean {
  if (isUnderExcludedRoot(cwd) || isUnderExcludedRoot(projectDir)) return true;
  let raw = '';
  try {
    raw = JSON.stringify(input) ?? '';
  } catch {
    raw = String(input);
  }
  // JSON escapes backslashes; normalize after collapsing them.
  return normalizePath(raw.replace(/\\/g, '/')).includes(EXCLUDED_MENTION);
}

/** Splits into numbered fragments of ~`size` chars without cutting lines (long lines are cut). */
export function splitFragments(text: string, size: number = FRAGMENT_CHARS): string[] {
  const out: string[] = [];
  let cur = '';
  for (const line of text.split(/(?<=\n)/)) {
    if (cur && cur.length + line.length > size) {
      out.push(cur);
      cur = '';
    }
    let rest = line;
    while (rest.length > size) {
      if (cur) {
        out.push(cur);
        cur = '';
      }
      out.push(rest.slice(0, size));
      rest = rest.slice(size);
    }
    cur += rest;
  }
  if (cur) out.push(cur);
  return out;
}

export function prunedHeader(kept: number, total: number, path: string): string {
  return `[poda Jev: ${kept}/${total} fragmentos · completo en ${path}]`;
}

/** Deterministic cut: head + tail + path. Always ≤ PRUNE_MAX_CHARS. */
export function failOpenCut(text: string, path: string): string {
  const header = `[poda Jev (fail-open): cabeza+cola · completo en ${path}]`;
  const head = text.slice(0, FALLBACK_HEAD);
  const tail = text.slice(-FALLBACK_TAIL);
  return `${header}\n${head}\n[...]\n${tail}`.slice(0, PRUNE_MAX_CHARS);
}

export interface PruneContext {
  userPrompt: string;
  assistantText: string;
  tool: string;
  input: unknown;
}

/** Jev scores every fragment; the best ones stay, in their original order. */
export async function pruneWithJev(
  text: string,
  path: string,
  ctx: PruneContext,
  asker: JevAsker,
  timeoutMs: number = PRUNE_JEV_TIMEOUT_MS,
): Promise<string> {
  const size = Math.max(FRAGMENT_CHARS, Math.ceil(text.length / MAX_FRAGMENTS));
  const frags = splitFragments(text, size);
  const head = text.slice(0, HEAD_CHARS);
  const tail = text.slice(-TAIL_CHARS);
  const questions: JevQuestions = {};
  frags.forEach((frag, i) => {
    questions[`f${i}`] = {
      type: 'score',
      instructions: `Fragment ${i} of a long tool output:\n${frag}\n\nHow useful is this fragment for what the assistant is doing now?`,
      criteria: ['irrelevant', 'relevant'],
    };
  });
  const state = {
    user_prompt: ctx.userPrompt.slice(0, 2000),
    assistant_intent: ctx.assistantText.slice(0, 2000),
    tool: ctx.tool,
    tool_input: JSON.stringify(ctx.input ?? null).slice(0, 2000),
  };
  let timer: unknown;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Jev prune timeout')), timeoutMs);
  });
  let response;
  try {
    response = await Promise.race([asker.ask(state, questions), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  const starts: number[] = [];
  let offset = 0;
  for (const frag of frags) {
    starts.push(offset);
    offset += frag.length;
  }
  const scored = frags.map((frag, index) => {
    const a = response.answers[`f${index}`] as { score?: number } | undefined;
    if (!a || typeof a.score !== 'number' || !Number.isFinite(a.score)) {
      throw new Error(`Invalid Jev answer for f${index}`);
    }
    return { index, frag, score: a.score };
  }).filter((s) => starts[s.index]! >= HEAD_CHARS && starts[s.index]! + s.frag.length <= text.length - TAIL_CHARS);
  scored.sort((x, y) => y.score - x.score || x.index - y.index);
  const chosen: typeof scored = [];
  let used = 0;
  for (const s of scored) {
    if (used + s.frag.length > PICK_BUDGET) continue;
    chosen.push(s);
    used += s.frag.length;
  }
  chosen.sort((x, y) => x.index - y.index);
  const header = prunedHeader(chosen.length, frags.length, path);
  const body = chosen.map((c) => c.frag.trimEnd()).join('\n[...]\n');
  return `${header}\n${head}\n[...]\n${body}\n[...]\n${tail}`.slice(0, PRUNE_MAX_CHARS);
}

/**
 * Saves the full text and returns the pruned replacement (Jev, else fail-open).
 * `write` rejecting propagates: the caller must then leave the result untouched.
 */
export async function pruneText(
  text: string,
  path: string,
  ctx: PruneContext,
  asker: JevAsker | undefined,
  write: (path: string, text: string) => Promise<void>,
  timeoutMs: number = PRUNE_JEV_TIMEOUT_MS,
): Promise<string> {
  await write(path, text);
  if (asker) {
    try {
      return await pruneWithJev(text, path, ctx, asker, timeoutMs);
    } catch {
      /* fail-open below */
    }
  }
  return failOpenCut(text, path);
}

/** Tools that get pruned: Bash and MCP text. Read/Edit/Write/NotebookEdit never. */
export function isPrunableTool(tool: string): boolean {
  return tool === 'Bash' || tool.startsWith('mcp__');
}

/** Same tool + same input, for the loop-guard. */
export function callKey(tool: string, input: unknown): string {
  return `${tool}\u0000${JSON.stringify(input)}`;
}
