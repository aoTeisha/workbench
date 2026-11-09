// Night check, in place of the hourly desktop scheduled task: every 10 minutes from 20:00 to 07:00 the helper copy that
// holds runs/night.lock reads the board's files (data/, host/db.mjs) and the plan usage, picks cards by "Night dispatch"
// in the work skill and starts them with cardStart. It never writes to the board; its status goes to runs/night.json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cardSessions, cardStart } from './card.mjs';
import { get, list } from './db.mjs';
import { RUNS, inNight, readPower, stamp, usage } from './usage.mjs';

const EVERY_MS = 10 * 60 * 1000;
const MIN = 60 * 1000;
const STALE_LOCK_MS = 30 * MIN;
// Start attempts per check; answers "waits for its folder" and "already running" do not count.
const MAX_CALLS = 3;
const RETRY_MS = 30 * MIN;
// ponytail: a fixed 2 sessions at night; a per-night number on machine/night if the user ever wants more.
const MAX_WORKING = 2;

// The board is files on this PC now; only the usage reading asks Claude (at most once in 10 minutes, shared with the
// board's meter, and recorded by usage()). Done cards are left out.
export async function readBoard({ readUsage = usage } = {}) {
  const u = await readUsage();
  return {
    ok: true,
    cards: list('cards').filter(d => d.data?.status !== 'done').map(d => ({ ...d.data, key: d.id })),
    projects: list('projects').map(d => ({ ...d.data, key: d.id })),
    night: get('machine/night')?.data || null,
    defaults: get('machine/cards')?.data || null,
    windows: u?.ok ? u.windows : null,
  };
}

// Board timestamps are local "YYYY-MM-DDTHH:mm", which Date reads as local time.
const age = (at, now) => now - new Date(at).getTime();
const cmp = (a, b) => (String(a ?? '') < String(b ?? '') ? -1 : String(a ?? '') > String(b ?? '') ? 1 : 0);
const lastLog = c => (Array.isArray(c.log) && c.log.at(-1)) || {};

const idOf = card => `#${card.id ?? Number(card.key.slice(-3))}`;
const nameOf = card => `${idOf(card)} ${card.title || ''}`.trim();

