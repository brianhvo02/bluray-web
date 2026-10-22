"""Reduces a key-script run of bdj_trace (run.sh --keys) to what stays the same between runs, for a golden file.

Reads the run on stdin and prints:
  - the control calls up to the script's end line, in order (CONTROL below), as the harness printed them (those after
    it come from bd_close stopping the title);
  - then each script step as {"script":"step","n":i,"step":"<text>"}, and for a `wait still` step also "hash": the plane
    hash of the last flush before it (the settled plane, which every run reaches; null before the first flush);
  - then {"script":"end","hash":"<hash>"}: the last flushed plane at the end of the run's tail, settled too.

Flush lines are left out: libbluray's root window flushes on a 40 ms timer, so how many flushes a change takes, and where
the calls fall between them, differs between runs (tools/bdj-trace/README.md, Planes). Exits 1 when the script did not
run to its end.

  settled.py [SCRIPT]: with the run's key script, its `#! vary gpr <n>... [after playlist <p>]` lines name
  general-purpose registers whose written values depend on timing; their writeRegN calls (only those after Java's
  selectPlaylistN of <p>, when given) are left out, and for each such register a line
  {"script":"vary","gpr":<n>,"after":<p>|null,"written":<bool>} says whether any was left out (tests/bdj/settled.ts
  applies the same to our run).
"""
import json
import re
import sys

CONTROL = {
    'selectTitleN', 'selectPlaylistN', 'seekN', 'selectAngleN', 'selectRateN',
    'writeRegN', 'setUOMaskN', 'setKeyInterestN', 'soundEffectN', 'setVirtualPackageN',
}


VARY_LINE = re.compile(r'^\s*#!\s*vary\s+gpr((?:\s+\d+)+?)(?:\s+after\s+playlist\s+(\d+))?\s*(?:#.*)?$')


def vary_rules(path):
    """[(gprs, after playlist or None)], as tests/bdj/key-script.ts parseScriptOptions reads them."""
    out = []
    with open(path) as f:
        for raw in f:
            m = VARY_LINE.match(raw)
            if m:
                out.append(([int(n) for n in m.group(1).split()], int(m.group(2)) if m.group(2) else None))
    return out


def main():
    rules = vary_rules(sys.argv[1]) if len(sys.argv) > 1 else []
    active = [after is None for _, after in rules]
    written = [set() for _ in rules]
    calls = []
    steps = []
    last = None
    end = None
    for line in sys.stdin:
        line = line.strip()
        if not line.startswith('{'):
            continue
        try:
            o = json.loads(line)
        except ValueError:
            continue
        if o.get('call') in CONTROL:
            if end is not None:  # after the end line come bd_close's (the title stopping), not the run's
                continue
            keep = True
            for i, (gprs, _) in enumerate(rules):
                if o['call'] == 'writeRegN' and o['args'][0] == 0 and active[i] and o['args'][1] in gprs:
                    keep = False
                    written[i].add(o['args'][1])
            for i, (_, after) in enumerate(rules):
                if o['call'] == 'selectPlaylistN' and o['args'][0] == after:
                    active[i] = True
            if keep:
                calls.append(line)
        elif o.get('plane') == 'flush':
            last = o['hash']
        elif o.get('script') == 'step':
            s = {'script': 'step', 'n': o['n'], 'step': o['step']}
            if o.get('animated'):  # a `wait menu` step on an animated menu: no settled plane
                s['animated'] = True
            elif o['step'].startswith(('wait still', 'wait menu', 'wait quiet')):
                s['hash'] = last
            steps.append(s)
        elif o.get('script') == 'end':
            end = o
    if end is None or end.get('why') != 'done':
        sys.stderr.write('settled.py: the script did not run to its end: %s\n' % json.dumps(end))
        sys.exit(1)
    for c in calls:
        print(c)
    for i, (gprs, after) in enumerate(rules):
        for g in gprs:
            print(json.dumps({'script': 'vary', 'gpr': g, 'after': after, 'written': g in written[i]}, separators=(',', ':')))
    for s in steps:
        print(json.dumps(s, separators=(',', ':')))
    print(json.dumps({'script': 'end', 'hash': last}, separators=(',', ':')))


main()
