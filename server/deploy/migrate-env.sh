#!/usr/bin/env bash
# The one-time move of the owner's settings out of the compose file (deploy.sh --migrate runs it on the Mac). It reads
# the NAS's previous compose.yaml (the hard-coded one deploy.sh wrote before the compose file became generic) and
# writes, into an output folder:
#   env-additions          lines to append to the NAS's .env, one per setting the previous compose file gave and
#                          the .env does not have yet
#   compose.override.yaml  the drive bind mounts and the reverse proxy's external network, for the bluray-server service
# It touches nothing on the NAS itself; deploy.sh ships the two files.
#
#   migrate-env.sh keys <compose.yaml>
#     Prints the names of every .env key the migration may write, one per line, so deploy.sh can fetch only those lines
#     of the NAS's .env (none of them is a secret: their values come from the compose file, which held no secrets).
#   migrate-env.sh build <compose.yaml> <present.env> <out dir>
#     <present.env> holds the lines of the NAS's .env for those keys (it may be empty). A key already there is kept
#     as it is; when its value differs from the compose file's, the running server used the compose file's value, so
#     the migration stops and names the key rather than change what the server sees.
#
# The compose file is parsed by a small YAML subset reader (block maps and sequences, plain and quoted scalars, flow
# maps such as `bind: { ... }`), enough for the fixed shape deploy.sh wrote. Anything outside that shape (an
# environment list, a short-syntax bind mount, a port mapping that changes the port) stops the migration with a
# message instead of guessing.
set -euo pipefail

if ! command -v node >/dev/null 2>&1; then
  echo "migrate-env.sh needs node on PATH." >&2
  exit 1
fi

exec node - "$@" <<'JS'
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const SERVICE = 'bluray-server';
// Keys the generic compose file sets itself; the previous file's values must match them.
const FIXED = { DATA_DIR: '/data', PORT: '8080' };
// Keys the migration may write besides the previous file's environment.
const EXTRA_KEYS = ['BLURAY_IMAGE', 'LIBRARY_MOUNT', 'RTC_PORT', 'TRUSTED_PROXY'];

function fail(msg) {
  process.stderr.write(`migrate-env: ${msg}\n`);
  process.exit(1);
}

// ---- A YAML subset reader ----

function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

function readLines(text) {
  const out = [];
  text.split(/\r?\n/).forEach((raw, n) => {
    const line = stripComment(raw).replace(/\s+$/, '');
    if (line.trim() === '') return;
    if (/^\t/.test(line) || /^ *\t/.test(line)) fail(`line ${n + 1}: tabs in indentation`);
    const indent = line.length - line.trimStart().length;
    out.push({ indent, text: line.trimStart(), n: n + 1 });
  });
  return out;
}

function splitTop(s, sep) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let cur = '';
  for (const c of s) {
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '{' || c === '[') {
      depth++;
    } else if (c === '}' || c === ']') {
      depth--;
    } else if (c === sep && depth === 0) {
      parts.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur.trim() !== '') parts.push(cur);
  return parts;
}

// The index of the colon that ends a mapping key (followed by a space or the end), outside quotes.
function keyColon(s) {
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if ((c === '"' || c === "'") && i === 0) {
      quote = c;
    } else if (c === ':' && (i + 1 === s.length || s[i + 1] === ' ')) {
      return i;
    } else if (c === '{' || c === '[') {
      return -1;
    }
  }
  return -1;
}

function scalar(s, n) {
  s = s.trim();
  if (s.startsWith('"')) {
    if (!s.endsWith('"') || s.length < 2) fail(`line ${n}: unterminated "`);
    return JSON.parse(s);
  }
  if (s.startsWith("'")) {
    if (!s.endsWith("'") || s.length < 2) fail(`line ${n}: unterminated '`);
    return s.slice(1, -1).replace(/''/g, "'");
  }
  if (s.startsWith('{')) {
    if (!s.endsWith('}')) fail(`line ${n}: a flow map must end on its line`);
    const map = {};
    for (const part of splitTop(s.slice(1, -1), ',')) {
      const c = keyColon(part.trim());
      if (c < 0) fail(`line ${n}: bad flow map entry ${part.trim()}`);
      const t = part.trim();
      map[scalar(t.slice(0, c), n)] = scalar(t.slice(c + 1), n);
    }
    return map;
  }
  if (s.startsWith('[')) {
    if (!s.endsWith(']')) fail(`line ${n}: a flow sequence must end on its line`);
    return splitTop(s.slice(1, -1), ',').map((p) => scalar(p, n));
  }
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === '' || s === '~' || s === 'null') return null;
  if (/^[|>]/.test(s)) fail(`line ${n}: block scalars are not supported`);
  return s;
}

