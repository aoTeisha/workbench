import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { decide, holdsLock, readBoard, startInput, takeLock, tick } from './night.mjs';
import { batch } from './db.mjs';
import { lastNight, nightOf, powerFromPmset, readNightStatus, recordReading, stamp, usage, windowsOf } from './usage.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'night-test-'));
const at = (...a) => new Date(2026, 10, ...a);
const local = d => stamp(d).slice(0, 16);
const WEEK = [{ key: 'seven_day', label: 'This week · all models', pct: 10, resetsAt: '2026-11-13T22:00:00.000Z' }];

test('reads the board from its files: open cards, projects, machine/night and machine/cards; usage from the reader', async () => {
  process.env.WB_DATA = tmp();
  batch([
    { op: 'set', path: 'projects/alpha', data: { name: 'Alpha', status: 'active' } },
    { op: 'set', path: 'cards/alpha-001', data: { project: 'alpha', status: 'ready' } },
    { op: 'set', path: 'cards/alpha-002', data: { project: 'alpha', status: 'done' } },
    { op: 'set', path: 'machine/night', data: { cap: 70 } },
  ]);
  const r = await readBoard({ readUsage: async () => ({ ok: true, windows: WEEK }) });
  assert.deepEqual([r.ok, r.cards.map(c => c.key), r.projects.map(p => p.key), r.night, r.defaults, r.windows], [true, ['alpha-001'], ['alpha'], { cap: 70 }, null, WEEK]);
  assert.equal((await readBoard({ readUsage: async () => ({ ok: false, windows: WEEK }) })).windows, null, 'a failed reading is no reading');
  delete process.env.WB_DATA;
});

test('machine/cards fills what a card leaves empty; a card\'s own pick wins; no doc changes nothing', () => {
  const project = { key: 'alpha', name: 'Alpha', repo: 'C:\\a' };
  const defaults = { model: 'sonnet', effort: 'low', ultracode: true };
  assert.deepEqual(startInput({ card: { key: 'alpha-001', title: 'One' }, project, defaults }),
    { card: 'alpha-001', folder: 'C:\\a', title: 'Alpha: One', session: '', model: 'sonnet', effort: 'low', ultracode: true });
  assert.deepEqual(startInput({ card: { key: 'alpha-002', title: 'Two', model: 'opus', effort: 'high' }, project, defaults: null }),
    { card: 'alpha-002', folder: 'C:\\a', title: 'Alpha: Two', session: '', model: 'opus', effort: 'high' });
  const d = decide({ cards: [{ key: 'alpha-003', project: 'alpha', status: 'ready', priority: 1, log: [] }], projects: [{ ...project, status: 'active' }],
    night: null, defaults, windows: [{ key: 'seven_day', pct: 5 }], now: new Date('2026-11-08T22:00') });
  assert.equal(d.candidates[0].defaults, defaults);
});

test('usage windows: fraction to percent, ISO reset, every window labelled', () => {
  const w = windowsOf([{ type: 'rate_limit_event', rate_limit_info: { unifiedWindows: {
    seven_day: { utilization: 0.725, resetsAt: 1794578400 }, five_hour: { utilization: 0.07, resetsAt: 1794000000 }, seven_day_opus: { utilization: 0.5, resetsAt: 1794578400 } } } }]);
  assert.deepEqual(w.map(x => [x.key, x.label, x.pct]), [['seven_day', 'This week · all models', 72.5], ['five_hour', 'This session (5 hours)', 7], ['seven_day_opus', 'Seven day opus', 50]]);
  assert.equal(w[0].resetsAt, '2026-11-13T14:00:00.000Z');
  assert.equal(windowsOf([{ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }]), null);
});

const board = (cards, extra = {}) => ({ cards, projects: [{ key: 'alpha', name: 'Alpha', status: 'active', repo: 'C:\\a' }, { key: 'beta', name: 'Beta', status: 'paused', repo: 'C:\\b' }], night: null, windows: WEEK, ...extra });
const NOW = at(6, 22, 0);
const card = (n, fields) => ({ key: `alpha-${String(n).padStart(3, '0')}`, id: n, project: 'alpha', title: `Card ${n}`, priority: 2, created: '2026-11-01', updated: local(at(6, 21, 0)), log: [], ...fields });
const keys = d => d.candidates.map(c => c.card.key);

