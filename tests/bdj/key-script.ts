import type { MenuKey } from '../../src/engine/protocol';

/**
 * A step of a bdj-trace key script (tools/bdj-trace/README.md, Key scripts): the `.keys` syntax of tests/vm-trace, with
 * `wait flush`, `wait still`, `wait playlist`, `key`, `mouse` and `click`.
 */
export type KeyStep =
  | { readonly kind: 'waitFlush'; readonly text: string; readonly n: number }
  | { readonly kind: 'waitStill'; readonly text: string; readonly ms: number }
  | { readonly kind: 'waitPlaylist'; readonly text: string; readonly playlist: number }
  | { readonly kind: 'key'; readonly text: string; readonly key: MenuKey }
  | { readonly kind: 'pointer'; readonly text: string; readonly click: boolean; readonly x: number; readonly y: number };

/** The harness's key names (vm-trace's and keys.h's) that the player's menuKey command has. */
const KEYS: Readonly<Record<string, MenuKey>> = {
  up: 'up', down: 'down', left: 'left', right: 'right', ok: 'ok', topmenu: 'topMenu', popup: 'popup',
  BD_VK_UP: 'up', BD_VK_DOWN: 'down', BD_VK_LEFT: 'left', BD_VK_RIGHT: 'right', BD_VK_ENTER: 'ok',
  BD_VK_ROOT_MENU: 'topMenu', BD_VK_POPUP: 'popup',
  ...Object.fromEntries([...'0123456789'].flatMap((d) => [[d, d], [`BD_VK_${d}`, d]])),
};

const int = (s: string | undefined, line: string): number => {
  if (s === undefined || !/^\d+$/.test(s)) throw new Error(`key script: bad number in "${line}"`);
  return Number(s);
};

/** Parses a `.keys` script; the step text is the line without its comment, as the harness prints it. */
export function parseKeyScript(source: string): KeyStep[] {
  const steps: KeyStep[] = [];
  for (const raw of source.split('\n')) {
    const text = raw.replace(/#.*/, '').trim();
    if (!text) continue;
    const [verb, a, b, c] = text.split(/\s+/);
    if (verb === 'wait' && a === 'flush') steps.push({ kind: 'waitFlush', text, n: int(b, text) });
    else if (verb === 'wait' && a === 'still') steps.push({ kind: 'waitStill', text, ms: int(b, text) });
    else if (verb === 'wait' && a === 'playlist') steps.push({ kind: 'waitPlaylist', text, playlist: int(b, text) });
    else if (verb === 'key' && a !== undefined && KEYS[a]) steps.push({ kind: 'key', text, key: KEYS[a] });
    else if ((verb === 'mouse' || verb === 'click') && c === undefined) steps.push({ kind: 'pointer', text, click: verb === 'click', x: int(a, text), y: int(b, text) });
    else throw new Error(`key script: unsupported step "${text}"`);
  }
  return steps;
}

/** A script step as it ran, in tools/bdj-trace/settled.py's form: a `wait still` step carries the settled plane's hash. */
export interface SettledStep {
  readonly script: 'step';
  readonly n: number;
  readonly step: string;
  readonly hash?: string | null;
}
