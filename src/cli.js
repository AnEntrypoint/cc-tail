#!/usr/bin/env node
import { JsonlReplayer, rollup } from './index.js';
import path from 'path';

function parseArgs(argv) {
  const opts = { since: null, grep: null, cwd: null, role: null, type: null, limit: 0, json: false, tail: false, rollup: null, format: 'ndjson', gmAudit: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--since') opts.since = next();
    else if (a === '--grep') opts.grep = next();
    else if (a === '--cwd') opts.cwd = next();
    else if (a === '--role') opts.role = next();
    else if (a === '--type') opts.type = next();
    else if (a === '--limit') opts.limit = parseInt(next(), 10) || 0;
    else if (a === '--json') opts.json = true;
    else if (a === '--tail' || a === '-f') opts.tail = true;
    else if (a === '--rollup') opts.rollup = next();
    else if (a === '--format') opts.format = next();
    else if (a === '--gm-audit') opts.gmAudit = true;
    else if (a === '-h' || a === '--help') { printHelp(); process.exit(0); }
    else rest.push(a);
  }
  return { opts, rest };
}

function printHelp() {
  process.stdout.write(`ccsniff — query and tail Claude Code session history

Usage:
  ccsniff [--since 12d] [--grep pattern] [--cwd path] [--role user|assistant|tool_result]
          [--type text|tool_use|tool_result] [--limit N] [--json] [-f]
  ccsniff --rollup out.ndjson [--since 7d]
  ccsniff --rollup out.sqlite --format sqlite [--since 7d]      # requires better-sqlite3
  ccsniff --gm-audit [--since 24h] [--cwd repo]

Examples:
  ccsniff --since 24h --grep "rs-exec" --limit 50
  ccsniff --since 7d --role user --json
  ccsniff -f                  # tail new events live
`);
}

function parseSince(s) {
  if (!s) return 0;
  const m = /^(\d+)([smhd])$/.exec(s);
  if (!m) return Date.parse(s) || 0;
  const n = parseInt(m[1], 10);
  const mult = { s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[m[2]];
  return Date.now() - n * mult;
}

const { opts } = parseArgs(process.argv.slice(2));
const since = parseSince(opts.since);
const grepRe = opts.grep ? new RegExp(opts.grep, 'i') : null;
const cwdRe = opts.cwd ? new RegExp(opts.cwd, 'i') : null;

let count = 0;
function out(ev) {
  const conv = ev.conversation;
  if (cwdRe && !cwdRe.test(conv.cwd || '')) return;
  if (opts.role && ev.role !== opts.role) return;
  if (opts.type && ev.block?.type !== opts.type) return;
  const text = ev.block?.text || (ev.block?.content ? (typeof ev.block.content === 'string' ? ev.block.content : JSON.stringify(ev.block.content).slice(0, 400)) : '');
  if (grepRe && !grepRe.test(text)) return;
  count++;
  if (opts.limit && count > opts.limit) return;
  if (opts.json) {
    process.stdout.write(JSON.stringify({ ts: ev.timestamp, sid: conv.id, cwd: conv.cwd, role: ev.role, type: ev.block?.type, text: text.slice(0, 2000) }) + '\n');
  } else {
    const t = new Date(ev.timestamp).toISOString().slice(0, 19).replace('T', ' ');
    const repo = path.basename(conv.cwd || '');
    process.stdout.write(`[${t}] [${repo}] ${ev.role}/${ev.block?.type || '?'}: ${text.replace(/\s+/g, ' ').slice(0, 200)}\n`);
  }
}

if (opts.gmAudit) {
  const sessions = new Map();
  const r2 = new JsonlReplayer();
  r2.on('streaming_progress', ev => {
    const conv = ev.conversation;
    if (cwdRe && !cwdRe.test(conv.cwd || '')) return;
    if (ev.role !== 'user' && ev.role !== 'assistant') return;
    const sid = conv.id;
    if (!sessions.has(sid)) sessions.set(sid, { cwd: conv.cwd, turns: [] });
    const s = sessions.get(sid);
    if (ev.role === 'user' && ev.block?.type === 'text') {
      const t = ev.block.text || '';
      const isSystem = ev.block.isMeta || /^<(task-notification|command-name|local-command|system-reminder)\b/.test(t.trimStart()) || t === '[Request interrupted by user]';
      s.turns.push({ isMeta: isSystem, firstTool: null, text: t.slice(0, 80) });
    } else if (ev.role === 'assistant' && ev.block?.type === 'tool_use' && s.turns.length) {
      const last = s.turns[s.turns.length - 1];
      if (last.firstTool === null) last.firstTool = ev.block.name || '';
    }
  });
  r2.replay({ since });
  let totalReal = 0, totalCompliant = 0;
  for (const [sid, s] of sessions) {
    const real = s.turns.filter(t => !t.isMeta);
    const compliant = real.filter(t => t.firstTool === 'Skill' || t.firstTool === 'mcp__gm__Skill');
    totalReal += real.length;
    totalCompliant += compliant.length;
    const pct = real.length ? Math.round(100 * compliant.length / real.length) : 0;
    const violations = real.filter(t => t.firstTool !== 'Skill' && t.firstTool !== 'mcp__gm__Skill');
    process.stdout.write(`[${pct}%] ${path.basename(s.cwd || sid)} (${compliant.length}/${real.length}) sid=${sid.slice(0, 8)}\n`);
    for (const v of violations.slice(0, 3)) {
      process.stdout.write(`  MISS first=${v.firstTool || 'none'} msg="${v.text.replace(/\s+/g, ' ')}"\n`);
    }
  }
  const total = totalReal ? Math.round(100 * totalCompliant / totalReal) : 0;
  process.stderr.write(`# gm-audit: ${totalCompliant}/${totalReal} compliant (${total}%) across ${sessions.size} sessions\n`);
  process.exit(0);
}

if (opts.rollup) {
  const stats = await rollup({ since, out: opts.rollup, format: opts.format });
  process.stderr.write(`# rolled up ${stats.rows} events from ${stats.events} routed (${stats.files} files) → ${stats.format}: ${stats.out}\n`);
  process.exit(0);
}

const r = new JsonlReplayer();
r.on('streaming_progress', out);
r.on('error', e => process.stderr.write(`error: ${e?.message || e}\n`));

if (opts.tail) {
  r.start();
  process.stdout.write('tailing... (Ctrl-C to exit)\n');
} else {
  const stats = r.replay({ since });
  process.stderr.write(`# ${stats.events} events across ${stats.files} files (matched: ${count})\n`);
}
