import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

const home = os.homedir();
// A card's folder must be under the home folder, and a Mac's temp folder is not.
const temp = fs.realpathSync.native(os.tmpdir());
const tmp = fs.mkdtempSync(path.join(temp.toLowerCase().startsWith(home.toLowerCase() + path.sep) ? temp : home, 'wb-card-'));
process.env.WB_RUNS = path.join(tmp, 'runs');
process.env.WB_DATA = path.join(tmp, 'data');
// Account folders (.claude-wb-<name>) go in a temp home, so no test touches the real logins.
process.env.WB_HOME = path.join(tmp, 'home');
fs.mkdirSync(process.env.WB_HOME, { recursive: true });
const { attachedIds, cardPause, cardSessions, cardStart, checkInput, defaultsFrom, lastWords, osascriptArgs, sameFolder, shortIdOf, startNext, terminalCommand } = await import('./card.mjs');
const { dirOf, findClaude, resolveAccount } = await import('./accounts.mjs');
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const SESSION = '022f7a44-43dc-459d-9483-7670d5fc8392';
const COPY = '6626b17f-bbc3-46b1-8340-4fa9195b3408';
const COPY2 = '9d1e2f3a-0b4c-4d5e-8f60-718293a4b5c6';
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('accepts a card in a folder under home', () => {
  const r = checkInput({ card: 'break-it-001', folder: tmp, title: 'Break-it: Map <b>it</b>', session: SESSION });
  assert.equal(r.card, 'break-it-001');
  assert.equal(r.folder, tmp);
  assert.equal(r.title, 'Break-it: Map b it /b');
  assert.equal(r.session, SESSION);
  assert.deepEqual([r.model, r.effort, r.restart], ['', '', false]);
});

test('pause input needs no folder', () => {
  assert.deepEqual(checkInput({ card: 'demo-002' }), { card: 'demo-002', session: '' });
});

test('refuses what a hostile page could send', () => {
  assert.throws(() => checkInput({ card: '../x-001', folder: home }), /bad card key/);
  assert.throws(() => checkInput({ card: 'demo-2', folder: home }), /bad card key/);
  assert.throws(() => checkInput({ card: 'demo-002', folder: 'relative\\dir' }), /no folder/);
  assert.throws(() => checkInput({ card: 'demo-002', folder: path.dirname(home) }), /folder not allowed/);
  assert.throws(() => checkInput({ card: 'demo-002', folder: path.join(home, 'no-such-dir-xyz') }), /folder not allowed/);
  assert.throws(() => checkInput({ card: 'demo-002', session: 'abc; rm -rf' }), /bad session id/);
  for (const model of ['Opus', 'claude-opus-5-5', '--dangerously-skip-permissions', null, 1]) assert.throws(() => checkInput({ card: 'demo-002', folder: home, model }), /bad model/);
  for (const effort of ['ultracode', 'HIGH', null]) assert.throws(() => checkInput({ card: 'demo-002', folder: home, effort }), /bad effort/);
  assert.throws(() => checkInput({ card: 'demo-002', folder: home, restart: 'yes' }), /bad restart/);
});

test('takes the models and efforts the board offers', () => {
  const r = checkInput({ card: 'demo-002', folder: tmp, model: 'fable', effort: 'xhigh', restart: true });
  assert.deepEqual([r.model, r.effort, r.restart], ['fable', 'xhigh', true]);
});

test('reads the short id claude --bg prints', () => {
  assert.equal(shortIdOf('backgrounded · 022f7a44 · wb bg probe\n  claude agents   list sessions'), '022f7a44');
  assert.equal(shortIdOf('Workspace not trusted. Run `claude` in C:\\x once'), '');
});

test('one folder whatever the case or trailing slash; nothing matches an empty one', () => {
  const dir = path.join(home, 'Lab', 'Empty');
  assert.ok(sameFolder(dir, dir.toLowerCase() + path.sep));
  assert.ok(!sameFolder(dir, path.dirname(dir)));
  assert.ok(!sameFolder('', ''));
});

