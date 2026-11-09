// Workbench host: a minimal MCP server over stdio. The Claude desktop app runs it for the board (card_start, card_pause,
// card_open, card_sessions, keep-awake, and db_read/db_write/db_delete for the board's data on this PC; the page calls
// them as host:workbench-host) and Claude Code sessions run it too
// (keep-awake, open_link). Every copy also runs the night check timer (night.mjs). On Windows also the workbench://
// protocol handler for the keep-awake link a board in Chrome fires. Zero dependencies.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { cardOpen, cardPause, cardSessions, cardStart } from './card.mjs';
import { rev, snapshot, write } from './db.mjs';
import { startNightTimer } from './night.mjs';
import { openFile } from './open-file.mjs';
import { usage } from './usage.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const PID_FILE = path.join(here, 'keep-awake.pid');
const SCRIPT = path.join(here, 'keep-awake.ps1');
const WIN = process.platform === 'win32';
// -i is the Windows request (no idle sleep, the screen still locks); -s holds off system sleep too, which macOS honours
// only on AC power, where the night shift has to run anyway.
const CAFFEINATE = ['-i', '-s'];

// Keep awake = the computer does not sleep while keep-awake.ps1 (Windows) or caffeinate (Mac) runs: a "don't sleep"
// request, no fake input. ON_FILE marks it wanted, so every start of this helper (the desktop app opening) brings it back.
const ON_FILE = path.join(here, 'keep-awake.on');

function readPid() {
  try { return Number(fs.readFileSync(PID_FILE, 'utf8').trim()) || null; } catch { return null; }
}

