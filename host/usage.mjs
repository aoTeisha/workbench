// Plan usage readings: the `usage` tool and the night check both read it from the rate_limit_event line that a one-turn
// `claude -p` run prints. Readings are cached in runs/usage.json (shared by every helper copy) and kept in runs/usage.jsonl.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLAUDE } from './card.mjs';
import { NO_CLAUDE, accountEnv, resolveAccount, syncAccount } from './accounts.mjs';

export const RUNS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'runs');
const CACHE_MS = 10 * 60 * 1000;
const KILL_MS = 45 * 1000;
const KEEP_LINES = 2000;

export const stamp = (d = new Date()) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 19);
const pad = n => String(n).padStart(2, '0');
export const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

// The night shift runs 20:00-07:00 local time. A night is named by the date it starts on; '' in the day.
export function nightOf(d) {
  const h = d.getHours();
  if (Number.isNaN(h) || (h >= 7 && h < 20)) return '';
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate() - (h < 7 ? 1 : 0));
  return `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`;
}
export const inNight = d => !!nightOf(d);

// Measured 2026-11-06 (Claude Code 2.1.319): without CLAUDE_CODE_ENTRYPOINT=claude-desktop (undocumented) the CLI loads no
// Artifact tools and Haiku fakes the call in text. The host session's own CLAUDE_*/ANTHROPIC_* vars are dropped so the
// run is the same under the desktop app and under a Claude Code session. It runs as Workbench's own account (the one
// that can see the board), or as ~/.claude while that account is not set up.
function cliEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(CLAUDE|ANTHROPIC)/i.test(k)) env[k] = v;
  const account = resolveAccount('');
  syncAccount(account);
  return { ...env, CLAUDE_CODE_ENTRYPOINT: 'claude-desktop', ...accountEnv(account) };
}

// The prompt must come right after -p: --tools and --disallowedTools take several values and would swallow it.
export const cliArgs = (prompt, tools, system) => ['-p', prompt, '--model', 'haiku', '--effort', 'low', '--strict-mcp-config',
  '--tools', tools, '--disallowedTools', 'ArtifactComments', '--permission-prompts', 'none', '--safe-mode', '--setting-sources', '',
  '--disable-slash-commands', '--system-prompt', system, '--max-turns', '1', '--no-session-persistence', '--output-format', 'stream-json', '--verbose'];

export const parseLines = text => text.split(/\r?\n/).flatMap(l => { try { return l.trim() ? [JSON.parse(l)] : []; } catch { return []; } });

// Offline, the CLI retries for ~3 minutes before it gives up, so it is killed sooner. The exit code means nothing here:
// --max-turns 1 ends a run that made tool calls with exit 1.
export function runClaude(args, { timeoutMs = KILL_MS } = {}) {
  if (!fs.existsSync(CLAUDE)) return Promise.resolve({ ok: false, error: 'no_claude', message: NO_CLAUDE });
  const cwd = path.join(os.tmpdir(), 'workbench-night');
  fs.mkdirSync(cwd, { recursive: true });
  return new Promise(resolve => {
    let out = '', err = '';
    const p = spawn(CLAUDE, args, { cwd, env: cliEnv(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    // Answers from the timer: a child process the CLI started can keep the pipes open, and "close" never come.
    const kill = setTimeout(() => { p.kill(); resolve({ ok: false, error: 'timeout', message: `Claude gave no answer within ${timeoutMs / 1000} seconds (offline?)` }); }, timeoutMs);
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; });
    p.on('error', e => { clearTimeout(kill); resolve({ ok: false, error: 'spawn_failed', message: e.message }); });
    p.on('close', code => {
      clearTimeout(kill);
      const lines = parseLines(out);
      resolve(lines.length ? { ok: true, lines } : { ok: false, error: 'no_output', message: (err.trim().split('\n').pop() || `exit ${code}`).slice(0, 300) });
    });
  });
}

// A failed API call ends in an assistant message from the model "<synthetic>" ("API Error: ...").
export function apiError(lines) {
  const m = lines.find(l => l.type === 'assistant' && l.message?.model === '<synthetic>');
  return m ? ((m.message.content || []).map(c => c.text || '').join(' ').trim() || 'API error').slice(0, 200) : '';
}
export const costOf = lines => lines.find(l => l.type === 'result')?.total_cost_usd ?? null;

const LABELS = { seven_day: 'This week · all models', five_hour: 'This session (5 hours)' };
const labelOf = key => LABELS[key] || key.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());

// unifiedWindows: { <key>: { utilization: 0..1, resetsAt: epoch seconds } }. Every window present is reported.
export function windowsOf(lines) {
  const all = lines.filter(l => l.type === 'rate_limit_event').at(-1)?.rate_limit_info?.unifiedWindows;
  const windows = Object.entries(all && typeof all === 'object' ? all : {})
    .filter(([, w]) => Number.isFinite(w?.utilization) && Number.isFinite(w?.resetsAt))
    .map(([key, w]) => ({ key, label: labelOf(key), pct: Math.round(w.utilization * 1000) / 10, resetsAt: new Date(w.resetsAt * 1000).toISOString() }));
  return windows.length ? windows : null;
}

const memo = new Map();
const inflight = new Map();

export function recordReading(windows, at, runs = RUNS) {
  fs.mkdirSync(runs, { recursive: true });
  const rec = { at, windows };
  memo.set(runs, rec);
  fs.writeFileSync(path.join(runs, 'usage.json'), JSON.stringify(rec));
  const file = path.join(runs, 'usage.jsonl');
  fs.appendFileSync(file, `${JSON.stringify(rec)}\n`);
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  if (lines.length > KEEP_LINES) fs.writeFileSync(file, `${lines.slice(-KEEP_LINES).join('\n')}\n`);
}