test('sessions open in a terminal: `claude attach <short>` in Windows command lines and in a Mac\'s ps output', () => {
  const win = '"C:\\Users\\someone\\.local\\bin\\claude.exe" attach 022f7a44\r\nC:\\Users\\someone\\.local\\bin\\claude.exe --bg -n x\r\n';
  assert.deepEqual([...attachedIds(win)], ['022f7a44']);
  const mac = ['/sbin/launchd', '/Users/someone/.local/bin/claude attach 6626b17f', '-zsh', 'vim attach 9d1e2f3a.md',
    '/usr/bin/osascript -e on run argv -e tell application "Terminal" cd \'/x\' && \'/opt/homebrew/bin/claude\' attach 022f7a44', ''].join('\n');
  assert.deepEqual([...attachedIds(mac)].sort(), ['022f7a44', '6626b17f']);
  assert.equal(attachedIds('').size, 0);
});

test('Open on a Mac: one shell command for Terminal, quoted, with the account\'s folder; passed to osascript as arguments', () => {
  const command = terminalCommand({ folder: "/Users/someone/it's mine", claude: '/Users/someone/.local/bin/claude', short: '022f7a44', configDir: '/Users/someone/.claude-wb-work' });
  assert.equal(command, "cd '/Users/someone/it'\\''s mine' && CLAUDE_CONFIG_DIR='/Users/someone/.claude-wb-work' '/Users/someone/.local/bin/claude' attach 022f7a44");
  assert.equal(terminalCommand({ folder: '/Users/someone/p', claude: '/opt/homebrew/bin/claude', short: '022f7a44', configDir: '' }),
    "cd '/Users/someone/p' && '/opt/homebrew/bin/claude' attach 022f7a44");
  const args = osascriptArgs(command, 'Alpha: "One"; $(x)');
  assert.deepEqual(args.slice(-2), [command, 'Alpha: "One"; $(x)']);
  assert.ok(args.slice(0, -2).every((a, i) => (i % 2 ? !a.includes('Alpha') && !a.includes('/Users') : a === '-e')), 'no input inside the script');
});

test('claude: WORKBENCH_CLAUDE, else the first claude on PATH (a .cmd shim as the exe it runs), else the usual folders', () => {
  const shim = '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n';
  const fnm = 'C:\\Users\\someone\\AppData\\Roaming\\fnm\\aliases\\default';
  const fnmExe = `${fnm}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`;
  const winget = 'C:\\Users\\someone\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Anthropic.ClaudeCode\\claude.exe';
  const win = (files, onPath, env = {}) => findClaude({ platform: 'win32', home: 'C:\\Users\\someone', env: { APPDATA: 'C:\\Users\\someone\\AppData\\Roaming', ...env },
    onPath: () => onPath, exists: f => files.includes(f), read: f => (f.endsWith('.cmd') ? shim : assert.fail(`read ${f}`)) });
  const where = `${fnm}\\claude\r\n${fnm}\\claude.cmd\r\n${winget}\r\n`;
  assert.equal(win([fnmExe, winget], where), fnmExe);
  assert.equal(win([winget], where), winget, 'a shim whose exe is missing is passed over');
  assert.equal(win([fnmExe], where, { WORKBENCH_CLAUDE: 'D:\\tools\\claude.exe' }), 'D:\\tools\\claude.exe');
  assert.equal(win([fnmExe, 'C:\\Users\\someone\\.local\\bin\\claude.exe'], 'INFO: Could not find files for the given pattern(s).\r\n'), fnmExe);
  assert.equal(win(['C:\\Users\\someone\\.local\\bin\\claude.exe'], ''), 'C:\\Users\\someone\\.local\\bin\\claude.exe');
  assert.equal(win(['C:\\Users\\someone\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe'], ''),
    'C:\\Users\\someone\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe');
  assert.equal(win([], ''), '');
  const mac = (files, onPath) => findClaude({ platform: 'darwin', home: '/Users/someone', env: {}, onPath: () => onPath, exists: f => files.includes(f) });
  const nvm = '/Users/someone/.nvm/versions/node/v22.12.0/bin/claude';
  assert.equal(mac([nvm, '/opt/homebrew/bin/claude'], `Last login: today\n/Users/someone\n${nvm}\n`), nvm);
  assert.equal(mac(['/Users/someone/.local/bin/claude', '/opt/homebrew/bin/claude'], "alias claude='~/.claude/local/claude'\n"), '/Users/someone/.local/bin/claude');
  assert.equal(mac(['/opt/homebrew/bin/claude', '/usr/local/bin/claude'], ''), '/opt/homebrew/bin/claude');
  assert.equal(mac(['/usr/local/bin/claude'], ''), '/usr/local/bin/claude');
  assert.equal(mac([], ''), '');
});

