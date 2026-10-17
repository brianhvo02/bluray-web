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
"""
import json
import sys

CONTROL = {
    'selectTitleN', 'selectPlaylistN', 'seekN', 'selectAngleN', 'selectRateN',
    'writeRegN', 'setUOMaskN', 'setKeyInterestN', 'soundEffectN', 'setVirtualPackageN',
}


def main():
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
            if end is None:  # after the end line come bd_close's (the title stopping), not the run's
                calls.append(line)
        elif o.get('plane') == 'flush':
            last = o['hash']
        elif o.get('script') == 'step':
            s = {'script': 'step', 'n': o['n'], 'step': o['step']}
            if o['step'].startswith('wait still'):
                s['hash'] = last
            steps.append(s)
        elif o.get('script') == 'end':
            end = o
    if end is None or end.get('why') != 'done':
        sys.stderr.write('settled.py: the script did not run to its end: %s\n' % json.dumps(end))
        sys.exit(1)
    for c in calls:
        print(c)
    for s in steps:
        print(json.dumps(s, separators=(',', ':')))
    print(json.dumps({'script': 'end', 'hash': last}, separators=(',', ':')))


main()