test('dispatch order: oldest unclaimed, then oldest stranded, then ready by priority and created; running left alone', () => {
  const cards = [
    card(1, { status: 'ready', priority: 2, created: '2026-11-01' }),
    card(2, { status: 'ready', priority: 1, created: '2026-11-03' }),
    card(3, { status: 'ready', priority: 1, created: '2026-11-02' }),
    card(4, { status: 'doing', updated: local(at(6, 21, 30)), log: [{ at: local(at(6, 21, 30)), who: 'you', text: '→ doing' }] }),
    card(5, { status: 'doing', updated: local(at(6, 21, 0)), log: [{ at: local(at(6, 21, 0)), who: 'you', text: '→ doing' }] }),
    card(6, { status: 'doing', updated: local(at(6, 21, 55)), log: [{ at: local(at(6, 21, 55)), who: 'you', text: '→ doing' }] }),
    card(7, { status: 'doing', updated: local(at(6, 21, 40)), log: [{ at: local(at(6, 21, 40)), who: 'worker', text: 'paused — run the tests' }] }),
    card(8, { status: 'doing', updated: local(at(6, 18, 0)), log: [{ at: local(at(6, 18, 0)), who: 'worker', text: 'started' }] }),
    card(9, { status: 'doing', updated: local(at(6, 21, 0)), log: [{ at: local(at(6, 21, 0)), who: 'worker', text: 'started' }] }),
    card(10, { status: 'review' }),
  ];
  const d = decide({ ...board(cards), now: NOW });
  assert.equal(d.state, 'go');
  assert.deepEqual(keys(d), ['alpha-005', 'alpha-004', 'alpha-008', 'alpha-007', 'alpha-003', 'alpha-002', 'alpha-001']);
});

test('cards of a project that is not active never start', () => {
  const d = decide({ ...board([{ ...card(1, { status: 'ready' }), key: 'beta-001', project: 'beta' }]), now: NOW });
  assert.deepEqual([d.state, d.candidates.length], ['idle', 0]);
});

test('a Ready card naming "after #NNN" or "after #<title>" waits until that card is done, and the idle status says so', () => {
  const later = card(2, { status: 'ready', goal: 'Build it, after #1.' });
  const d = decide({ ...board([card(1, { status: 'review' }), later]), now: NOW });
  assert.deepEqual([keys(d), d.reason], [[], 'nothing to start; #2 waits for #1']);
  assert.deepEqual(keys(decide({ ...board([card(1, { status: 'done' }), later]), now: NOW })), ['alpha-002']);
  assert.deepEqual(keys(decide({ ...board([later]), now: NOW })), ['alpha-002'], 'the read leaves done cards out: one not there is done');
  const byTitle = card(3, { status: 'ready', goal: 'Write it up, after #Card 1 and its notes.' });
  assert.deepEqual(keys(decide({ ...board([card(1, { status: 'blocked' }), byTitle]), now: NOW })), []);
  assert.deepEqual(keys(decide({ ...board([card(1, { status: 'blocked' }), card(3, { status: 'ready', goal: 'after #Card 9' })]), now: NOW })), ['alpha-003']);
  const moved = card(4, { status: 'doing', goal: 'after #1', log: [{ at: local(at(6, 21, 0)), who: 'you', text: '→ doing' }] });
  assert.deepEqual(keys(decide({ ...board([card(1, { status: 'review' }), moved]), now: NOW })), ['alpha-004'], 'a card moved to Doing was started on purpose');
});

test('week limit: at or over the cap starts nothing; no doc, null or 0 is no limit; a bad cap is broken', () => {
  const cards = [card(1, { status: 'ready' })];
  const at70 = [{ ...WEEK[0], pct: 70 }];
  assert.equal(decide({ ...board(cards, { windows: at70, night: { cap: 70 } }), now: NOW }).state, 'capped');
  assert.equal(decide({ ...board(cards, { windows: at70, night: { cap: 70 } }), now: NOW }).reason, 'the week is at 70%, your limit is 70%');
  assert.equal(decide({ ...board(cards, { windows: at70, night: { cap: 71 } }), now: NOW }).state, 'go');
  for (const night of [null, { cap: null }, { cap: 0 }, {}]) assert.equal(decide({ ...board(cards, { windows: at70, night }), now: NOW }).state, 'go');
  assert.equal(decide({ ...board(cards, { night: { cap: '70' } }), now: NOW }).state, 'broken');
});