function isSeqItem(text) {
  return text === '-' || text.startsWith('- ');
}

function parseBlock(lines, i, indent) {
  return isSeqItem(lines[i].text) ? parseSeq(lines, i, indent) : parseMap(lines, i, indent);
}

// A value given on the lines after `key:` (or `-`): a deeper block, a sequence at the key's own indent, or nothing.
function parseChild(lines, i, indent, allowSameIndentSeq) {
  const next = lines[i];
  if (next && next.indent > indent) return parseBlock(lines, i, next.indent);
  if (next && allowSameIndentSeq && next.indent === indent && isSeqItem(next.text)) return parseSeq(lines, i, indent);
  return [null, i];
}

function parseMap(lines, i, indent) {
  const map = {};
  while (i < lines.length && lines[i].indent === indent && !isSeqItem(lines[i].text)) {
    const { text, n } = lines[i];
    const c = keyColon(text);
    if (c < 0) fail(`line ${n}: expected "key: value", got ${text}`);
    const key = scalar(text.slice(0, c), n);
    if (Object.hasOwn(map, key)) fail(`line ${n}: duplicate key ${key}`);
    const rest = text.slice(c + 1).trim();
    i++;
    if (rest === '') {
      [map[key], i] = parseChild(lines, i, indent, true);
    } else {
      map[key] = scalar(rest, n);
    }
  }
  if (i < lines.length && lines[i].indent > indent) fail(`line ${lines[i].n}: unexpected indentation`);
  return [map, i];
}

