// Workbench's Claude logins. Each account is its own Claude Code settings folder (CLAUDE_CONFIG_DIR), signed in once:
//   node host/accounts.mjs add <name>      node host/accounts.mjs status
// A project's card sessions run as its account (default "workbench"). A /login in a terminal changes only ~/.claude, so
// it can no longer move the cards to an account that cannot see the board (it did on 2026-11-08).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Put first on a card session's PATH, so `node host/db.mjs` works even when the app that started this helper passed a bare PATH.
export const BIN = path.dirname(process.execPath);

// A .cmd shim (npm, fnm) only runs through cmd.exe, whose quoting would mangle the prompts passed as arguments: run the
// exe it points at. An extensionless file on Windows is the shim for Git Bash.
const SHIM_TARGET = /"%~?dp0%?\\?([^"%]*claude\.exe)"/i;
function spawnable(file, read) {
  if (/\.exe$/i.test(file)) return file;
  if (!/\.cmd$/i.test(file)) return '';
  try { const m = SHIM_TARGET.exec(read(file)); return m ? path.win32.join(path.win32.dirname(file), m[1]) : ''; } catch { return ''; }
}

// An app started from the Dock gets a bare PATH, so a Mac asks the user's shell; -i also reads ~/.zshrc, where nvm and
// npm usually add theirs. The output may carry rc-file chatter or an alias line: findClaude keeps only claude paths.
function claudeOnPath(platform) {
  const res = platform === 'win32'
    ? spawnSync('where.exe', ['claude'], { encoding: 'utf8', windowsHide: true, timeout: 10 * 1000 })
    : spawnSync(process.env.SHELL || '/bin/zsh', ['-ilc', 'command -v claude'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10 * 1000 });
  return res.stdout || '';
}