test('no usage reading starts nothing', () => {
  const d = decide({ ...board([card(1, { status: 'ready' })], { windows: null }), now: NOW });
  assert.deepEqual([d.state, d.reason], ['broken', 'the reply had no usage reading']);
});

const sessions = (...states) => () => ({ ok: true, cards: states.map((state, i) => ({ card: `x-00${i}`, state })) });

test('tick starts the first candidate, skips one that waits, and writes the status and log', async () => {
  const runs = tmp();
  const calls = [];
  const replies = { 'alpha-001': { ok: true, waiting: true, behind: 'x' }, 'alpha-002': { ok: true, session: 's', resumed: false } };
  const s = await tick({ power: () => null, now: at(7, 2, 10), runs, read: async () => ({ ok: true, ...board([card(1, { status: 'ready', priority: 1 }), card(2, { status: 'ready', session: '022f7a44-43dc-459d-9483-7670d5fc8392', model: 'opus', effort: 'high' })]) }),
    sessions: sessions('working'), start: input => { calls.push(input); return replies[input.card]; } });
  assert.equal(s.state, 'started');
  assert.equal(s.message, '02:10 started #2 Card 2');
  assert.deepEqual(s.started, ['alpha-002']);
  assert.deepEqual(calls[1], { card: 'alpha-002', folder: 'C:\\a', title: 'Alpha: Card 2', session: '022f7a44-43dc-459d-9483-7670d5fc8392', model: 'opus', effort: 'high' });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(runs, 'night.json'), 'utf8')).started, ['alpha-002']);
  assert.match(fs.readFileSync(path.join(runs, 'night.log'), 'utf8'), /started 02:10 started #2 Card 2 \[alpha-002\]/);
});

const readyCards = n => async () => ({ ok: true, ...board(Array.from({ length: n }, (_, i) => card(i + 1, { status: 'ready', created: `2026-11-0${i + 1}` }))) });

test('tick: answers "waits" and "already running" use no attempt; at most 3 attempts; a failure moves on and is reported', async () => {
  const calls = [];
  const replies = { 'alpha-001': { ok: false, error: 'not_trusted', message: 'not trusted' }, 'alpha-002': { ok: true, waiting: true }, 'alpha-003': { ok: true, already: true } };
  const s = await tick({ power: () => null, now: at(7, 2, 10), runs: tmp(), read: readyCards(6), sessions: sessions(),
    start: input => { calls.push(input.card); return replies[input.card] || { ok: false, error: 'x', message: 'nope' }; } });
  assert.deepEqual(calls, ['alpha-001', 'alpha-002', 'alpha-003', 'alpha-004', 'alpha-005']);
  assert.equal(s.state, 'broken');
  assert.equal(s.message, '02:10 check failed: could not start #1 Card 1: not trusted; could not start #4 Card 4: nope; could not start #5 Card 5: nope');
  const queued = await tick({ power: () => null, now: at(7, 2, 10), runs: tmp(), read: readyCards(4), sessions: sessions(),
    start: input => (input.card === 'alpha-004' ? { ok: true, session: 's', resumed: false } : { ok: true, waiting: true }) });
  assert.deepEqual(queued.started, ['alpha-004'], 'cards waiting for their folder do not hold back the rest');
});

test('tick: a card whose session ended within 30 minutes of its start waits for a later check', async () => {
  const calls = [];
  const live = () => ({ ok: true, cards: [{ card: 'alpha-001', state: 'stopped', at: stamp(at(7, 1, 50)) }, { card: 'alpha-002', state: 'stopped', at: stamp(at(7, 1, 0)) }] });
  const start = input => { calls.push(input.card); return { ok: true, session: 's', resumed: true }; };
  const s = await tick({ power: () => null, now: at(7, 2, 10), runs: tmp(), read: readyCards(2), sessions: live, start });
  assert.deepEqual([calls, s.message], [['alpha-002'], '02:10 resumed #2 Card 2']);
  const idle = await tick({ power: () => null, now: at(7, 2, 10), runs: tmp(), read: readyCards(1), sessions: live, start });
  assert.deepEqual([idle.state, idle.message], ['idle', '02:10 nothing to start: #1 Card 1 stopped soon after its last start']);
});