function parseSeq(lines, i, indent) {
  const seq = [];
  while (i < lines.length && lines[i].indent === indent && isSeqItem(lines[i].text)) {
    const { text, n } = lines[i];
    const content = text.slice(1).trimStart();
    if (content === '') {
      let v;
      [v, i] = parseChild(lines, i + 1, indent, false);
      seq.push(v);
    } else if (keyColon(content) >= 0 && !/^["'{[]/.test(content)) {
      // "- key: value" starts a map whose keys line up with "key".
      const col = indent + (text.length - content.length);
      lines[i] = { indent: col, text: content, n };
      let v;
      [v, i] = parseMap(lines, i, col);
      seq.push(v);
    } else {
      seq.push(scalar(content, n));
      i++;
    }
  }
  return [seq, i];
}

function parseYaml(text) {
  const lines = readLines(text);
  if (lines.length === 0) fail('the compose file is empty');
  if (lines[0].indent !== 0) fail(`line ${lines[0].n}: the document must start at column 0`);
  const [doc, end] = parseBlock(lines, 0, 0);
  if (end < lines.length) fail(`line ${lines[end].n}: could not read past here`);
  return doc;
}

// ---- The migration ----

function isMap(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function str(v) {
  if (v === null || v === undefined) return '';
  return typeof v === 'string' ? v : String(v);
}

function readPrevious(file) {
  const doc = parseYaml(fs.readFileSync(file, 'utf8'));
  if (!isMap(doc) || !isMap(doc.services) || !isMap(doc.services[SERVICE])) {
    fail(`no services.${SERVICE} in ${file}`);
  }
  const svc = doc.services[SERVICE];
  if (svc.environment === undefined || svc.environment === null) {
    fail(`services.${SERVICE} has no environment: this compose file is not the previous hard-coded one (already migrated?)`);
  }
  if (!isMap(svc.environment)) fail('environment must be a map (KEY: value), not a list');

  const env = new Map();
  for (const [key, raw] of Object.entries(svc.environment)) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) fail(`environment key ${key} is not a plain name`);
    const value = str(raw);
    const ref = /^\$\{([A-Z_][A-Z0-9_]*)(:?-[^}]*)?\}$/.exec(value);
    if (ref) {
      // `KEY: ${KEY:-}` reads the key from .env already (TMDB_API_KEY): nothing to move.
      if (ref[1] !== key) fail(`environment ${key} reads another variable (${ref[1]}); move it by hand`);
      continue;
    }
    if (value.includes('$')) fail(`environment ${key} uses interpolation; move it by hand`);
    if (Object.hasOwn(FIXED, key)) {
      if (value !== FIXED[key]) fail(`environment ${key} is ${value}, but the generic compose file sets ${FIXED[key]}`);
      continue;
    }
    env.set(key, value);
  }

  if (!env.has('PUBLIC_BASE')) {
    fail('the compose file sets no PUBLIC_BASE: it is not the previous hard-coded one (already migrated?)');
  }
  if (typeof svc.image === 'string' && svc.image !== '') env.set('BLURAY_IMAGE', svc.image);

  const binds = [];
  for (const v of Array.isArray(svc.volumes) ? svc.volumes : []) {
    if (typeof v === 'string') {
      // A named volume (bluray-data:/data) stays in the generic file; a host path in short syntax is not expected.
      if (/^[A-Za-z0-9][A-Za-z0-9_.-]*:/.test(v)) continue;
      fail(`short-syntax bind mount ${v}; move it by hand`);
    }
    if (!isMap(v)) fail('a volume entry is neither a string nor a map');
    if (v.type === 'volume') continue;
    if (v.type !== 'bind') fail(`volume of type ${v.type}; move it by hand`);
    if (typeof v.source !== 'string' || typeof v.target !== 'string') fail('a bind mount without source or target');
    if (v.target === '/library' || v.target === '/data') fail(`a bind mount at ${v.target} would clash with the generic compose file`);
    if (v.read_only !== true) fail(`the bind mount of ${v.source} is not read-only`);
    binds.push(v);
  }
  if (binds.length === 0) fail('no bind mounts: nothing for compose.override.yaml');

  let rtcPort = null;
  for (const p of Array.isArray(svc.ports) ? svc.ports : []) {
    const m = /^(?:[0-9.]+:)?(\d+):(\d+)\/udp$/.exec(str(p));
    if (!m) fail(`port mapping ${str(p)} is not HOST:CONTAINER/udp; move it by hand`);
    if (m[1] !== m[2]) fail(`port mapping ${str(p)} changes the port; the generic compose file needs RTC_PORT on both sides`);
    if (rtcPort !== null) fail('more than one UDP port mapping');
    rtcPort = m[1];
  }
  if (rtcPort !== null) {
    if (env.has('RTC_PORT') && env.get('RTC_PORT') !== rtcPort) fail('RTC_PORT differs from the published UDP port');
    env.set('RTC_PORT', rtcPort);
  }

  let networks = [];
  if (svc.networks !== undefined && svc.networks !== null) {
    if (Array.isArray(svc.networks)) networks = svc.networks.map(str);
    else if (isMap(svc.networks)) {
      for (const [name, opts] of Object.entries(svc.networks)) {
        if (opts !== null && !(isMap(opts) && Object.keys(opts).length === 0)) fail(`network ${name} has options; move it by hand`);
        networks.push(name);
      }
    } else fail('networks must be a list or a map');
  }
  const top = isMap(doc.networks) ? doc.networks : {};
  for (const name of networks) {
    const def = top[name];
    if (!isMap(def) || def.external !== true || Object.keys(def).some((k) => k !== 'external' && k !== 'name')) {
      fail(`network ${name} is not a plain external network; move it by hand`);
    }
  }

  // Ruling R2: an empty TRUSTED_PROXY now trusts no proxy. A server behind the Caddy container's network must name it.
  if (!env.has('TRUSTED_PROXY') && networks.includes('caddy_default')) env.set('TRUSTED_PROXY', 'caddy');
  // The generic file binds LIBRARY_MOUNT at /library and Docker never makes a missing source. The owner's roots live
  // under the override's mounts, so bind the first drive there too: it exists whenever the previous file started.
  if (!env.has('LIBRARY_MOUNT')) env.set('LIBRARY_MOUNT', binds[0].source);

  return { env, binds, networks, top };
}