// The card of its project a goal's "after #NNN" or "after #<title>" (a title the board's Plan button could not number)
// names, unless it is done. The read holds no done cards, so a card that is not there counts as done.
function blockerOf(c, cards) {
  const others = cards.filter(o => o.project === c.project && o.key !== c.key && o.status !== 'done');
  const titled = rest => others.filter(o => typeof o.title === 'string' && o.title && rest.toLowerCase().startsWith(o.title.toLowerCase()))
    .sort((a, b) => b.title.length - a.title.length)[0];
  return [...String(c.goal || '').matchAll(/\bafter #(?:(\d{1,3})\b|([^\n]+))/gi)]
    .map(([, n, rest]) => (n ? others.find(o => o.key === `${c.project}-${n.padStart(3, '0')}`) : titled(rest))).find(Boolean);
}

// "Night dispatch" in the work skill, plus: a Ready card that comes after another waits until that one is done (a card in
// Doing was started on purpose), and nothing starts at or over the week limit (machine/night.cap; no doc, null or 0 = no
// limit) or without a usage reading.
export function decide({ cards, projects, night, defaults = null, windows, now = new Date() }) {
  const usagePct = windows?.find(w => w.key === 'seven_day')?.pct ?? null;
  const raw = night?.cap ?? null;
  const cap = raw === 0 ? null : raw;
  const out = (state, reason, candidates = []) => ({ state, reason, candidates, usagePct, cap });
  if (cap !== null && !(typeof cap === 'number' && cap >= 1 && cap <= 100)) return out('broken', `the night limit on the board is ${JSON.stringify(raw)}, not a number from 1 to 100`);
  if (usagePct === null) return out('broken', 'the reply had no usage reading');
  if (cap !== null && usagePct >= cap) return out('capped', `the week is at ${usagePct}%, your limit is ${cap}%`);
  const active = new Map(projects.filter(p => p.status === 'active').map(p => [p.key, p]));
  const open = cards.filter(c => active.has(c.project));
  const held = new Map(open.filter(c => c.status === 'ready').map(c => [c, blockerOf(c, cards)]).filter(([, b]) => b));
  const doing = open.filter(c => c.status === 'doing');
  const unclaimed = doing.filter(c => lastLog(c).who === 'you' && age(lastLog(c).at, now) > 10 * MIN);
  const stranded = doing.filter(c => !unclaimed.includes(c) && (/^paused/.test(lastLog(c).text || '') || age(c.updated, now) > 180 * MIN));
  const byUpdated = (a, b) => cmp(a.updated, b.updated);
  const prio = c => Number(c.priority) || 99;
  const ready = open.filter(c => c.status === 'ready' && !held.has(c)).sort((a, b) => prio(a) - prio(b) || cmp(a.created, b.created) || cmp(a.key, b.key));
  const candidates = [...unclaimed.sort(byUpdated), ...stranded.sort(byUpdated), ...ready].map(card => ({ card, project: active.get(card.project), defaults }));
  const idle = ['nothing to start', ...[...held].map(([c, b]) => `${idOf(c)} waits for ${idOf(b)}`)].join('; ');
  return out(candidates.length ? 'go' : 'idle', candidates.length ? '' : idle, candidates);
}

// machine/cards (the board's Settings) fills in what a card leaves "", as the board does by day; card_start checks the values.
export const startInput = ({ card, project, defaults }) => ({ card: card.key, folder: project.repo, title: `${project.name}: ${card.title}`,
  session: card.session || '', model: card.model || defaults?.model || '', effort: card.effort || defaults?.effort || '',
  ...(defaults?.ultracode === true && { ultracode: true }), ...(project.account && { account: project.account }) });

// Exclusive create; a lock whose pid is dead, or that its holder has not refreshed for 30 minutes (a pid Windows reused
// after a reboot), is taken over. ponytail: two helpers taking over one lock at the same moment can both win; both then
// read the board, but holdsLock before the first start lets only one start cards.
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
function holder(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* being written, or garbled: judge it by age */ }
  try { return { pid: 0, at: fs.statSync(file).mtime.toISOString() }; } catch { return null; }
}
export function takeLock(file, { pid = process.pid, now = Date.now(), isAlive = alive } = {}) {
  const write = flag => fs.writeFileSync(file, JSON.stringify({ pid, at: new Date(now).toISOString() }), { flag });
  try { write('wx'); return true; } catch (e) { if (e.code !== 'EEXIST') throw e; }
  const h = holder(file);
  if (h?.pid === pid) { write('w'); return true; }
  if (h && (!h.pid || isAlive(h.pid)) && now - Date.parse(h.at) < STALE_LOCK_MS) return false;
  fs.rmSync(file, { force: true });
  try { write('wx'); return true; } catch { return false; }
}
export const holdsLock = (file, pid = process.pid) => holder(file)?.pid === pid;

function writeStatus(s, runs) {
  fs.mkdirSync(runs, { recursive: true });
  fs.writeFileSync(path.join(runs, 'night.json'), JSON.stringify(s));
  fs.appendFileSync(path.join(runs, 'night.log'), `${stamp(new Date(s.at))} ${s.state} ${s.message}${s.started.length ? ` [${s.started.join(' ')}]` : ''}\n`);
}

// One night check: its status, or null in the day (a dry run ignores the clock) or when another helper took the lock
// meanwhile. A dry run starts and writes nothing; it lists the cards it would try, in order.
// ponytail: cardSessions and cardStart run claude synchronously, so this helper answers nothing else for a few seconds.
export async function tick({ now = new Date(), dryRun = false, runs = RUNS, lock = '', read = readBoard, sessions = cardSessions, start = cardStart, power = readPower } = {}) {
  if (!dryRun && !inNight(now)) return null;
  let base = { usagePct: null, cap: null };
  // The log says when the PC ran on battery: that is when a sleeping PC stops the night shift.
  const finish = (state, text, started = []) => {
    const s = { at: now.toISOString(), state, message: `${now.toTimeString().slice(0, 5)} ${text}${power(now.getTime())?.onBattery ? ' (on battery)' : ''}`, started, ...base };
    if (!dryRun) writeStatus(s, runs);
    return s;
  };
  const board = await read();
  const extra = {};
  if (!board.ok) return { ...finish('broken', `check failed: ${board.message}`), ...extra };
  const d = decide({ ...board, now });
  base = { usagePct: d.usagePct, cap: d.cap };
  if (d.state === 'broken') return { ...finish('broken', `check failed: ${d.reason}`), ...extra };
  if (d.state === 'capped') return { ...finish('capped', `stopped: ${d.reason}`), ...extra };
  if (d.state === 'idle') return { ...finish('idle', d.reason), ...extra };
  const live = sessions();
  if (!Array.isArray(live?.cards) || live.cards.some(c => c.state === 'unknown')) return { ...finish('broken', 'check failed: could not read the list of Claude background sessions'), ...extra };
  const room = MAX_WORKING - live.cards.filter(c => c.state === 'working').length;
  if (room <= 0) return { ...finish('busy', `waiting: ${MAX_WORKING} cards are already working`), ...extra };
  // A session that ended within 30 minutes of its start is not started again before then: each resume reloads its whole
  // conversation, and one that dies before claiming its card would be resumed on every check.
  const byCard = new Map(live.cards.map(s => [s.card, s]));
  const rests = ({ card }) => ['stopped', 'done'].includes(byCard.get(card.key)?.state) && age(byCard.get(card.key).at, now) < RETRY_MS;
  const plan = d.candidates.filter(c => !rests(c));
  if (dryRun) return { ...finish('dry-run', `would try ${plan.map(c => nameOf(c.card)).join(', then ')} (room for ${room})`), wouldTry: plan.map(startInput), ...extra };
  if (lock && !holdsLock(lock)) return null;
  const started = [], did = [], failed = [];
  const notes = d.candidates.filter(rests).map(c => `${nameOf(c.card)} stopped soon after its last start`);
  let tries = 0;
  for (const c of plan) {
    if (started.length >= room || tries >= MAX_CALLS) break;
    let r;
    try { r = await start(startInput(c)); } catch (e) { r = { ok: false, error: 'bad_input', message: e.message }; }
    const name = nameOf(c.card);
    if (r?.ok && (r.waiting || r.already)) { notes.push(`${name} ${r.waiting ? 'waits for its folder' : 'is already running'}`); continue; }
    tries++;
    if (!r?.ok) failed.push(`could not start ${name}: ${r?.message || r?.error || 'no answer'}`);
    else { started.push(c.card.key); did.push(`${r.resumed ? 'resumed' : 'started'} ${name}`); }
  }
  if (started.length) return finish('started', [...did, ...failed].join('; '), started);
  if (failed.length) return finish('broken', `check failed: ${failed.join('; ')}`);
  return finish('idle', `nothing to start: ${notes.join(', ')}`);
}

// Every helper copy runs this; only the lock holder checks the board. The next tick is set only after this one ends.
export function startNightTimer({ runs = RUNS } = {}) {
  const lock = path.join(runs, 'night.lock');
  const loop = async () => {
    try {
      fs.mkdirSync(runs, { recursive: true });
      if (takeLock(lock)) await tick({ runs, lock });
    } catch (e) {
      try { if (inNight(new Date())) writeStatus({ at: new Date().toISOString(), state: 'broken', message: `${new Date().toTimeString().slice(0, 5)} check failed: ${e.message}`, started: [], usagePct: null, cap: null }, runs); } catch { /* nowhere left to say it */ }
    }
    setTimeout(loop, EVERY_MS).unref();
  };
  setTimeout(loop, 30 * 1000).unref();
}

// `node host/night.mjs tick --dry-run`: one real board read, prints what it would start, starts nothing.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== 'tick' || process.argv[3] !== '--dry-run') { console.log('usage: node host/night.mjs tick --dry-run'); process.exit(2); }
  console.log(JSON.stringify(await tick({ dryRun: true }), null, 1));
}