test('tick: two working sessions means busy; a lost lock starts nothing; the day does nothing', async () => {
  const runs = tmp();
  const read = async () => ({ ok: true, ...board([card(1, { status: 'ready' })]) });
  const start = () => assert.fail('must not start');
  assert.equal((await tick({ power: () => null, now: at(7, 2, 10), runs, read, sessions: sessions('working', 'working', 'blocked'), start })).state, 'busy');
  const lock = path.join(runs, 'night.lock');
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid + 1, at: new Date().toISOString() }));
  assert.equal(await tick({ power: () => null, now: at(7, 2, 10), runs, lock, read, sessions: sessions(), start }), null);
  assert.equal(await tick({ power: () => null, now: at(7, 12, 0), runs, read: () => assert.fail('no read in the day') }), null);
  assert.equal((await tick({ power: () => null, now: at(7, 2, 10), runs, read, sessions: sessions('unknown'), start })).state, 'broken');
});

test('tick: a failed read is broken, a capped week is capped, both visible in night.json', async () => {
  const runs = tmp();
  let s = await tick({ power: () => null, now: at(7, 2, 10), runs, read: async () => ({ ok: false, error: 'timeout', message: 'Claude gave no answer within 45 seconds (offline?)' }) });
  assert.equal(s.message, '02:10 check failed: Claude gave no answer within 45 seconds (offline?)');
  s = await tick({ power: () => null, now: at(7, 2, 20), runs, read: async () => ({ ok: true, ...board([card(1, { status: 'ready' })], { windows: [{ ...WEEK[0], pct: 72 }], night: { cap: 70 } }) }), start: () => assert.fail('capped') });
  assert.deepEqual([s.state, s.message, s.usagePct, s.cap], ['capped', '02:20 stopped: the week is at 72%, your limit is 70%', 72, 70]);
  assert.equal(readNightStatus(at(7, 2, 40), runs).state, 'capped');
  assert.equal(readNightStatus(at(7, 9, 0), runs).state, 'day');
  assert.equal(readNightStatus(at(7, 9, 0), runs).message, s.message);
  assert.equal(readNightStatus(at(7, 20, 10), runs).state, 'day', 'last night\'s status is not tonight\'s');
});

test('night status: no new check for 25 minutes reads as broken, never as the last status', async () => {
  const runs = tmp();
  await tick({ power: () => null, now: at(7, 2, 20), runs, read: async () => ({ ok: true, ...board([]) }) });
  assert.deepEqual(['state', 'message'].map(k => readNightStatus(at(7, 2, 50), runs)[k]), ['broken', '02:50 check failed: no night check since 02:20']);
  assert.equal(readNightStatus(at(7, 21, 0), runs).message, '21:00 check failed: no night check tonight');
  assert.equal(readNightStatus(at(7, 21, 0), tmp()).state, 'broken', 'none ever ran');
  assert.equal(readNightStatus(at(7, 12, 0), tmp()), null);
});

test('dry run tries nothing and writes nothing', async () => {
  const runs = tmp();
  const s = await tick({ power: () => null, now: at(7, 12, 0), dryRun: true, runs, read: async () => ({ ok: true, cost: 0.0008, ...board([card(1, { status: 'ready' })]) }), sessions: sessions(), start: () => assert.fail('dry run') });
  assert.equal(s.state, 'dry-run');
  assert.deepEqual(s.wouldTry.map(x => x.card), ['alpha-001']);
  assert.deepEqual(fs.readdirSync(runs), []);
});

test('lock: exclusive; a dead or silent holder is replaced; the holder refreshes it', () => {
  const file = path.join(tmp(), 'night.lock');
  const now = Date.now();
  assert.equal(takeLock(file, { pid: 11, now, isAlive: () => true }), true);
  assert.equal(takeLock(file, { pid: 22, now, isAlive: () => true }), false);
  assert.equal(takeLock(file, { pid: 11, now: now + 60000, isAlive: () => true }), true);
  assert.equal(takeLock(file, { pid: 22, now: now + 120000, isAlive: pid => pid !== 11 }), true, 'stale pid');
  assert.equal(holdsLock(file, 22), true);
  assert.equal(takeLock(file, { pid: 33, now: now + 120000 + 31 * 60000, isAlive: () => true }), true, 'not refreshed for 30 minutes');
  fs.writeFileSync(file, '{"pi');
  assert.equal(takeLock(file, { pid: 44, isAlive: () => true }), false, 'a lock being written is not taken');
});

