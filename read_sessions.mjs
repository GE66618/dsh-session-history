#!/usr/bin/env node
// List and read DeepSeek Harness conversations from the local session store.
//
//   node read_sessions.mjs list [--limit 30]
//   node read_sessions.mjs show <session-id-prefix> [--chars 400] [--full]
//
// The store lives under $DSH_HOME/sessions (default ~/.dsh/sessions), one
// directory per session, each holding session.v4.jsonl.zstd.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]); // zstd frame magic
const SESSIONS_ROOT = process.env.DSH_HOME
  ? path.join(process.env.DSH_HOME, 'sessions')
  : path.join(os.homedir(), '.dsh', 'sessions');

// A transcript is many concatenated zstd frames (one per flush). Node decodes
// only the first frame, so split on frame magic and fall back to a longer slice
// when a candidate boundary lands inside a compressed payload.
function decompressAll(buf) {
  const pos = [];
  for (let p = 0; (p = buf.indexOf(MAGIC, p)) !== -1; p++) pos.push(p);
  pos.push(buf.length);
  const out = [];
  let i = 0;
  while (i < pos.length - 1) {
    let j = i + 1;
    let ok = false;
    while (j < pos.length) {
      try {
        out.push(zlib.zstdDecompressSync(buf.subarray(pos[i], pos[j])));
        ok = true;
        break;
      } catch {
        j++;
      }
    }
    if (!ok) break;
    i = j;
  }
  return Buffer.concat(out).toString('utf8');
}

function readRecords(file) {
  const text = decompressAll(fs.readFileSync(file));
  const recs = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      recs.push(JSON.parse(line));
    } catch {
      /* skip a partial or corrupt line */
    }
  }
  return recs;
}

function textOf(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n')
    .trim();
}

// Only genuine typed messages: skip runtime-context / skill-catalog / time-context
// injections, approval notices, and tool results that are also stored as user/message.
function isRealUser(r) {
  return r.type === 'user/message' && r.data?.source?.kind === 'user';
}

function summarize(dir, file) {
  const recs = readRecords(file);
  const head = recs.find((r) => r.type === 'session') ?? {};
  const titles = recs.filter((r) => r.type === 'session/title');
  const title = titles.length ? titles[titles.length - 1].data?.title ?? '' : '';
  const users = recs.filter((r) => isRealUser(r));
  const firstUser = users.length ? textOf(users[0].data?.content) : '';
  const lastTime = recs.reduce((acc, r) => Math.max(acc, r.time ?? 0), head.createdAt ?? 0);
  return {
    id: (head.id ?? path.basename(dir)).replace(/^session-/, ''),
    cwd: head.cwd ?? '',
    createdAt: head.createdAt ?? 0,
    lastTime,
    title,
    userCount: users.length,
    recordCount: recs.length,
    firstUser: firstUser.replace(/\s+/g, ' ').slice(0, 90),
    dir,
    file,
  };
}

function listSessions() {
  if (!fs.existsSync(SESSIONS_ROOT)) return [];
  const rows = [];
  for (const bucket of fs.readdirSync(SESSIONS_ROOT, { withFileTypes: true })) {
    if (!bucket.isDirectory()) continue;
    const bucketPath = path.join(SESSIONS_ROOT, bucket.name);
    for (const s of fs.readdirSync(bucketPath, { withFileTypes: true })) {
      if (!s.isDirectory()) continue;
      const dir = path.join(bucketPath, s.name);
      const file = path.join(dir, 'session.v4.jsonl.zstd');
      if (!fs.existsSync(file)) continue;
      try {
        rows.push(summarize(dir, file));
      } catch (e) {
        rows.push({ id: s.name, dir, error: String(e.message ?? e) });
      }
    }
  }
  return rows.sort((a, b) => (b.lastTime ?? 0) - (a.lastTime ?? 0));
}

function fmt(ts) {
  if (!ts) return '?';
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 16);
}

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0] ?? 'list';
  const flag = (name, dflt) => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? dflt : Number(argv[i + 1]);
  };

  if (cmd === 'list') {
    const limit = flag('limit', 50);
    const rows = listSessions();
    if (!rows.length) {
      console.log(`no sessions under ${SESSIONS_ROOT}`);
      return;
    }
    for (const [i, r] of rows.slice(0, limit).entries()) {
      if (r.error) {
        console.log(`${String(i + 1).padStart(2)}  ERR  ${r.dir}  ${r.error}`);
        continue;
      }
      const turns = `${r.userCount} turn${r.userCount === 1 ? '' : 's'}`;
      console.log(
        `${String(i + 1).padStart(2)}  ${fmt(r.lastTime)}  ${r.id.slice(0, 8)}  ` +
          `(${turns})  ${r.title || r.firstUser}`,
      );
      console.log(`    ${r.cwd}`);
    }
    return;
  }

  if (cmd === 'show') {
    const prefix = argv[1];
    if (!prefix) throw new Error('show needs a session id prefix');
    const hit = listSessions().find((r) => r.id.startsWith(prefix));
    if (!hit) throw new Error(`no session matching "${prefix}"`);
    const chars = flag('chars', 400);
    const full = argv.includes('--full');
    const recs = readRecords(hit.file);
    console.log(`# ${hit.id}  ${fmt(hit.createdAt)}  ${hit.title}`);
    console.log(`# cwd: ${hit.cwd}\n`);
    for (const r of recs) {
      if (isRealUser(r)) {
        const t = textOf(r.data?.content);
        if (t) console.log(`[user] ${full ? t : t.slice(0, chars)}\n`);
      } else if (r.type === 'assistant/message') {
        const t = textOf(r.data?.message?.content);
        if (t) console.log(`[assistant] ${full ? t : t.slice(0, chars)}\n`);
      }
    }
    return;
  }

  console.error('usage: read_sessions.mjs list [--limit N] | show <id-prefix> [--chars N] [--full]');
  process.exitCode = 1;
}

main();