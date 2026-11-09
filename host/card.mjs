// Runs the Claude session of one board card as a Claude Code background session (`claude --bg`).
// Called by the workbench-host tools (card_start, card_pause, card_open, card_sessions), which the board calls through
// the Claude desktop app and the night task calls as an MCP tool. Pause is `claude stop` (the conversation is kept);
// start on a card that already has a session resumes it, as a copy under a new id when its model or effort changed.
import { execFile, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACCOUNT_NAME, BIN, CLAUDE, NO_CLAUDE, accountEnv, accounts, configDir, dirOf, resolveAccount, syncAccount } from './accounts.mjs';
import { get as getDoc, write as writeDoc } from './db.mjs';

export { CLAUDE };
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(here);
// WB_RUNS: tests keep their records in a temp folder.
const RUNS = process.env.WB_RUNS || path.join(here, 'runs');
const CARD_KEY = /^[a-z0-9][a-z0-9-]{0,60}-\d{3}$/;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// "" = the user's default from Claude Code settings: the session starts without --model / --effort.
const MODELS = ['', 'haiku', 'sonnet', 'opus', 'fable'];
const STATUSES = ['backlog', 'ready', 'doing', 'blocked', 'review', 'done'];
const EFFORTS = ['', 'low', 'medium', 'high', 'xhigh', 'max'];
// A file, not inline JSON, so no Windows command-line quoting stands between the CLI and the setting. Nobody answers
// prompts in a card session, so it also allows the Workflow tool that ultracode launches.
const ULTRACODE = path.join(here, 'ultracode.settings.json');

const stamp = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 19);
function log(card, line) {
  fs.mkdirSync(RUNS, { recursive: true });
  const text = `${stamp()} ${card} ${line}\n`;
  fs.appendFileSync(path.join(RUNS, 'cards.log'), text);
  fs.appendFileSync(path.join(RUNS, `${card}.log`), text);
}
const fail = (card, error, message) => { log(card, `${error}: ${message}`); return { ok: false, error, message }; };