export function readHistory(runs = RUNS) {
  try { return parseLines(fs.readFileSync(path.join(runs, 'usage.jsonl'), 'utf8')); } catch { return []; }
}

// Week usage spent in the most recent night: last minus first seven_day reading of that night. A week reset in between
// restarts the count from 0, so after a reset the new value is all usage since then.
export function lastNight(readings) {
  const week = readings.map(r => ({ at: r.at, night: nightOf(new Date(r.at)), w: r.windows?.find?.(w => w.key === 'seven_day') }))
    .filter(r => r.night && r.w).sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  // A night's first reading alone says nothing yet: the night before stays the answer until a second one.
  const of = night => week.filter(r => r.night === night);
  const rs = [...new Set(week.map(r => r.night))].reverse().map(of).find(n => n.length >= 2);
  if (!rs) return null;
  let used = 0;
  for (let i = 1; i < rs.length; i++) used += rs[i].w.resetsAt === rs[i - 1].w.resetsAt ? rs[i].w.pct - rs[i - 1].w.pct : rs[i].w.pct;
  return { from: rs[0].at, to: rs.at(-1).at, used: Math.round(used * 10) / 10 };
}

// The night check's last status. Outside its own night it reads as "day" and keeps that night's message. In the night a
// check runs every 10 minutes, so no new status for 25 minutes means none runs (no helper started since it was added,
// or one hangs): that reads as broken, never as the old status.
const NIGHT_STALE_MS = 25 * 60 * 1000;
const hhmm = d => new Date(d).toTimeString().slice(0, 5);
export function readNightStatus(now = new Date(), runs = RUNS) {
  const s = readJson(path.join(runs, 'night.json'));
  const night = nightOf(now);
  if (!night) return s && { ...s, state: 'day' };
  if (s && now - new Date(s.at) < NIGHT_STALE_MS) return s;
  if (now - new Date(`${night}T20:00:00`) < NIGHT_STALE_MS) return s && { ...s, state: 'day' };
  const since = s && nightOf(new Date(s.at)) === night ? `since ${hhmm(s.at)}` : 'tonight';
  return { at: now.toISOString(), state: 'broken', message: `${hhmm(now)} check failed: no night check ${since}`, started: [], usagePct: s?.usagePct ?? null, cap: s?.cap ?? null };
}

export async function probeUsage() {
  const run = await runClaude(cliArgs('ok', '', 'Reply with the single word: ok'));
  if (!run.ok) return run;
  const failed = apiError(run.lines);
  if (failed) return { ok: false, error: 'api_error', message: failed };
  const windows = windowsOf(run.lines);
  if (!windows) return { ok: false, error: 'no_usage', message: 'Claude answered without a usage reading (no rate_limit_event); Claude Code may have changed.' };
  return { ok: true, windows, cost: costOf(run.lines) };
}

// The `usage` tool. A reading younger than 10 minutes (this process's or another helper's) is returned as it is.
// On battery, a sleeping PC goes into deep standby and nothing runs until it wakes (measured 2026-11-06: the night check
// stopped at 23:27, when the laptop came off the charger). { onBattery } or null on a PC without a battery.
const POWER_MS = 2 * 60 * 1000;
let powerMemo = null;
// `pmset -g batt` on a Mac: "Now drawing from 'AC Power'" or 'Battery Power'; a Mac without a battery lists no InternalBattery.
export const powerFromPmset = text => (!/InternalBattery/.test(text) ? null
  : /'Battery Power'/.test(text) ? { onBattery: true } : /'AC Power'/.test(text) ? { onBattery: false } : null);
export function readPower(now = Date.now()) {
  if (powerMemo && now - powerMemo.at < POWER_MS) return powerMemo.value;
  let value = null;
  try {
    if (process.platform === 'win32') {
      const online = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        '(Get-CimInstance -Namespace root\\wmi -ClassName BatteryStatus -ErrorAction Stop | Select-Object -First 1).PowerOnline'],
      { encoding: 'utf8', windowsHide: true, timeout: 15000 }).trim();
      value = online === 'True' ? { onBattery: false } : online === 'False' ? { onBattery: true } : null;
    } else value = powerFromPmset(execFileSync('pmset', ['-g', 'batt'], { encoding: 'utf8', timeout: 15000 }));
  } catch { /* no battery, or WMI / pmset unavailable: say nothing */ }
  powerMemo = { at: now, value };
  return value;
}

export async function usage({ now = Date.now(), probe = probeUsage, runs = RUNS, power = readPower } = {}) {
  const extra = () => ({ night: readNightStatus(new Date(now), runs), lastNight: lastNight(readHistory(runs)), power: power(now) });
  const last = [memo.get(runs), readJson(path.join(runs, 'usage.json'))].filter(r => r?.at && Array.isArray(r.windows))
    .sort((a, b) => (a.at < b.at ? 1 : -1))[0];
  if (last && now - Date.parse(last.at) < CACHE_MS) return { ok: true, at: last.at, windows: last.windows, ...extra() };
  if (!inflight.has(runs)) {
    const at = new Date(now).toISOString();
    inflight.set(runs, Promise.resolve().then(probe).then(r => { if (r.ok) recordReading(r.windows, at, runs); return { ...r, at }; })
      .catch(e => ({ ok: false, error: 'probe_failed', message: String(e?.message || e) })).finally(() => inflight.delete(runs)));
  }
  const r = await inflight.get(runs);
  if (!r.ok) return { ok: false, error: r.error, message: r.message, at: last?.at || null, windows: (last?.windows || []).map(w => ({ ...w, stale: true })), ...extra() };
  return { ok: true, at: r.at, windows: r.windows, ...extra() };
}