test('defaults: what "" runs on, from the settings keys model, effortLevel and modelSettings', () => {
  const modelSettings = { 'claude-opus-5': { effortLevel: 'medium' }, 'claude-opus-5-5': { effortLevel: 'xhigh' }, 'claude-fable-5-1': { effortLevel: 'low' } };
  assert.deepEqual(defaultsFrom({ model: 'fable', effortLevel: 'high', modelSettings }), { model: 'Fable', effort: 'low' });
  assert.deepEqual(defaultsFrom({ model: 'fable', effortLevel: 'xhigh' }), { model: 'Fable', effort: 'xhigh' });
  assert.deepEqual(defaultsFrom({ model: 'fable' }), { model: 'Fable', effort: 'high' });
  assert.deepEqual(defaultsFrom({ model: 'opus', effortLevel: 'low', modelSettings }), { model: 'Opus', effort: 'xhigh' });
  assert.deepEqual(defaultsFrom({ model: 'sonnet', effortLevel: 'low' }), { model: 'Sonnet', effort: 'medium' });
  assert.deepEqual(defaultsFrom({ model: 'opus[1m]', effortLevel: 'low' }), { model: 'opus[1m]', effort: 'low' });
  assert.deepEqual(defaultsFrom({}), { model: '', effort: '' });
  assert.deepEqual(defaultsFrom({ model: 5, modelSettings: 'x' }), { model: '', effort: '' });
});

const working = session => ({ id: session.slice(0, 8), sessionId: session, kind: 'background', cwd: tmp, status: 'busy', state: 'working' });
const said = stdout => ({ status: 0, stdout, stderr: '' });
// A stand-in for the claude CLI; `live` is what `claude agents --json` lists. A resume without flags continues the
// session, any other --bg call starts `copy` (a copy, for a resume with flags).
function fakeClaude(live = [], copy = COPY) {
  const calls = [];
  const run = args => {
    calls.push(args);
    if (args[0] === 'agents') return said(JSON.stringify(live));
    if (args[0] === 'stop') { live.splice(0, live.length, ...live.filter(a => a.id !== args[1])); return said(''); }
    const session = args.includes('--resume') && !args.includes('-n') ? args[args.indexOf('--resume') + 1] : copy;
    live.push(working(session));
    return said(`backgrounded · ${session.slice(0, 8)} · x`);
  };
  return { run, calls, bg: () => calls.find(a => a[0] === '--bg'), stops: () => calls.filter(a => a[0] === 'stop').map(a => a[1]) };
}
const seed = (card, rec) => { fs.mkdirSync(process.env.WB_RUNS, { recursive: true }); fs.writeFileSync(path.join(process.env.WB_RUNS, `${card}.json`), JSON.stringify({ folder: tmp, title: card, at: '2026-01-01T00:00:00', ...rec })); };
const record = card => JSON.parse(fs.readFileSync(path.join(process.env.WB_RUNS, `${card}.json`), 'utf8'));
const input = (card, more) => ({ card, folder: tmp, title: card, ...more });
const tail = args => args.slice(args.indexOf('-n'));

test('a new session starts on the card\'s model and effort, and records them', () => {
  const c = fakeClaude();
  const out = cardStart(input('mo-001', { model: 'sonnet', effort: 'low' }), { run: c.run });
  assert.deepEqual(out, { ok: true, session: COPY, resumed: false });
  assert.deepEqual(tail(c.bg()), ['-n', 'mo-001', '--model', 'sonnet', '--effort', 'low', '--add-dir', ROOT]);
  assert.deepEqual([record('mo-001').model, record('mo-001').effort], ['sonnet', 'low']);
});

