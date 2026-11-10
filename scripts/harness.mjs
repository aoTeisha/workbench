// Builds artifact/harness.html: the page wrapped in the viewer's skeleton with an in-memory db seeded from seed.json,
// so the published look can be checked in a plain browser. Not part of the product.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const page = fs.readFileSync(path.join(root, 'artifact/workbench.html'), 'utf8');
const seed = JSON.parse(fs.readFileSync(path.join(root, 'artifact/seed.json'), 'utf8'));
const feed = fs.existsSync(path.join(root, 'artifact/feed-sample.json'))
  ? JSON.parse(fs.readFileSync(path.join(root, 'artifact/feed-sample.json'), 'utf8')) : {};
// Optional: EXTRA_SEED adds seed entries; SLACK_SAMPLE ({ dms, mentions, replied } search answers as markdown) makes the
// Slack watches answer with them, so the page's own parser builds feed/slack.
const readJson = name => (process.env[name] ? JSON.parse(fs.readFileSync(process.env[name], 'utf8')) : null);
seed.push(...(readJson('EXTRA_SEED') || []));
const slackSample = readJson('SLACK_SAMPLE');

const mock = `
<script>
(() => {
  const docs = new Map();
  const listeners = new Map();
  const seed = ${JSON.stringify(seed)};
  for (const w of seed) docs.set(w.collection + '/' + w.doc_id, w.data);
  for (const [k, v] of Object.entries(${JSON.stringify(feed)})) docs.set('feed/' + k, v);
  docs.set('projects/demo', { ...docs.get('projects/demo'), status: 'active' });
  const snap = (id, data) => ({ id, exists: data !== undefined, data: () => data, metadata: { fromCache: false, hasPendingWrites: false } });
  const notify = p => { for (const [key, fns] of listeners) if (key === p || p.startsWith(key + '/')) for (const fn of fns) fn(); };
  const on = (key, fn) => { if (!listeners.has(key)) listeners.set(key, new Set()); listeners.get(key).add(fn); fn(); return () => listeners.get(key).delete(fn); };
  const docRef = p => ({
    id: p.split('/').pop(), path: p,
    get: async () => snap(p.split('/').pop(), docs.get(p)),
    set: async d => { docs.set(p, structuredClone(d)); notify(p); },
    update: async d => { docs.set(p, { ...docs.get(p), ...structuredClone(d) }); notify(p); },
    delete: async () => { docs.delete(p); notify(p); },
    onSnapshot: (next) => on(p, () => next(snap(p.split('/').pop(), docs.get(p)))),
    collection: c => colRef(p + '/' + c),
  });
  const colRef = c => ({
    path: c, doc: id => docRef(c + '/' + (id || Math.random().toString(36).slice(2))),
    onSnapshot: next => on(c, () => {
      const rows = [...docs].filter(([k]) => k.startsWith(c + '/') && k.slice(c.length + 1).indexOf('/') < 0).map(([k, v]) => snap(k.split('/').pop(), v));
      next({ docs: rows, size: rows.length, empty: !rows.length, docChanges: () => [], metadata: { fromCache: false, hasPendingWrites: false } });
    }),
    where() { return this; }, orderBy() { return this; }, limit() { return this; },
  });
  const db = { doc: docRef, collection: colRef };
  const user = { id: async () => 'u_harness', isOwner: () => true, canEdit: () => true, can: () => true };
  // A fake PC helper (host:workbench-host). Set window.__hostMode to 'ok', 'not_connected', 'cancelled', 'not_trusted',
  // 'waiting' (card_start queues) or 'night' (card_pause finds a session the card does not carry); window.__sessions is
  // what card_sessions answers. Every call lands in window.__hostCalls. Connectors answer server_not_connected.
  const HOST = 'host:workbench-host';
  const slack = ${JSON.stringify(slackSample)};
  // ?now=2026-11-06T13:10 shifts the page's clock, to see the day as it looks at that time.
  const fakeNow = new URLSearchParams(location.search).get('now');
  if (fakeNow) {
    const RealDate = Date;
    const off = new RealDate(fakeNow) - RealDate.now();
    window.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [RealDate.now() + off])); } static now() { return RealDate.now() + off; } };
  }
  // ?jira makes the Atlassian site lookup answer with one Jira site (the issue searches still fail as not connected).
  if (new URLSearchParams(location.search).has('jira')) window.__jira = [{ cloudId: 'site-1', url: 'https://example.atlassian.net', products: [{ id: 'jira' }] }];
  window.__hostMode = 'ok';
  window.__dbRev = 1;
  window.__hostCalls = [];
  window.__docs = docs;
  // The helper writes where Workbench lives (machine/host) when it starts; Plan in depth needs it.
  if (!docs.has('machine/host')) docs.set('machine/host', { root: 'C:\\\\Users\\\\you\\\\workbench' });
  // A made-up calendar: the same few meetings each weekday, shifted a little per day. Times are read as local.
  const calendar = input => {
    const day = String(input?.afterDateTime || '').slice(0, 10);
    const d = new Date(day + 'T00:00');
    if (!day || d.getDay() === 5 || d.getDay() === 6) return { content: [] };
    const n = d.getDate() % 3;
    const rows = [['Standup', 9.5, 9.75, ''], ['Design review', 11 + n, 12 + n, 'Room 4'], ['1:1 with Alex', 14, 14.5, ''], ['Sprint planning', 16, 17, ''], ['Overlapping sync', 16.5, 17.5, '']];
    const at = h => day + 'T' + String(Math.floor(h)).padStart(2, '0') + ':' + String(Math.round(h % 1 * 60)).padStart(2, '0') + ':00';
    return { content: rows.slice(0, 4 + (n === 0 ? 1 : 0)).map(([subject, a, b, location], i) => ({ type: 'text', text: JSON.stringify({
      id: day + '-' + i, subject, start: { dateTime: at(a), timeZone: 'Local' }, end: { dateTime: at(b), timeZone: 'Local' }, isAllDay: false, isCancelled: false,
      location, webLink: 'https://outlook.office365.com/calendar/item/' + day + '-' + i, organizerName: 'Someone', attendees: [], summary: '' }) })) };
  };
  const mcp = {
    listTools: async () => ({ servers: window.__hostMode === 'not_connected' ? [] : [{ server: HOST, authStatus: 'unknown', tools: [] }] }),
    callTool: async (server, tool, input) => {
      if (server === 'Microsoft 365' && tool === 'get_me') return { content: [], payload: { displayName: 'Sam Example', mail: 'sam@example.com' } };
      if (server === 'Slack' && tool === 'slack_read_user_profile' && slack) return { content: [], payload: { result: 'User ID: ' + (input.user_id || 'U0HARNESS') + '\\nDisplay Name: Sam\\nTimezone: Europe/London\\n' } };
      if (server === 'Atlassian MCP' && tool === 'getAccessibleAtlassianResources' && window.__jira) return { content: [], payload: { data: { resources: window.__jira } } };
      if (server === 'Microsoft 365' && tool === 'outlook_calendar_search') {
        if (window.__calFail) throw { code: window.__calFail };
        return calendar(input);
      }
      if (server !== HOST) throw { code: 'server_not_connected', server };
      // ?limit=30 copies the desktop app's per-board budget: a bucket of N calls a minute, refused with rate_limited.
      const limit = +new URLSearchParams(location.search).get('limit');
      if (limit) {
        const b = window.__bucket ||= { tokens: limit, at: Date.now(), refused: 0 };
        b.tokens = Math.min(limit, b.tokens + (Date.now() - b.at) * limit / 60000);
        b.at = Date.now();
        if (b.tokens < 1) { b.refused++; throw { code: 'rate_limited', message: 'Host tool rate limit exceeded — try again shortly.', retryAfterMs: Math.ceil((1 - b.tokens) * 60000 / limit) }; }
        b.tokens--;
      }
      window.__hostCalls.push({ tool, input, activation: navigator.userActivation?.isActive ?? null, at: Date.now() });
      const mode = window.__hostMode;
      if (mode === 'not_connected' || (mode === 'cancelled' && !tool.startsWith('db_'))) throw { code: mode === 'cancelled' ? 'cancelled' : 'server_not_connected' };
      // The PC's board documents (host/db.mjs): cards, projects and machine/* from the same in-memory docs.
      if (tool === 'db_read') {
        const rows = c => [...docs].filter(([k]) => k.startsWith(c + '/') && k.split('/').length === 2).map(([k, v]) => ({ id: k.split('/')[1], version: 1, data: structuredClone(v) }));
        return { content: [], payload: input?.since === window.__dbRev ? { ok: true, rev: window.__dbRev, unchanged: true }
          : { ok: true, rev: window.__dbRev, docs: { cards: rows('cards'), projects: rows('projects'), machine: rows('machine') } } };
      }
      if (tool === 'db_write' || tool === 'db_delete') {
        const p = input.path;
        if (tool === 'db_delete') docs.delete(p);
        else docs.set(p, input.op === 'set' ? structuredClone(input.data) : { ...(docs.get(p) || {}), ...structuredClone(input.data) });
        window.__dbRev++;
        notify(p);
        return { content: [], payload: { ok: true, version: 1, rev: window.__dbRev } };
      }
      await new Promise(r => setTimeout(r, window.__hostDelay ?? 300));
      if (mode === 'not_trusted') return { content: [], payload: { ok: false, error: 'not_trusted', message: 'Claude Code does not trust that folder yet.' } };
      if (tool === 'card_start' && mode === 'waiting') return { content: [], payload: { ok: true, waiting: true, behind: 'Demo: Add health endpoint', session: input.session || '' } };
      if (tool === 'card_start') return { content: [], payload: { ok: true, session: input.session || '11111111-2222-3333-4444-555555555555', resumed: !!input.session } };
      if (tool === 'card_pause') return { content: [], payload: { ok: true, paused: !!input.session || mode === 'night', session: input.session, next: mode === 'night' ? 'demo-002' : '' } };
      // A project's knowledge files: window.__projectDocs overrides the list, window.__docText maps a path to its text.
      if (tool === 'project_docs') return { content: [], payload: input.file
        ? { ok: true, path: input.file, text: (window.__docText || {})[input.file] ?? '# ' + input.file + '\\n\\n## Decisions so far\\n\\n- Rail, not columns.\\n' }
        : { ok: true, folder: input.folder, ...(window.__projectDocs || { files: [{ path: 'CONTEXT.md', title: 'Glossary', at: '' }, { path: '.scratch/rail/map.md', title: 'Map: Roadmap rail', at: '' }], maps: [{ path: '.scratch/rail/map.md', decided: 1, total: 3 }] }) } };
      if (tool === 'open_file') return { content: [], payload: window.__openFail ? { ok: false, error: 'failed', message: window.__openFail } : { ok: true, opened: input.path } };
      if (tool === 'card_open') return { content: [], payload: { ok: true, opened: '11111111' } };
      if (tool === 'card_sessions') return { content: [], payload: { ok: true, cards: window.__sessions || [], defaults: { model: 'fable', effort: 'high', efforts: { haiku: 'medium', sonnet: 'medium', opus: 'xhigh', fable: 'high' } } } };
      if (tool === 'usage') return { content: [], payload: window.__usage || { ok: true, at: new Date().toISOString(), windows: [{ key: 'seven_day', label: 'This week · all models', pct: 34, resetsAt: '2026-11-13T14:00:00.000Z' }],
        night: { state: 'day', message: '07:00 nothing to start.' }, lastNight: { from: '2026-11-05T20:00', to: '2026-11-06T07:00', used: 6 }, power: { onBattery: !!window.__battery } } };
      return { content: [], payload: { running: tool === 'keep_awake_start' } };
    },
    watchTool: (server, tool, input, handler) => {
      const q = input?.query || '';
      const md = server === 'Slack' && slack && tool === 'slack_search_public_and_private'
        ? (q.startsWith('to:me') ? slack.dms : q.startsWith('from:') ? slack.replied : slack.mentions) : null;
      const answer = server === 'Microsoft 365' && tool === 'outlook_calendar_search' ? { type: 'data', result: calendar(input) }
        : md != null ? { type: 'data', result: { content: [], payload: { results: md } } }
        : server === 'Slack' && slack && tool === 'slack_list_user_channels' ? { type: 'data', result: { content: [], payload: { result: '' } } }
        : { type: 'error', error: { code: 'server_not_connected', server } };
      setTimeout(() => handler(answer), 0);
      return () => {};
    },
    invalidate: async () => {},
  };
  // ?sample turns on Claude on this page (Where are we, + Card drafts); window.__sampleText is what it answers.
  const sample = Object.assign(async () => ({ text: window.__sampleText || 'Done lately: the checker and usage per card shipped.\\nNow: Check phase, the Checked row is next.\\nWaiting on you: nothing.' }), { json: async () => ({}) });
  const sampleOn = new URLSearchParams(location.search).has('sample');
  window.claude = { use: async name => ({ db, user, mcp, ...(sampleOn && { sample }) })[name] ?? null };
})();
</script>`;

const skeleton = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><style>
:root{color-scheme:light;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}
body{margin:0;font:14px system-ui,sans-serif}img{max-width:100%}[hidden]{display:none!important}
</style></head><body>${mock}${page}</body></html>`;

fs.writeFileSync(path.join(root, 'artifact/harness.html'), skeleton);
console.log('artifact/harness.html written');