const reading = (d, pct, resetsAt = '2026-11-13T22:00:00.000Z') => ({ at: d.toISOString(), windows: [{ key: 'seven_day', pct, resetsAt }] });

test('night windows run 20:00 to 07:00 local', () => {
  assert.equal(nightOf(at(6, 20, 0)), '2026-11-06');
  assert.equal(nightOf(at(7, 6, 59)), '2026-11-06');
  assert.equal(nightOf(at(7, 7, 0)), '');
  assert.equal(nightOf(at(7, 19, 59)), '');
});

test('lastNight: last minus first reading of the most recent night; day readings ignored', () => {
  const rs = [reading(at(5, 21, 0), 1), reading(at(5, 23, 0), 3), reading(at(6, 12, 0), 9), reading(at(6, 20, 10), 10), reading(at(7, 1, 0), 14.5), reading(at(7, 6, 50), 18), reading(at(7, 9, 0), 30)];
  assert.deepEqual(lastNight(rs), { from: at(6, 20, 10).toISOString(), to: at(7, 6, 50).toISOString(), used: 8 });
  assert.equal(lastNight([...rs, reading(at(7, 20, 5), 31)]).used, 8, 'one reading tonight says nothing yet');
  assert.equal(lastNight([reading(at(6, 21, 0), 5)]), null);
  assert.equal(lastNight([]), null);
});

test('lastNight: a week reset in between adds the pre-reset delta to the post-reset value', () => {
  const rs = [reading(at(6, 21, 0), 90), reading(at(6, 23, 0), 95), reading(at(7, 1, 0), 2, '2026-11-20T22:00:00.000Z'), reading(at(7, 5, 0), 6, '2026-11-20T22:00:00.000Z')];
  assert.equal(lastNight(rs).used, 11);
});

test('usage: a reading under 10 minutes old is returned without probing; a failure returns the last one marked stale', async () => {
  const runs = tmp();
  let probes = 0;
  const probe = async () => { probes++; return { ok: true, windows: WEEK }; };
  const t0 = Date.now();
  const first = await usage({ now: t0, probe, runs });
  assert.deepEqual([first.ok, first.windows, probes], [true, WEEK, 1]);
  assert.deepEqual((await usage({ now: t0 + 9 * 60000, probe, runs })).windows, WEEK);
  assert.equal(probes, 1);
  const failed = await usage({ now: t0 + 11 * 60000, probe: async () => ({ ok: false, error: 'timeout', message: 'no answer' }), runs });
  assert.deepEqual([failed.ok, failed.error, failed.at, failed.windows[0].stale], [false, 'timeout', first.at, true]);
  assert.equal(fs.readFileSync(path.join(runs, 'usage.jsonl'), 'utf8').trim().split('\n').length, 1);
});

test('usage history stays at 2000 lines', () => {
  const runs = tmp();
  fs.writeFileSync(path.join(runs, 'usage.jsonl'), `${JSON.stringify(reading(at(1, 1, 0), 1))}\n`.repeat(2005));
  recordReading(WEEK, new Date().toISOString(), runs);
  const lines = fs.readFileSync(path.join(runs, 'usage.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 2000);
  assert.deepEqual(JSON.parse(lines.at(-1)).windows, WEEK);
});

test('battery on a Mac, from pmset -g batt; a Mac without a battery says nothing', () => {
  const batt = state => `Now drawing from '${state}'\n -InternalBattery-0 (id=4653155)\t87%; discharging; 5:12 remaining present: true\n`;
  assert.deepEqual(powerFromPmset(batt('Battery Power')), { onBattery: true });
  assert.deepEqual(powerFromPmset(batt('AC Power')), { onBattery: false });
  assert.equal(powerFromPmset("Now drawing from 'AC Power'\n"), null);
  assert.equal(powerFromPmset(''), null);
});

test('tick: the status says when the PC runs on battery', async () => {
  const s = await tick({ power: () => ({ onBattery: true }), now: at(7, 2, 10), runs: tmp(), read: async () => ({ ok: true, ...board([]) }) });
  assert.match(s.message, /\(on battery\)$/);
});