test('a started session is written onto its card on this PC, only when it changed', async () => {
  const { write, get } = await import('./db.mjs');
  write({ op: 'set', path: 'cards/mo-040', data: { title: 'x', session: '' } });
  cardStart(input('mo-040'), { run: fakeClaude().run });
  assert.equal(get('cards/mo-040').data.session, COPY);
  const v = get('cards/mo-040').version;
  cardStart(input('mo-040', { session: COPY }), { run: fakeClaude([working(COPY)]).run });
  assert.equal(get('cards/mo-040').version, v, 'no write when the session is the same');
  cardStart(input('mo-041'), { run: fakeClaude().run });
  assert.equal(get('cards/mo-041'), null, 'a card that is not on the board is not created');
});

test('a failed start moves the card back on this PC and says so; a card moved on meanwhile stays', async () => {
  const { write, get } = await import('./db.mjs');
  const log = [{ at: '2026-11-08T10:00', who: 'you', text: 'planned' }, { at: '2026-11-08T11:00', who: 'you', text: '→ doing' }, { at: '2026-11-08T11:00', who: 'worker', text: 'note' }];
  write({ op: 'set', path: 'cards/mo-050', data: { title: 'x', status: 'doing', updated: '2026-11-08T11:00', log } });
  const revert = { status: 'ready', updated: '2026-11-08T10:00', at: '2026-11-08T11:00', text: '→ doing' };
  const out = cardStart(input('mo-050', { account: 'nope', revert }), { run: fakeClaude().run });
  assert.deepEqual([out.ok, out.error, out.reverted], [false, 'no_account', true]);
  assert.equal(get('cards/mo-050').data.status, 'ready');
  assert.deepEqual(get('cards/mo-050').data.log.map(l => l.text), ['planned', 'note']);
  write({ op: 'update', path: 'cards/mo-050', data: { status: 'backlog' } });
  assert.equal(cardStart(input('mo-050', { account: 'nope', revert }), { run: fakeClaude().run }).reverted, undefined);
  assert.equal(get('cards/mo-050').data.status, 'backlog');
});

test('a new session on the defaults passes no model or effort', () => {
  const c = fakeClaude();
  cardStart(input('mo-002'), { run: c.run });
  assert.deepEqual(tail(c.bg()), ['-n', 'mo-002', '--add-dir', ROOT]);
  assert.deepEqual([record('mo-002').model, record('mo-002').effort], ['', '']);
});

test('same model and effort: a plain resume, as before', () => {
  seed('mo-003', { session: SESSION, short: SESSION.slice(0, 8), model: 'opus', effort: 'high' });
  const c = fakeClaude();
  const out = cardStart(input('mo-003', { session: SESSION, model: 'opus', effort: 'high' }), { run: c.run });
  assert.deepEqual(out, { ok: true, session: SESSION, resumed: true });
  assert.equal(c.bg().length, 4);
  assert.deepEqual(c.bg().slice(0, 3), ['--bg', '--resume', SESSION]);
  assert.match(c.bg()[3], /moved back to Doing/);
});

test('a stopped session on another effort continues as a copy with every flag again; the card gets the new id', () => {
  seed('mo-004', { session: SESSION, short: SESSION.slice(0, 8), model: 'sonnet', effort: 'low' });
  const c = fakeClaude();
  const out = cardStart(input('mo-004', { session: SESSION, model: 'sonnet', effort: 'high' }), { run: c.run });
  assert.deepEqual(out, { ok: true, session: COPY, resumed: true, switched: true });
  assert.deepEqual(c.bg().slice(0, 3), ['--bg', '--resume', SESSION]);
  assert.deepEqual(tail(c.bg()), ['-n', 'mo-004', '--model', 'sonnet', '--effort', 'high', '--add-dir', ROOT]);
  assert.deepEqual([record('mo-004').session, record('mo-004').model, record('mo-004').effort], [COPY, 'sonnet', 'high']);
});