// Tool input comes from a web page, so nothing in it is trusted: the card key must look like one, the folder must be a
// real directory under the home folder, and the prompts are written here, never taken from the input.
export function checkInput(input = {}) {
  const card = typeof input.card === 'string' ? input.card : '';
  if (!CARD_KEY.test(card)) throw new Error('bad card key');
  const session = input.session === undefined || input.session === '' ? '' : input.session;
  if (session && (typeof session !== 'string' || !SESSION_ID.test(session))) throw new Error('bad session id');
  const model = input.model === undefined ? '' : input.model;
  if (!MODELS.includes(model)) throw new Error('bad model');
  const effort = input.effort === undefined ? '' : input.effort;
  if (!EFFORTS.includes(effort)) throw new Error('bad effort');
  if (input.restart !== undefined && typeof input.restart !== 'boolean') throw new Error('bad restart');
  if (input.ultracode !== undefined && typeof input.ultracode !== 'boolean') throw new Error('bad ultracode');
  const account = input.account === undefined ? '' : input.account;
  if (account !== '' && (typeof account !== 'string' || !ACCOUNT_NAME.test(account))) throw new Error('bad account');
  if (input.folder === undefined) return { card, session };
  // An empty or relative folder would resolve against wherever this process happened to start.
  if (typeof input.folder !== 'string' || !path.isAbsolute(input.folder)) throw new Error('no folder');
  const folder = path.resolve(input.folder);
  const home = os.homedir().toLowerCase() + path.sep;
  if (!folder.toLowerCase().startsWith(home) || !fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) throw new Error(`folder not allowed: ${folder}`);
  const title = (typeof input.title === 'string' ? input.title : card).replace(/[^\p{L}\p{N} .,:;!?()'#&+\-/]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || card;
  // The board's move into Doing, undone here when the start fails (the page may no longer be allowed to write by then).
  const r = input.revert;
  const revert = r && typeof r === 'object' && STATUSES.includes(r.status) ? { status: r.status, updated: String(r.updated || ''), at: String(r.at || ''), text: String(r.text || '') } : null;
  return { card, session, folder, title, model, effort, ultracode: input.ultracode === true, account, revert, restart: input.restart === true };
}

// `claude --bg` prints "backgrounded · <first 8 hex of the session id> · <name>".
export const shortIdOf = out => /backgrounded\s*·\s*([0-9a-f]{8})\b/.exec(out)?.[1] || '';
export const sameFolder = (a, b) => !!a && !!b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

// The CLI as one Workbench account ("" = ~/.claude): its own login, background sessions and transcripts.
const envOf = account => ({ ...process.env, PATH: `${BIN}${path.delimiter}${process.env.PATH || ''}`, ...accountEnv(account) });
const claudeAs = account => (args, cwd, timeout = 60 * 1000) =>
  spawnSync(CLAUDE, args, { cwd, env: envOf(account), encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout });
const said = res => `${res.stdout || ''}${res.stderr || ''}${res.error ? ` ${res.error.message}` : ''}`.trim();
const isGit = folder => spawnSync('git', ['-C', folder, 'rev-parse', '--is-inside-work-tree'], { windowsHide: true }).status === 0;

// Background sessions that are alive now. A stopped session is not listed; a finished one is listed as state "done".
// null when the list could not be read: treating that as "nothing runs" would resume a working session as a copy.
// A renamed field counts as unreadable too: it would make every session look stopped.
function liveSessions(run) {
  try {
    const all = JSON.parse(run(['agents', '--json'], ROOT, 30 * 1000).stdout);
    const bg = Array.isArray(all) && all.every(a => typeof a?.kind === 'string' && typeof a.sessionId === 'string') ? all.filter(a => a.kind === 'background') : null;
    return bg && bg.every(a => typeof a.id === 'string' && (a.status || a.state)) ? bg : null;
  } catch { return null; }
}
const NO_LIST = 'Could not read the list of Claude background sessions (claude agents --json). Try again.';

// One record per card in runs/<card>.json: { session, short, folder, title, at, model, effort, account, from, waiting?,
// behind?, ask? }. account: the Workbench account the session runs as ("" or missing = ~/.claude).
// model and effort are what the session was started with; a queued card keeps the ones it asked for in ask.
// from: the ids this card's session had before switches made here.
const stateFile = card => path.join(RUNS, `${card}.json`);
const readState = card => { try { return JSON.parse(fs.readFileSync(stateFile(card), 'utf8')); } catch { return null; } };
const writeState = (card, rec) => { fs.mkdirSync(RUNS, { recursive: true }); fs.writeFileSync(stateFile(card), JSON.stringify(rec)); };
const records = () => (fs.existsSync(RUNS) ? fs.readdirSync(RUNS) : [])
  .filter(f => f.endsWith('.json') && CARD_KEY.test(f.slice(0, -5))).map(f => ({ card: f.slice(0, -5), ...readState(f.slice(0, -5)) }));
const bySession = () => new Map(records().filter(r => r.session).map(r => [r.session, r]));
// The board learns a card's session only once, so after a switch made here (the night check, `next`) it still sends the
// old id: an id this card's session had before maps to the current one.
const currentOf = (given, rec) => (given && rec?.session && rec.from?.includes(given) ? rec.session : given);

// `state` in `claude agents` is the session's own summary and can stay "working" after its turn ended (measured
// 2026-11-05); `status` says whether a turn runs. A session started in the last 2 minutes may not have begun its first
// turn yet, and one waiting on its own background task is idle between turns: both still count as running.
const RECENT_MS = 2 * 60 * 1000;
const recent = rec => !!rec?.at && Date.now() - new Date(rec.at).getTime() < RECENT_MS;
// ~/.claude/jobs is not a stable interface: read only to avoid stopping a session mid-task; unreadable means no tasks.
const jobTasks = (short, account) => { try { return JSON.parse(fs.readFileSync(path.join(configDir(account), 'jobs', short, 'state.json'), 'utf8')).inFlight?.tasks || 0; } catch { return 0; } };
const busyNow = a => (a.status ? a.status === 'busy' : a.state === 'working');
// A card whose session has handed its folder on (`next`) is finished even if a background task it left behind still runs.
const running = (a, rec) => busyNow(a) || (!rec?.closed && (recent(rec) || jobTasks(a.id, rec?.account || '') > 0));

// A finished background session stays alive and idle until stopped. Stop the cards' finished ones (their conversation is
// kept for a later resume), never anyone else's, and never one that waits for an answer. ponytail: runs on each start
// and pause, not on a timer.
function stopFinished(live, except, run) {
  const ours = bySession();
  const done = live.filter(a => ours.has(a.sessionId) && a.sessionId !== except && a.state !== 'blocked' && !running(a, ours.get(a.sessionId)));
  if (!done.length) return;
  const watched = attached();
  for (const a of done) if (!watched.has(a.id)) run(['stop', a.id], ROOT, 30 * 1000);
}

// Short ids of sessions open in a terminal (Open session runs `claude attach <short>`): stopping one would close it.
// `text`: one process command line per line.
export const attachedIds = text => new Set(text.split('\n').filter(l => /claude/i.test(l))
  .flatMap(l => [...l.matchAll(/\battach\s+"?([0-9a-f]{8})\b/g)].map(m => m[1])));
function attached() {
  const res = process.platform === 'win32'
    ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "Get-CimInstance Win32_Process -Filter \"Name='claude.exe'\" | ForEach-Object { $_.CommandLine }"],
      { encoding: 'utf8', windowsHide: true, timeout: 20 * 1000 })
    : spawnSync('ps', ['-axo', 'command='], { encoding: 'utf8', timeout: 20 * 1000 });
  return attachedIds(res.stdout || '');
}

// Card sessions run unattended: a question asked in their chat waits forever, so every decision goes on the card.
const UNATTENDED = ' Nobody reads this session\'s chat while it works. Never wait for approval in chat and skip skills that do '
  + '(brainstorming, writing-plans and the like): a decision you cannot make goes on the card as a question (work procedure step 5).';
const SKILL = path.join(ROOT, '.claude', 'skills', 'work', 'SKILL.md');
const startPrompt = card => `Workbench card ${card}. Read ${path.join(ROOT, 'CLAUDE.md')}, then follow ${SKILL} for this card only. `
  + 'It was started for you (the user moved it to Doing, or the night task picked it): claim it and work. Skip the step that files the session '
  + `under a sidebar group and sets its title: this is a background session, not a desktop app session.${UNATTENDED}`;
const MOVED = 'it was moved back to Doing (by the user, or by the night task), so carry on where you stopped. Moving it out of Doing paused you by stopping this session';
const SWITCHED = 'the user switched it to another model or effort, so carry on where you stopped. The switch restarted this session';
const resumePrompt = (card, why = MOVED) => `Workbench card ${card}: ${why}, possibly in the middle of a step. Re-read the card on the board first (its answer, `
  + 'acceptance and log may have changed), check the state of the files and the branch, then continue the work procedure in '
  + `${SKILL} for this card only. Claim it with the log line "resumed", not "started".${UNATTENDED}`;

// Two helper copies (the desktop app's, a Claude Code session's, a card's `next`) may start one card at the same moment.
// A lock is stale once its holder is dead, or after longer than a start with every CLI call at its timeout (~5 minutes).
// ponytail: two takeovers of one stale lock at the same moment can both win.
const LOCK_STALE_MS = 10 * 60 * 1000;
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
function lockCard(card) {
  const file = path.join(RUNS, `${card}.lock`);
  const take = () => { try { fs.writeFileSync(file, String(process.pid), { flag: 'wx' }); return true; } catch (e) { if (e.code === 'EEXIST') return false; throw e; } };
  fs.mkdirSync(RUNS, { recursive: true });
  if (take()) return file;
  try {
    const pid = Number(fs.readFileSync(file, 'utf8'));
    if ((!pid || alive(pid)) && Date.now() - fs.statSync(file).mtimeMs < LOCK_STALE_MS) return '';
    fs.rmSync(file, { force: true });
  } catch { /* released meanwhile */ }
  return take() ? file : '';
}
const unlockCard = file => { try { if (fs.readFileSync(file, 'utf8') === String(process.pid)) fs.rmSync(file, { force: true }); } catch { /* taken over and released */ } };

const runsOn = o => `${o.model || 'default model'}, ${o.effort || 'default effort'}${o.ultracode ? ', ultracode' : ''}`;

// `ignore`: a session that is about to end (the one handing its folder to the next card) does not count as busy.
// `run` stands in for the claude CLI in tests; the tools pass one argument, so a page never reaches it.
export function cardStart(input, { ignore = '', run } = {}) {
  const ask = checkInput(input);
  if (!ask.folder) throw new Error('no folder');
  const out = startAs(ask, ignore, run);
  return out.ok === false && ask.revert && moveBack(ask.card, ask.revert) ? { ...out, reverted: true } : out;
}

function startAs(ask, ignore, run) {
  let account;
  try { account = resolveAccount(ask.account); } catch (e) { return fail(ask.card, 'no_account', `Claude ${e.message}, then move the card to Doing again.`); }
  const lock = lockCard(ask.card);
  if (!lock) {
    log(ask.card, 'start: another start of this card is under way');
    return { ok: true, already: true, pending: true, message: 'Another start of this card is still under way. Try again in a minute.' };
  }
  try { return startCard({ ...ask, account }, ignore, run || claudeAs(account)); } finally { unlockCard(lock); }
}

// Back where the board had it, keeping log lines written meanwhile; only that move's own line goes. Not if a newer move
// already took the card out of Doing.
function moveBack(card, r) {
  try {
    const cur = getDoc(`cards/${card}`);
    if (!cur || cur.data.status !== 'doing') return false;
    const log = (Array.isArray(cur.data.log) ? cur.data.log : []).filter(l => !(l?.who === 'you' && l.at === r.at && l.text === r.text));
    writeDoc({ op: 'update', path: `cards/${card}`, data: { status: r.status, updated: r.updated, log }, ifVersion: cur.version });
    return true;
  } catch { return false; }
}

// The session a `--bg` call started: by the short id it printed, else (its output changed) the one new background session
// in the folder, so a session that started is never left unrecorded and uncounted.
// ponytail: two cards starting in one git folder at the same moment, with that output change, both fail as unknown.
function startedSession(after, before, short, session, folder) {
  if (!after) return null;
  if (short) return after.find(a => a.id === short) || null;
  const fresh = after.filter(a => sameFolder(a.cwd, folder) && (a.sessionId === session || !before.some(b => b.sessionId === a.sessionId)));
  return fresh.length === 1 ? fresh[0] : null;
}

function startCard({ card, folder, title, session: given, model, effort, ultracode, account, restart }, ignore, run) {
  if (!fs.existsSync(CLAUDE)) return fail(card, 'no_claude', NO_CLAUDE);
  // The card's own session, else the one recorded here under the same title (a card the night task started, which the
  // board has not seen yet). A card key reused after a delete has another title, so it never resumes the old conversation.
  // A session lives in its account's login: on another account (or one set up since) the card starts a new conversation.
  const rec = readState(card);
  const sameAccount = (rec?.account || '') === account;
  let session = sameAccount ? currentOf(given, rec) || (rec?.session && rec.title === title ? rec.session : '') : '';
  // A session with no record here was started before cards had a model: on the default.
  const was = rec?.session === session ? { model: rec.model || '', effort: rec.effort || '', ultracode: rec.ultracode === true } : { model: '', effort: '', ultracode: false };
  const from = sameAccount ? [...(session && rec?.session === session ? rec.from || [] : [])] : [...(rec?.from || []), ...(rec?.session ? [rec.session] : [])];
  const switching = !!session && (model !== was.model || effort !== was.effort || ultracode !== was.ultracode);
  const live = liveSessions(run);
  if (!live) return fail(card, 'agents_failed', NO_LIST);
  stopFinished(live, session, run);
  const ours = bySession();
  const mine = session && live.find(a => a.sessionId === session);
  const working = !!mine && running(mine, ours.get(session));
  // A working session switches only on Switch now (restart): anything else would cut it off mid-step.
  if (working && !(switching && restart)) {
    log(card, `start: already running as ${mine.id}${switching ? `, stays on ${runsOn(was)} until Switch now` : ''}`);
    return { ok: true, session, resumed: true, already: true, ...(switching && { pending: true }) };
  }
  // Outside git there is no worktree per card, so two sessions in one folder would overwrite each other's files: queue.
  const busy = live.find(a => a.sessionId !== session && a.sessionId !== ignore && sameFolder(a.cwd, folder) && running(a, ours.get(a.sessionId)));
  if (busy && !isGit(folder)) {
    const behind = busy.name || busy.id;
    // A card already queued keeps its place: a retry (the night task's hourly pick) must not send it to the back.
    const at = rec?.waiting && sameFolder(rec.folder, folder) ? rec.at : stamp();
    writeState(card, { session, short: rec?.session === session ? rec?.short || '' : '', folder, title, at, waiting: true, behind, ...was, account: session ? account : rec?.account || '', from, ask: { model, effort, ultracode, account } });
    log(card, `waiting: ${folder} is busy with ${behind}`);
    return { ok: true, waiting: true, behind, session };
  }
  // A finished (or answer-waiting) session is still alive: stop it so the resume below continues it instead of a copy.
  // A working one left running would work the card beside its switched copy.
  if (mine) {
    const res = run(['stop', mine.id], ROOT, 30 * 1000);
    if (working && res.status !== 0) return fail(card, 'stop_failed', `Could not stop ${mine.id} to switch it: ${said(res).slice(0, 200) || `exit ${res.status}`}`);
  }

  const resumed = !!session;
  syncAccount(account);
  // A resumed background session keeps the options it was started with. Any flag makes the CLI start a copy under a new
  // id with the whole conversation but only the flags passed now, so a switch passes -n and --add-dir again (measured
  // 2026-11-06, CLI 2.1.319). --add-dir takes several values, so it goes last.
  const named = ['-n', title, ...(model ? ['--model', model] : []), ...(effort ? ['--effort', effort] : []),
    ...(ultracode ? ['--settings', ULTRACODE] : []), '--add-dir', ROOT];
  const res = resumed
    ? run(['--bg', '--resume', session, resumePrompt(card, working ? SWITCHED : MOVED), ...(switching ? named : [])], folder)
    : run(['--bg', startPrompt(card), ...named], folder);
  const out = said(res);
  if (/not trusted/i.test(out)) return fail(card, 'not_trusted', `Claude Code does not trust ${folder} yet. Open a terminal there, run claude once and accept the trust prompt, then move the card to Doing again.`);
  let short = shortIdOf(out);
  if (!short || !session.startsWith(short)) {
    // A new session or a copy, already working. Its short id is recorded first, so a pause that arrives meanwhile can stop
    // it; the old id stays until the new one is known.
    if (short) writeState(card, { session, short, folder, title, at: stamp(), ...was, account, from });
    const fresh = startedSession(liveSessions(run), live, short, session, folder);
    if (!fresh && !short) return fail(card, 'start_failed', out.split('\n').slice(-2).join(' ').slice(0, 300) || `exit ${res.status}`);
    if (!fresh) {
      run(['stop', short], ROOT, 30 * 1000);
      return fail(card, 'start_failed', `Started ${short} but could not read its session id, so it was stopped. Try again.`);
    }
    if (session && fresh.sessionId !== session) from.push(session);
    ({ id: short, sessionId: session } = fresh);
  }
  writeState(card, { session, short, folder, title, at: stamp(), model, effort, ultracode, account, from });
  log(card, `${switching ? 'switch' : resumed ? 'resume' : 'start'}: ${short} (${session}) in ${folder} as "${title}" on ${runsOn({ model, effort, ultracode })}${account ? ` as account ${account}` : ''}`);
  // The card carries its session for the board and later starts. Only the helper writes it: the page writes only on clicks.
  try { if (getDoc(`cards/${card}`)?.data?.session !== session) writeDoc({ op: 'update', path: `cards/${card}`, data: { session } }); } catch { /* the card was deleted meanwhile */ }
  // Not imported into the desktop app: once the app holds a session, a background resume starts a copy (measured
  // 2026-11-05). card_open shows it in a terminal window instead, and the board shows its state.
  return { ok: true, session, resumed, ...(switching && { switched: true }) };
}

// Starts the oldest card waiting for this folder, if the folder is free now, on the model and effort it asked for.
// `run` is only for tests: each card starts as its own account.
export function startNext(folder, ignore = '', run = undefined) {
  const next = records().filter(r => r.waiting && sameFolder(r.folder, folder)).sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))[0];
  if (!next) return { ok: true, started: '' };
  const ask = next.ask || { model: next.model, effort: next.effort, ultracode: next.ultracode, account: next.account };
  const out = cardStart({ card: next.card, folder: next.folder, title: next.title, session: next.session || '', model: ask.model, effort: ask.effort, ultracode: ask.ultracode === true, account: ask.account || '' }, { ignore, run });
  return { ...out, started: out.ok && !out.waiting ? next.card : '' };
}

export function cardPause(input, { run } = {}) {
  const { card, session: given } = checkInput(input);
  const rec = readState(card);
  // A card that left Doing while it waited for its folder leaves the queue.
  if (rec?.waiting) { writeState(card, { ...rec, waiting: false }); log(card, 'pause: left the queue'); return { ok: true, paused: false, unqueued: true }; }
  const session = currentOf(given, rec) || rec?.session || '';
  if (!session && !rec?.short) { log(card, 'pause: no session'); return { ok: true, paused: false }; }
  // The session is stopped as the account it runs as; the next queued card starts as its own.
  const runAs = run || claudeAs(rec?.account || '');
  const live = liveSessions(runAs);
  if (!live) return fail(card, 'agents_failed', NO_LIST);
  stopFinished(live, session, runAs);
  // By its short id: a start under way in another helper records that before the full id.
  const mine = live.find(a => a.sessionId === session) || (rec?.short && live.find(a => a.id === rec.short));
  if (!mine) {
    log(card, 'pause: not running');
    // Its session ended without handing the folder on (a crash, an early stop): free the queue now.
    const next = rec?.folder ? startNext(rec.folder, session, run) : { started: '' };
    return { ok: true, paused: false, session, next: next.started || '' };
  }
  const res = runAs(['stop', mine.id], ROOT, 30 * 1000);
  if (res.status !== 0) return fail(card, 'pause_failed', said(res).slice(0, 300) || `exit ${res.status}`);
  log(card, `pause: stopped ${mine.id}`);
  // Its folder is free now: a card queued behind it starts.
  const next = startNext(rec?.folder || mine.cwd, mine.sessionId, run);
  return { ok: true, paused: true, session: mine.sessionId, next: next.started || '' };
}

const sq = s => `'${String(s).replace(/'/g, `'\\''`)}'`;
// Terminal.app runs this in the user's own shell, not in this environment, so the account's folder goes in the command.
export const terminalCommand = ({ folder, claude, short, configDir }) =>
  `cd ${sq(folder)} && ${configDir ? `CLAUDE_CONFIG_DIR=${sq(configDir)} ` : ''}${sq(claude)} attach ${short}`;
// The command and title reach AppleScript as arguments, never as script text.
export const osascriptArgs = (command, title) => ['-e', 'on run argv', '-e', 'tell application "Terminal"', '-e', 'activate',
  '-e', 'set t to do script (item 1 of argv)', '-e', 'set custom title of t to (item 2 of argv)', '-e', 'end tell', '-e', 'end run', command, title];

// Opens the card's session in a terminal window (`claude attach`; Windows Terminal, or Terminal on a Mac): watch it work
// and type to it. A paused session comes back idle with its conversation; one viewer at a time (a new window takes over).
export function cardOpen(input) {
  const { card, session: given } = checkInput(input);
  const rec = readState(card);
  const session = currentOf(given, rec) || rec?.session || '';
  if (!session) return fail(card, 'no_session', 'This card has no Claude session yet. Move it to Doing to start one.');
  const account = rec?.session === session ? rec.account || '' : '';
  const short = (liveSessions(claudeAs(account)) || []).find(a => a.sessionId === session)?.id || (rec?.session === session && rec.short) || session.slice(0, 8);
  const folder = rec?.folder || ROOT;
  if (process.platform !== 'win32') {
    const command = terminalCommand({ folder, claude: CLAUDE, short, configDir: account ? dirOf(account) : '' });
    // A first Open waits on the Mac's prompt that lets the app control Terminal.
    return new Promise(resolve => execFile('osascript', osascriptArgs(command, rec?.title || card), { timeout: 60 * 1000 }, (e, _out, err) =>
      resolve(e ? fail(card, 'open_failed', `Could not open Terminal: ${String(err || e.message).trim().slice(0, 300)}`) : (log(card, `open: ${short}`), { ok: true, opened: short, session }))));
  }
  // wt.exe splits its command line at every unescaped ';', even inside a quoted title.
  const title = (rec?.title || card).replace(/;/g, '\\;');
  // A new tab may get Windows Terminal's environment, not this one's, so an account's folder is set by a one-line script.
  let command = [CLAUDE, 'attach', short];
  if (account) {
    const launcher = path.join(RUNS, `${card}.open.cmd`);
    fs.writeFileSync(launcher, `@set "CLAUDE_CONFIG_DIR=${dirOf(account)}"\r\n@"${CLAUDE}" attach ${short}\r\n`);
    command = ['cmd.exe', '/c', launcher];
  }
  return new Promise(resolve => {
    const p = spawn('wt.exe', ['-w', 'new', '--title', title, ...command], { cwd: folder, env: envOf(account), detached: true, stdio: 'ignore' });
    p.once('error', e => resolve(fail(card, 'open_failed', `Could not open Windows Terminal (wt.exe): ${e.message}`)));
    p.once('spawn', () => { p.unref(); log(card, `open: ${short}`); resolve({ ok: true, opened: short, session }); });
  });
}

// What "" on a card runs on, from the user settings. ponytail: the ids the aliases point at today; a new model
// generation needs them updated.
const ALIASES = { haiku: ['Haiku', 'claude-haiku-5-5'], sonnet: ['Sonnet', 'claude-sonnet-5-5'], opus: ['Opus', 'claude-opus-5-5'], fable: ['Fable', 'claude-fable-5-1'] };
export function defaultsFrom({ model, effortLevel, modelSettings } = {}) {
  const str = v => (typeof v === 'string' ? v : '');
  const known = ALIASES[str(model).toLowerCase()];
  if (!known) return { model: str(model), effort: str(effortLevel) };
  const [name, id] = known;
  // The top-level effortLevel counts for Fable 5.1 but not for the 5.5 models, which default to medium (CLI 2.1.319).
  return { model: name, effort: str(modelSettings?.[id]?.effortLevel) || (name === 'Fable' ? str(effortLevel) || 'high' : 'medium') };
}
const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
// Also each model's own default effort, for a card that picks a model but leaves effort on default.
function sessionDefaults() {
  let settings;
  try { settings = JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); } catch { return { model: '', effort: '', efforts: {} }; }
  return { ...defaultsFrom(settings), efforts: Object.fromEntries(Object.keys(ALIASES).map(k => [k, defaultsFrom({ ...settings, model: k }).effort])) };
}

// A session's transcript: Claude Code names the folder after the session's start folder, every other character a dash.
const transcriptOf = (folder, session, account) => path.join(process.env.WB_PROJECTS || path.join(configDir(account), 'projects'),
  String(folder || '').replace(/[^A-Za-z0-9]/g, '-'), `${session}.jsonl`);
const TAIL_BYTES = 256 * 1024;
const WHY_MAX = 240;

// The last thing a session said, as one plain line (its TLDR when it wrote one): why it needs the user or stopped. A
// session that cannot reach the board can only say it in its chat, so the board reads it here. '' when unknown.
export function lastWords(file) {
  let tail;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const buf = Buffer.alloc(Math.min(size, TAIL_BYTES));
      fs.readSync(fd, buf, 0, buf.length, size - buf.length);
      tail = buf.toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch { return ''; }
  for (const line of tail.split('\n').reverse()) {
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.type !== 'assistant' || o.isSidechain) continue;
    const said = (Array.isArray(o.message?.content) ? o.message.content : []).filter(b => b?.type === 'text').map(b => b.text).join('\n').trim();
    if (!said) continue;
    const first = said.split(/\n\s*\n/)[0].replace(/\*\*TLDR:\*\*|TLDR:/i, '').replace(/[*`_]/g, '').replace(/\s+/g, ' ').trim();
    return first.length > WHY_MAX ? `${first.slice(0, WHY_MAX - 1).trimEnd()}…` : first;
  }
  return '';
}