function envValue(v) {
  if (/^[A-Za-z0-9_./:,=@+-]*$/.test(v)) return v;
  if (v.includes("'") || /[\r\n]/.test(v)) fail('a value holds a quote or a line break; move it by hand');
  return `'${v}'`;
}

function unquote(v) {
  v = v.trim();
  if (v.length >= 2 && ((v[0] === '"' && v.at(-1) === '"') || (v[0] === "'" && v.at(-1) === "'"))) return v.slice(1, -1);
  return v;
}

function yamlScalar(v) {
  return /^[A-Za-z0-9_./-]+$/.test(v) && !/^(true|false|null|~|yes|no|on|off)$/i.test(v) ? v : JSON.stringify(v);
}

function overrideYaml(prev, source) {
  const out = [
    `# Written once by deploy.sh --migrate from the previous ${source}: the drive mounts and networks that the generic`,
    '# compose file leaves to each host. deploy.sh never overwrites it; edit it here on the NAS.',
    'services:',
    `  ${SERVICE}:`,
    '    volumes:',
  ];
  for (const b of prev.binds) {
    const bind = isMap(b.bind) ? b.bind : {};
    out.push('      - type: bind');
    out.push(`        source: ${yamlScalar(b.source)}`);
    out.push(`        target: ${yamlScalar(b.target)}`);
    out.push('        read_only: true');
    const opts = [];
    if (bind.create_host_path !== undefined) opts.push(`create_host_path: ${bind.create_host_path === true}`);
    if (bind.propagation !== undefined) opts.push(`propagation: ${yamlScalar(str(bind.propagation))}`);
    if (opts.length) out.push(`        bind: { ${opts.join(', ')} }`);
  }
  if (prev.networks.length) {
    out.push('    networks:');
    for (const name of prev.networks) out.push(`      - ${yamlScalar(name)}`);
    out.push('', 'networks:');
    for (const name of prev.networks) {
      out.push(`  ${yamlScalar(name)}:`, '    external: true');
      if (typeof prev.top[name].name === 'string') out.push(`    name: ${yamlScalar(prev.top[name].name)}`);
    }
  }
  return out.join('\n') + '\n';
}

const [cmd, ...args] = process.argv.slice(2);
if (cmd === 'keys' && args.length === 1) {
  const prev = readPrevious(args[0]);
  const keys = new Set([...prev.env.keys(), ...EXTRA_KEYS]);
  process.stdout.write([...keys].sort().join('\n') + '\n');
} else if (cmd === 'build' && args.length === 3) {
  const [composeFile, presentFile, outDir] = args;
  const prev = readPrevious(composeFile);
  const present = new Map();
  for (const line of fs.readFileSync(presentFile, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (m && prev.env.has(m[1])) present.set(m[1], unquote(m[2]));
  }
  const differing = [...present].filter(([k, v]) => v !== prev.env.get(k)).map(([k]) => k);
  if (differing.length) {
    fail(`the NAS's .env already sets ${differing.join(', ')} to a value other than the compose file's, which the ` +
      'running server uses. Make those lines match the compose file (or remove them) and run --migrate again.');
  }
  const added = [...prev.env.keys()].filter((k) => !present.has(k));
  const lines = [];
  if (added.length) {
    lines.push(`# Moved from the previous compose.yaml by deploy.sh --migrate`);
    for (const k of added) lines.push(`${k}=${envValue(prev.env.get(k))}`);
  }
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'env-additions'), lines.length ? lines.join('\n') + '\n' : '');
  fs.writeFileSync(path.join(outDir, 'compose.override.yaml'), overrideYaml(prev, 'compose.yaml'));
  process.stdout.write(`.env: adding ${added.length ? added.join(', ') : 'nothing'}` +
    (present.size ? `; already there: ${[...present.keys()].join(', ')}` : '') + '\n');
  process.stdout.write(`compose.override.yaml: ${prev.binds.length} bind mount(s)` +
    (prev.networks.length ? `, network(s) ${prev.networks.join(', ')}` : '') + '\n');
} else {
  fail('usage: migrate-env.sh keys <compose.yaml> | migrate-env.sh build <compose.yaml> <present.env> <out dir>');
}
JS