test('ultracode: started with the ultracode settings file and recorded; switching it on resumes as a copy', () => {
  const file = path.join(ROOT, 'host', 'ultracode.settings.json');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).ultracode, true);
  const c = fakeClaude();
  cardStart(input('mo-020', { model: 'opus', ultracode: true }), { run: c.run });
  assert.deepEqual(tail(c.bg()), ['-n', 'mo-020', '--model', 'opus', '--settings', file, '--add-dir', ROOT]);
  assert.equal(record('mo-020').ultracode, true);
  seed('mo-021', { session: SESSION, short: SESSION.slice(0, 8), model: '', effort: '' });
  const d = fakeClaude();
  assert.equal(cardStart(input('mo-021', { session: SESSION, ultracode: true }), { run: d.run }).switched, true);
  assert.deepEqual(tail(d.bg()), ['-n', 'mo-021', '--settings', file, '--add-dir', ROOT]);
  assert.throws(() => checkInput({ card: 'demo-002', folder: home, ultracode: 'yes' }), /bad ultracode/);
});

test('accounts: "" is workbench once it is set up, else ~/.claude; another name must be set up; names are checked', () => {
  assert.equal(resolveAccount(''), '');
  assert.throws(() => resolveAccount('work'), /work is not set up/);
  assert.throws(() => resolveAccount('../x'), /bad account/);
  assert.throws(() => checkInput({ card: 'demo-002', folder: home, account: 'Work Acc' }), /bad account/);
  fs.mkdirSync(dirOf('workbench'), { recursive: true });
  assert.equal(resolveAccount(''), 'workbench');
  fs.rmSync(dirOf('workbench'), { recursive: true });
});

test('a card on a new account starts a new conversation there, recorded with its account; a missing account says how to add it', () => {
  seed('mo-030', { session: SESSION, short: SESSION.slice(0, 8), model: '', effort: '' });
  fs.mkdirSync(dirOf('work'), { recursive: true });
  const c = fakeClaude();
  const out = cardStart(input('mo-030', { session: SESSION, account: 'work' }), { run: c.run });
  assert.deepEqual(out, { ok: true, session: COPY, resumed: false });
  assert.ok(!c.bg().includes('--resume'));
  assert.deepEqual([record('mo-030').account, record('mo-030').session, record('mo-030').from], ['work', COPY, [SESSION]]);
  const again = fakeClaude([working(COPY)]);
  assert.equal(cardStart(input('mo-030', { session: SESSION, account: 'work' }), { run: again.run }).already, true, 'the old id maps to the new session');
  fs.rmSync(dirOf('work'), { recursive: true });
  const missing = cardStart(input('mo-031', { account: 'work' }), { run: fakeClaude().run });
  assert.equal(missing.error, 'no_account');
  assert.match(missing.message, /node host\/accounts\.mjs add work/);
});

test('lastWords: the last main-thread text, TLDR line only, plain and capped; nothing for a missing file', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'words-')), 's.jsonl');
  const said = (text, more = {}) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] }, ...more });
  fs.writeFileSync(file, [
    said('older answer'),
    said('**TLDR:** I can\'t reach the `board`, so nothing\nwas written.\n\n**What I checked**\n- a'),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] } }),
    said('a sub-agent talking', { isSidechain: true }),
    JSON.stringify({ type: 'system', subtype: 'turn_duration' }),
  ].join('\n'));
  assert.equal(lastWords(file), "I can't reach the board, so nothing was written.");
  fs.appendFileSync(file, '\n' + said('x'.repeat(400)));
  assert.equal(lastWords(file).length, 240);
  assert.equal(lastWords(path.join(tmp, 'nope.jsonl')), '');
});

test('back to the defaults: a copy with only the name and the folder', () => {
  seed('mo-005', { session: SESSION, model: 'haiku', effort: 'low' });
  const c = fakeClaude();
  cardStart(input('mo-005', { session: SESSION }), { run: c.run });
  assert.deepEqual(tail(c.bg()), ['-n', 'mo-005', '--add-dir', ROOT]);
  assert.deepEqual([record('mo-005').model, record('mo-005').effort], ['', '']);
});

test('a session with no record of its options counts as on the defaults', () => {
  seed('mo-006', { session: SESSION });
  const c = fakeClaude();
  assert.deepEqual(cardStart(input('mo-006', { session: SESSION }), { run: c.run }), { ok: true, session: SESSION, resumed: true });
  const d = fakeClaude();
  assert.equal(cardStart(input('mo-006', { session: SESSION, model: 'opus' }), { run: d.run }).switched, true);
});

