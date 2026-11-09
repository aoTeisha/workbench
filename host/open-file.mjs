// Opens the file a card names (its handover.output). Only a document, and only inside a project's folder, so nothing a
// card says can make this PC run a program.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const DOCS = /\.(md|txt|csv|pdf|docx|xlsx|pptx|png|jpe?g)$/i;
const real = p => fs.realpathSync.native(p);

export function openFile({ path: p } = {}, { folders, launch = defaultLaunch }) {
  if (typeof p !== 'string' || !path.isAbsolute(p)) throw new Error('refused: not an absolute path');
  if (!fs.existsSync(p)) throw new Error(`missing: ${p}`);
  // Checked on the real path, so a link named .md cannot point at a program or out of the folder.
  const file = real(p);
  if (!DOCS.test(file)) throw new Error('refused: not a document');
  const inside = folders.filter(f => typeof f === 'string' && f && fs.existsSync(f))
    .some(f => file.toLowerCase().startsWith(real(f).toLowerCase().replace(/[\\/]+$/, '') + path.sep));
  if (!inside) throw new Error('refused: not inside a project folder');
  launch(file);
  return { opened: file };
}

// .md often has no default app: Windows 11 Notepad shows it formatted, a Mac opens it in its default text editor (-t).
function defaultLaunch(file) {
  const text = /\.(md|txt)$/i.test(file);
  if (process.platform === 'darwin') { execFileSync('open', [...(text ? ['-t'] : []), file], { timeout: 10000 }); return; }
  if (process.platform !== 'win32') { execFileSync('xdg-open', [file], { timeout: 10000 }); return; }
  if (text) { spawn('notepad.exe', [file], { detached: true, stdio: 'ignore' }).unref(); return; }
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Start-Process -FilePath $env:WB_FILE'], { env: { ...process.env, WB_FILE: file }, windowsHide: true, timeout: 10000 });
}