// What the board shows on each card: its session, whether it is working, waiting for you (blocked), done, stopped, or
// queued behind another card, the model and effort it was started on ("" = defaults), and for a session that stopped
// (blocked or done) its last words; and the Workbench accounts set up on this PC. Read-only. `run` is only for tests.
export function cardSessions({ run } = {}) {
  const recs = records();
  const lives = new Map([...new Set(recs.map(r => r.account || ''))].map(acc => [acc, liveSessions(run || claudeAs(acc))]));
  return {
    ok: true,
    defaults: sessionDefaults(),
    accounts: accounts(),
    cards: recs.map(r => {
      const live = lives.get(r.account || '');
      const a = live?.find(x => x.sessionId === r.session);
      const state = r.waiting ? 'waiting' : !a ? (live ? 'stopped' : 'unknown') : running(a, r) ? 'working' : a.state === 'blocked' ? 'blocked' : 'done';
      const why = (state === 'blocked' || state === 'done') && r.session ? lastWords(transcriptOf(r.folder, r.session, r.account || '')) : '';
      return { card: r.card, title: r.title || '', session: r.session || '', state, behind: r.waiting ? r.behind || '' : '', model: r.model || '', effort: r.effort || '', account: r.account || '', at: r.at || '', ...(why && { why }) };
    }),
  };
}

// `node host/card.mjs next <card>`: a card session runs this as its last step, so the next card queued for its folder
// starts while this one ends.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, card] = process.argv.slice(2);
  if (cmd !== 'next' || !CARD_KEY.test(card || '')) { console.log('usage: node host/card.mjs next <card key>'); process.exit(2); }
  const rec = readState(card);
  if (rec?.session) writeState(card, { ...rec, closed: true });
  console.log(JSON.stringify(rec?.folder ? startNext(rec.folder, rec.session || '') : { ok: true, started: '' }));
}