test('a working session is left alone until Switch now', () => {
  seed('mo-007', { session: SESSION, model: '', effort: '' });
  const c = fakeClaude([working(SESSION)]);
  const out = cardStart(input('mo-007', { session: SESSION, model: 'opus' }), { run: c.run });
  assert.deepEqual(out, { ok: true, session: SESSION, resumed: true, already: true, pending: true });
  assert.deepEqual(c.calls, [['agents', '--json']]);
  assert.equal(record('mo-007').model, '');
  const same = fakeClaude([working(SESSION)]);
  assert.deepEqual(cardStart(input('mo-007', { session: SESSION, restart: true }), { run: same.run }), { ok: true, session: SESSION, resumed: true, already: true });
});

test('Switch now stops the working session first, then continues it as a copy', () => {
  seed('mo-008', { session: SESSION, model: '', effort: '' });
  const c = fakeClaude([working(SESSION)]);
  const out = cardStart(input('mo-008', { session: SESSION, model: 'opus', effort: 'max', restart: true }), { run: c.run });
  assert.deepEqual(out, { ok: true, session: COPY, resumed: true, switched: true });
  assert.deepEqual(c.stops(), [SESSION.slice(0, 8)]);
  assert.ok(c.calls.findIndex(a => a[0] === 'stop') < c.calls.findIndex(a => a[0] === '--bg'));
  assert.match(c.bg()[3], /switched it to another model or effort/);
  assert.deepEqual(tail(c.bg()), ['-n', 'mo-008', '--model', 'opus', '--effort', 'max', '--add-dir', ROOT]);
});

test('Switch now does not start a copy when the working session would not stop', () => {
  seed('mo-009', { session: SESSION });
  const c = fakeClaude([working(SESSION)]);
  const run = args => (args[0] === 'stop' ? { status: 1, stdout: '', stderr: 'nope' } : c.run(args));
  const out = cardStart(input('mo-009', { session: SESSION, model: 'opus', restart: true }), { run });
  assert.equal(out.error, 'stop_failed');
  assert.equal(c.bg(), undefined);
});

test('a queued card keeps what it asked for, and `next` starts it on that', () => {
  const other = { id: 'bbbb0001', sessionId: 'bbbb0001-0000-4000-8000-000000000000', kind: 'background', cwd: tmp, status: 'busy', state: 'working', name: 'other card' };
  seed('mo-010', { session: SESSION, short: SESSION.slice(0, 8), model: 'sonnet', effort: '' });
  const c = fakeClaude([other]);
  assert.equal(cardStart(input('mo-010', { session: SESSION, model: 'opus', effort: 'high' }), { run: c.run }).waiting, true);
  assert.deepEqual([record('mo-010').model, record('mo-010').ask], ['sonnet', { model: 'opus', effort: 'high', ultracode: false, account: '' }]);
  const n = fakeClaude();
  const out = startNext(tmp, other.sessionId, n.run);
  assert.equal(out.started, 'mo-010');
  assert.deepEqual(tail(n.bg()), ['-n', 'mo-010', '--model', 'opus', '--effort', 'high', '--add-dir', ROOT]);
  assert.deepEqual([record('mo-010').model, record('mo-010').effort, record('mo-010').waiting], ['opus', 'high', undefined]);
});

test('a card another helper is starting right now is not started twice, also during a slow start; a stale or dead holder\'s lock is taken over', () => {
  const lock = path.join(process.env.WB_RUNS, 'mo-011.lock');
  fs.mkdirSync(process.env.WB_RUNS, { recursive: true });
  fs.writeFileSync(lock, String(process.ppid));
  const ago = min => { const t = new Date(Date.now() - min * 60 * 1000); fs.utimesSync(lock, t, t); };
  const c = fakeClaude();
  ago(4);
  assert.deepEqual(cardStart(input('mo-011'), { run: c.run }), { ok: true, already: true, pending: true, message: 'Another start of this card is still under way. Try again in a minute.' });
  assert.deepEqual(c.calls, []);
  ago(11);
  assert.equal(cardStart(input('mo-011'), { run: c.run }).ok, true);
  assert.ok(c.bg());
  assert.ok(!fs.existsSync(lock));
  fs.writeFileSync(lock, String(spawnSync(process.execPath, ['-e', '']).pid));
  const d = fakeClaude();
  assert.equal(cardStart(input('mo-011'), { run: d.run }).ok, true);
  assert.ok(d.bg(), 'a dead holder\'s lock is taken over at once');
  assert.ok(!fs.existsSync(lock));
});