// The Claude Code CLI: WORKBENCH_CLAUDE, else the first claude on PATH, else the usual install folders. '' when none.
export function findClaude({ platform = process.platform, env = process.env, home = os.homedir(), onPath = claudeOnPath, exists = fs.existsSync, read = f => fs.readFileSync(f, 'utf8') } = {}) {
  if (env.WORKBENCH_CLAUDE) return env.WORKBENCH_CLAUDE;
  const win = platform === 'win32';
  const found = onPath(platform).split(/\r?\n/).map(l => l.trim()).filter(l => /^([A-Za-z]:\\|\/).*[\\/]claude(\.exe|\.cmd)?$/i.test(l));
  const usual = win
    ? [path.win32.join(env.APPDATA || '', 'fnm', 'aliases', 'default', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
      path.win32.join(home, '.local', 'bin', 'claude.exe'), path.win32.join(env.APPDATA || '', 'npm', 'claude.cmd')]
    : [path.posix.join(home, '.local', 'bin', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'];
  for (const file of [...found, ...usual]) {
    const exe = win ? spawnable(file, read) : file;
    if (exe && exists(exe)) return exe;
  }
  return '';
}
export const CLAUDE = findClaude();
export const NO_CLAUDE = `Claude Code was not found${CLAUDE ? ` at ${CLAUDE}` : ''}. Install it, or set WORKBENCH_CLAUDE to the claude program, then restart the Claude desktop app.`;

export const DEFAULT_ACCOUNT = 'workbench';
export const ACCOUNT_NAME = /^[a-z][a-z0-9-]{0,30}$/;
// WB_HOME: tests keep their account folders in a temp folder.
const HOME = process.env.WB_HOME || os.homedir();
const BASE = path.join(HOME, '.claude');
const PREFIX = '.claude-wb-';
export const dirOf = name => path.join(HOME, `${PREFIX}${name}`);

// What a project's account name runs as: "" (none named) is the workbench account. An account that is not set up yet:
// workbench falls back to ~/.claude (returned as ""), as before accounts existed; any other name is an error.
export function resolveAccount(name) {
  const n = name || DEFAULT_ACCOUNT;
  if (typeof n !== 'string' || !ACCOUNT_NAME.test(n)) throw new Error('bad account');
  if (fs.existsSync(dirOf(n))) return n;
  if (n === DEFAULT_ACCOUNT) return '';
  throw new Error(`account ${n} is not set up: run node host/accounts.mjs add ${n}`);
}
export const configDir = account => (account ? dirOf(account) : BASE);
export const accountEnv = account => (account ? { CLAUDE_CONFIG_DIR: dirOf(account) } : {});

// Settings and instructions follow ~/.claude: copied when that copy is newer (Claude Code rewrites these files whole).
const COPIED = ['settings.json', 'CLAUDE.md'];
// Shared as they are (directory junctions need no admin rights), so skills and plugins installed once work everywhere.
const LINKED = ['skills', 'plugins', 'agents', 'commands', 'output-styles'];

export function syncAccount(account) {
  if (!account) return;
  const dir = dirOf(account);
  for (const f of COPIED) {
    const from = path.join(BASE, f);
    const to = path.join(dir, f);
    try { if (!fs.existsSync(to) || fs.statSync(from).mtimeMs > fs.statSync(to).mtimeMs) fs.copyFileSync(from, to); } catch { /* not in ~/.claude */ }
  }
  for (const d of LINKED) {
    const from = path.join(BASE, d);
    const to = path.join(dir, d);
    if (fs.existsSync(from) && !fs.existsSync(to)) fs.symlinkSync(from, to, 'junction');
  }
}

// A new account starts from ~/.claude.json without its sign-in, so the folders already trusted there stay trusted
// (a background session refuses an untrusted folder) and Claude Code skips its first-run screens.
function seedConfig(dir) {
  const to = path.join(dir, '.claude.json');
  if (fs.existsSync(to)) return;
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(path.join(HOME, '.claude.json'), 'utf8')); } catch { /* no global config yet */ }
  delete cfg.oauthAccount;
  fs.writeFileSync(to, JSON.stringify(cfg, null, 2));
}

export function accounts() {
  let names = [];
  try { names = fs.readdirSync(HOME).filter(f => f.startsWith(PREFIX)).map(f => f.slice(PREFIX.length)).filter(n => ACCOUNT_NAME.test(n)); } catch { /* no home */ }
  return names.map(name => {
    let a = {};
    try { a = JSON.parse(fs.readFileSync(path.join(dirOf(name), '.claude.json'), 'utf8')).oauthAccount || {}; } catch { /* not signed in */ }
    return { name, email: a.emailAddress || '', org: a.organizationName || '', signedIn: !!a.emailAddress };
  });
}

// The CLI as one account, without the CLAUDE_*/ANTHROPIC_* variables of whatever session runs this script.
const cleanEnv = account => {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(CLAUDE|ANTHROPIC)/i.test(k)) env[k] = v;
  return { ...env, PATH: `${BIN}${path.delimiter}${env.PATH || env.Path || ''}`, ...accountEnv(account) };
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, name] = process.argv.slice(2);
  if (cmd === 'status') {
    for (const a of accounts()) console.log(`${a.name.padEnd(14)} ${a.signedIn ? `${a.email} · ${a.org}` : 'not signed in'}   ${dirOf(a.name)}`);
    if (!accounts().length) console.log(`No accounts yet. Card sessions use ~/.claude. Add one: node host/accounts.mjs add ${DEFAULT_ACCOUNT}`);
  } else if (cmd === 'add' && ACCOUNT_NAME.test(name || '')) {
    if (!fs.existsSync(CLAUDE)) { console.log(NO_CLAUDE); process.exit(1); }
    const dir = dirOf(name);
    fs.mkdirSync(dir, { recursive: true });
    seedConfig(dir);
    syncAccount(name);
    console.log(`Signing ${name} in. Pick the account in the browser that opens; it is used only by Workbench cards that name "${name}".`);
    spawnSync(CLAUDE, ['auth', 'login'], { stdio: 'inherit', env: cleanEnv(name) });
    const st = spawnSync(CLAUDE, ['auth', 'status'], { encoding: 'utf8', env: cleanEnv(name) });
    console.log(st.stdout || st.stderr);
  } else {
    console.log('usage: node host/accounts.mjs add <name>   (lowercase letters, digits, dashes)\n       node host/accounts.mjs status');
    process.exit(2);
  }
}
