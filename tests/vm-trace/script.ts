/** Input script shared by the libbluray harness (tools/vm-trace/vm_trace.c) and our replay. One step per line, `#` starts a comment. */
export type KeyName = 'up' | 'down' | 'left' | 'right' | 'ok' | 'topmenu' | 'popup' | '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9';

export type ScriptStep =
  | { readonly op: 'wait'; readonly what: 'title' | 'playlist' | 'reads' | 'page'; readonly n: number }
  | { readonly op: 'wait'; readonly what: 'menu' | 'popup' | 'end' }
  | { readonly op: 'key'; readonly key: KeyName }
  | { readonly op: 'mouse' | 'click'; readonly x: number; readonly y: number }
  | { readonly op: 'play'; readonly title: number };

const KEYS: readonly string[] = ['up', 'down', 'left', 'right', 'ok', 'topmenu', 'popup', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];

export function parseScript(text: string): ScriptStep[] {
  const steps: ScriptStep[] = [];
  text.split('\n').forEach((raw, lineNo) => {
    const line = raw.replace(/#.*/, '').trim();
    if (line === '') return;
    const bad = (): never => {
      throw new Error(`script line ${lineNo + 1}: cannot parse "${raw.trim()}"`);
    };
    const [op, a, b] = line.split(/\s+/);
    const int = (s: string | undefined): number => (s !== undefined && /^\d+$/.test(s) ? Number(s) : bad());
    switch (op) {
      case 'wait':
        if (a === 'title' || a === 'playlist' || a === 'reads' || a === 'page') steps.push({ op: 'wait', what: a, n: int(b) });
        else if (a === 'menu' || a === 'popup' || a === 'end') steps.push({ op: 'wait', what: a });
        else bad();
        break;
      case 'key':
        if (a !== undefined && KEYS.includes(a)) steps.push({ op: 'key', key: a as KeyName });
        else bad();
        break;
      case 'mouse':
      case 'click':
        steps.push({ op, x: int(a), y: int(b) });
        break;
      case 'play':
        if (a !== 'title') bad();
        steps.push({ op: 'play', title: int(b) });
        break;
      default:
        bad();
    }
  });
  return steps;
}