test('card_sessions returns each card\'s model and effort and what "" means', () => {
  seed('mo-012', { session: SESSION, model: 'haiku', effort: 'max' });
  const out = cardSessions();
  assert.deepEqual(Object.keys(out.defaults).sort(), ['effort', 'efforts', 'model']);
  assert.deepEqual(Object.keys(out.defaults.efforts).sort(), ['fable', 'haiku', 'opus', 'sonnet']);
  const c = out.cards.find(x => x.card === 'mo-012');
  assert.deepEqual([c.model, c.effort, c.at], ['haiku', 'max', '2026-01-01T00:00:00']);
  assert.deepEqual([out.cards.find(x => x.card === 'mo-002').model, out.cards.find(x => x.card === 'mo-002').effort], ['', '']);
});

test('the board still sends an id a switch made here replaced: start, pause and the record follow the current session', () => {
  seed('mo-013', { session: COPY, short: COPY.slice(0, 8), model: 'opus', effort: '', from: [SESSION] });
  const same = fakeClaude([working(COPY)]);
  assert.deepEqual(cardStart(input('mo-013', { session: SESSION, model: 'opus' }), { run: same.run }), { ok: true, session: COPY, resumed: true, already: true });
  const c = fakeClaude([working(COPY)], COPY2);
  const out = cardStart(input('mo-013', { session: SESSION, model: 'sonnet', restart: true }), { run: c.run });
  assert.deepEqual(out, { ok: true, session: COPY2, resumed: true, switched: true });
  assert.deepEqual(c.stops(), [COPY.slice(0, 8)]);
  assert.deepEqual(c.bg().slice(0, 3), ['--bg', '--resume', COPY]);
  assert.deepEqual([record('mo-013').session, record('mo-013').from], [COPY2, [SESSION, COPY]]);
  const p = fakeClaude([working(COPY2)]);
  const paused = cardPause({ card: 'mo-013', session: SESSION }, { run: p.run });
  assert.deepEqual([paused.paused, paused.session, p.stops()], [true, COPY2, [COPY2.slice(0, 8)]]);
});

test('a pause during a start in another helper stops the new session by the short id recorded first', () => {
  seed('mo-014', { session: SESSION, short: COPY2.slice(0, 8) });
  const p = fakeClaude([working(COPY2)]);
  const out = cardPause({ card: 'mo-014' }, { run: p.run });
  assert.deepEqual([out.paused, out.session, p.stops()], [true, COPY2, [COPY2.slice(0, 8)]]);
});

test('a --bg whose output names no session: the one new session in the folder is recorded, so it counts', () => {
  const c = fakeClaude([], COPY2);
  const run = args => { const r = c.run(args); return args[0] === '--bg' ? said('started in the background') : r; };
  assert.deepEqual(cardStart(input('mo-015'), { run }), { ok: true, session: COPY2, resumed: false });
  assert.deepEqual([record('mo-015').session, record('mo-015').short], [COPY2, COPY2.slice(0, 8)]);
  const none = args => said(args[0] === 'agents' ? '[]' : 'something else');
  assert.equal(cardStart(input('mo-016'), { run: none }).error, 'start_failed');
});

test('a session list whose fields changed is unreadable, never "nothing runs"', () => {
  const list = rows => args => (args[0] === 'agents' ? said(JSON.stringify(rows)) : said(`backgrounded · ${SESSION.slice(0, 8)} · x`));
  const renamed = [{ id: SESSION.slice(0, 8), sessionId: SESSION, type: 'background', cwd: tmp, state: 'working' }];
  assert.equal(cardStart(input('mo-017', { session: SESSION }), { run: list(renamed) }).error, 'agents_failed');
  const today = [{ pid: 25360, cwd: tmp, kind: 'interactive', sessionId: COPY2, status: 'idle' }, { id: 'bbbb0002', cwd: home, kind: 'background', sessionId: 'bbbb0002-0000-4000-8000-000000000000', state: 'blocked' }];
  assert.equal(cardStart(input('mo-017', { session: SESSION }), { run: list(today) }).ok, true);
});