// After a reboot process ids are reused: only our keep-awake process counts, and only that one is ever killed.
function ours(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); } catch { return false; }
  try {
    if (!WIN) return /(^|\/)caffeinate -i -s$/.test(execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 20000 }).trim());
    const cmd = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`], { windowsHide: true, encoding: 'utf8', timeout: 20000 });
    return /keep-awake\.ps1/i.test(cmd);
  } catch { return false; }
}

function status() {
  const pid = readPid();
  const running = ours(pid);
  if (!running && pid) fs.rmSync(PID_FILE, { force: true });
  return { running, pid: running ? pid : null, wanted: fs.existsSync(ON_FILE) };
}

function start() {
  fs.writeFileSync(ON_FILE, '');
  const s = status();
  if (s.running) return s;
  let pid;
  if (WIN) {
    // Start-Process gives the script its own hidden console and a life independent of this server
    // (a plain detached spawn makes powershell.exe exit at once, and an attached one dies with us).
    const launch = `$p = Start-Process powershell.exe -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File','${SCRIPT.replace(/'/g, "''")}') -WindowStyle Hidden -PassThru; $p.Id`;
    pid = Number(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', launch], { windowsHide: true, encoding: 'utf8' }).trim());
  } else {
    // Its own process group, so it outlives this helper when the desktop app quits.
    const p = spawn('caffeinate', CAFFEINATE, { detached: true, stdio: 'ignore' });
    p.on('error', () => {});
    p.unref();
    pid = p.pid;
    if (!pid) throw new Error('could not start caffeinate');
  }
  fs.writeFileSync(PID_FILE, String(pid));
  return { running: ours(pid), pid, wanted: true };
}

function stop() {
  fs.rmSync(ON_FILE, { force: true });
  const pid = readPid();
  if (ours(pid)) {
    try { if (WIN) execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); else process.kill(pid); } catch { /* already gone */ }
  }
  fs.rmSync(PID_FILE, { force: true });
  return { running: false, pid: null, wanted: false };
}

// Hands a link to the OS so the registered app opens it (slack://, ms-outlook:, https://). Only these schemes.
const OPENABLE = /^(https?:\/\/|slack:\/\/|ms-outlook:|mailto:)/i;
function openLink({ url } = {}) {
  if (typeof url !== 'string' || !OPENABLE.test(url) || /[\r\n"]/.test(url)) throw new Error('refused: not an openable link');
  // The URL goes in as data, never as code: inside a PowerShell string, $(...) would run.
  if (WIN) execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Start-Process -FilePath $env:WB_URL'], { env: { ...process.env, WB_URL: url }, windowsHide: true, timeout: 10000 });
  else execFileSync(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { timeout: 10000 });
  return { opened: url };
}

const CARD_INPUT = {
  card: { type: 'string', description: 'Card key, <project slug>-<NNN>' },
  session: { type: 'string', description: 'The card\'s session id from an earlier start, if any' },
};
const TOOLS = [
  { name: 'card_start', description: 'Start the card\'s own Claude background session in its project folder, or resume it when the card already has one. A changed model or effort resumes the same conversation under a new session id (store the returned session); a working session switches only with restart, else it keeps running and the answer has pending. Returns { ok, session, resumed, switched?, already?, pending?, waiting?, behind? } or { ok: false, error, message }.',
    inputSchema: { type: 'object', properties: { ...CARD_INPUT, folder: { type: 'string', description: 'The project folder, absolute' }, title: { type: 'string' },
      model: { type: 'string', enum: ['', 'haiku', 'sonnet', 'opus', 'fable'], description: '"" = the default from Claude Code settings' },
      effort: { type: 'string', enum: ['', 'low', 'medium', 'high', 'xhigh', 'max'], description: '"" = the default from Claude Code settings' },
      ultracode: { type: 'boolean', description: 'Start the session with ultracode on (it plans multi-agent workflows)' },
      account: { type: 'string', description: 'The project\'s Workbench account (its own Claude login, host/accounts.mjs); "" = workbench' },
      revert: { type: 'object', description: 'The board\'s move into Doing ({ status, updated, at, text }): on a failed start the card goes back to status and loses that log line' },
      restart: { type: 'boolean', description: 'Switch now: stop a working session and resume it on the new model or effort' } }, required: ['card', 'folder'] },
    annotations: { readOnlyHint: false, destructiveHint: false } },
  { name: 'card_pause', description: 'Pause the card\'s Claude background session (claude stop). Its conversation is kept for a later card_start. A card waiting for its folder leaves the queue.',
    inputSchema: { type: 'object', properties: CARD_INPUT, required: ['card'] },
    annotations: { readOnlyHint: false, destructiveHint: false } },
  { name: 'card_open', description: 'Open the card\'s Claude session in a terminal window on this PC (claude attach), to watch it and type to it.',
    inputSchema: { type: 'object', properties: CARD_INPUT, required: ['card'] },
    annotations: { readOnlyHint: false, destructiveHint: false } },
  { name: 'card_sessions', description: 'Every card that has a Claude session on this PC: { cards: [{ card, title, session, state: working|blocked|done|stopped|waiting, behind, model, effort, at, why? }], defaults: { model, effort } }. why: a blocked or done session\'s last words, one line. A card\'s model and effort are what its session was started on, "" for the defaults; defaults is what "" means in Claude Code settings.',
    inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
  { name: 'open_link', description: 'Open a slack://, ms-outlook: or https:// link with the app registered for it on this machine.',
    inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    annotations: { readOnlyHint: false, destructiveHint: false } },
  { name: 'open_file', description: 'Open a document (md, txt, csv, pdf, docx, xlsx, pptx, png, jpg) that lies inside a board project\'s folder: .md and .txt in a text editor (Notepad on Windows), the rest with their default app. Returns { opened }.',
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Absolute path' } }, required: ['path'] },
    annotations: { readOnlyHint: false, destructiveHint: false } },
  { name: 'keep_awake_status', description: 'Is keep awake (the PC must not sleep) running, and is it switched on?', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
  { name: 'keep_awake_start', description: 'Keep the PC from sleeping (a "don\'t sleep" request to the OS; the screen still locks). Stays on, also after the desktop app restarts, until keep_awake_stop.', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: false, destructiveHint: false } },
  { name: 'keep_awake_stop', description: 'Let the PC sleep again as usual.', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: false, destructiveHint: false } },
  { name: 'usage', description: 'Claude plan usage on this PC (a reading is reused for 10 minutes) and the night check\'s last status: { ok, at, windows: [{ key, label, pct, resetsAt }], night: { at, state: day|idle|started|capped|broken|busy, message, started, usagePct, cap } | null, lastNight: { from, to, used } | null }; on failure ok: false, error, message and the last windows marked stale.',
    inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
];
// The board's own data lives on this PC (host/db.mjs). Reads are polled; writes come from the user's clicks on the board.
const DB_PATH = { type: 'string', description: 'cards/<key>, projects/<slug> or machine/<name>' };
TOOLS.push(
  { name: 'db_read', description: 'The board\'s documents on this PC: { ok, rev, unchanged } when nothing changed since `since`, else { ok, rev, docs: { cards, projects, machine: [{ id, version, updatedAt, data }] } }.',
    inputSchema: { type: 'object', properties: { since: { type: 'number', description: 'The rev of the last answer' } } }, annotations: { readOnlyHint: true } },
  { name: 'db_write', description: 'Create (set) or change (update: merge top-level fields, arrays replace, { "__delete__": true } removes a field) one board document on this PC. Returns { ok, version, rev } or { ok: false, error, message }.',
    inputSchema: { type: 'object', properties: { path: DB_PATH, op: { type: 'string', enum: ['set', 'update'] }, data: { type: 'object' }, ifVersion: { type: 'number' } }, required: ['path', 'op', 'data'] },
    annotations: { readOnlyHint: false, destructiveHint: false } },
  { name: 'db_delete', description: 'Delete one board document on this PC (a card or project the board deletes, with Undo on the board). Returns { ok, deleted, rev }.',
    inputSchema: { type: 'object', properties: { path: DB_PATH } , required: ['path'] }, annotations: { readOnlyHint: false, destructiveHint: true } },
);
const dbCall = fn => input => { try { return { ok: true, ...fn(input), rev: rev() }; } catch (e) { return { ok: false, error: e.code || 'failed', message: e.message, ...(e.version !== undefined && { version: e.version }) }; } };
const dbRead = dbCall(({ since }) => snapshot(typeof since === 'number' ? since : undefined));
const dbWrite = dbCall(({ path: p, op, data, ifVersion }) => (op === 'set' || op === 'update' ? write({ op, path: p, data, ifVersion }) : (() => { throw Object.assign(new Error('op is set or update'), { code: 'bad_op' }); })()));
const dbDelete = dbCall(({ path: p }) => write({ op: 'delete', path: p }));

// usage() takes test hooks as options: the page's arguments must never reach them.
const HANDLERS = { card_start: cardStart, card_pause: cardPause, card_open: cardOpen, card_sessions: cardSessions, open_link: openLink, open_file: input => openFile(input, { folders: snapshot().docs.projects.map(d => d.data?.repo) }), keep_awake_status: status, keep_awake_start: start, keep_awake_stop: stop, usage: () => usage(), db_read: dbRead, db_write: dbWrite, db_delete: dbDelete };

// `node host/server.mjs --url "workbench://keep-awake?interval=60"`: Windows runs this for workbench:// links
// clicked in a board opened in Chrome (registered by register-protocol.ps1). Nothing else depends on it.
const urlArg = process.argv.indexOf('--url');
if (urlArg > 0) {
  const u = new URL(process.argv[urlArg + 1] || 'workbench://none');
  if (u.protocol === 'workbench:' && (u.hostname === 'start' || u.hostname === 'stop')) {
    // Old boards fired these links. Ignored: endpoint security killed a card session started under Chrome, so cards
    // start through the card_start tool.
    fs.mkdirSync(path.join(here, 'runs'), { recursive: true });
    fs.appendFileSync(path.join(here, 'runs', 'cards.log'), `${new Date().toISOString()} ignored old link workbench://${u.hostname}\n`);
  } else if (u.protocol === 'workbench:' && u.hostname === 'keep-awake') {
    const out = u.searchParams.has('off') ? stop() : start();
    fs.writeFileSync(path.join(here, 'last-url.log'), `${new Date().toISOString()} ${u.href} -> ${JSON.stringify(out)}
`);
  }
  process.exit(0);
} else {
// The app starts this helper when it opens: bring keep awake back if it is switched on. ponytail: two helpers starting
// at once can each launch one; both only hold the same request.
setTimeout(() => { try { if (status().wanted && !status().running) start(); } catch { /* the board shows it off */ } }, 3000);
startNightTimer();
const send = msg => process.stdout.write(JSON.stringify(msg) + '\n');
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

readline.createInterface({ input: process.stdin }).on('line', line => {
  let msg;
  // A BOM can precede the first line (PowerShell pipes do this); real clients never send one.
  try { msg = JSON.parse(line.replace(/^﻿/, '')); } catch { return; }
  const { id, method, params = {} } = msg;
  if (method === 'initialize') {
    reply(id, { protocolVersion: params.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'workbench-host', version: '0.3.0' } });
  } else if (method === 'ping') {
    reply(id, {});
  } else if (method === 'tools/list') {
    reply(id, { tools: TOOLS });
  } else if (method === 'tools/call') {
    const fn = HANDLERS[params.name];
    if (!fn) return fail(id, -32602, `unknown tool ${params.name}`);
    Promise.resolve().then(() => fn(params.arguments || {})).then(
      out => reply(id, { content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: out }),
      err => reply(id, { content: [{ type: 'text', text: String(err?.message || err) }], isError: true }));
  } else if (id !== undefined) {
    fail(id, -32601, `unknown method ${method}`);
  }
});
}
