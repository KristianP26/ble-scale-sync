/**
 * BLE Scale Sync API Worker
 *
 * Endpoints:
 *   GET /version          Returns { latest: "x.y.z" }
 *   GET /stats            HTML dashboard with aggregated anonymous stats
 *   GET /stats/json       JSON stats for programmatic access
 *
 * Anonymous usage stats are derived from User-Agent headers:
 *   ble-scale-sync/1.6.4 (linux; arm64)
 */

export interface Env {
  STATS: KVNamespace;
}

const GITHUB_RELEASES_URL =
  'https://api.github.com/repos/KristianP26/ble-scale-sync/releases/latest';
const VERSION_CACHE_KEY = 'latest-version';
const VERSION_CACHE_TTL = 3600; // 1 hour

/** Fetch latest version from GitHub Releases API, cached in KV for 1h. */
async function getLatestVersion(kv: KVNamespace): Promise<string> {
  const cached = await kv.get(VERSION_CACHE_KEY);
  if (cached) return cached;

  try {
    const res = await fetch(GITHUB_RELEASES_URL, {
      headers: { 'User-Agent': 'ble-scale-sync-api-worker' },
    });
    if (!res.ok) return cached ?? '0.0.0';

    const data = (await res.json()) as { tag_name?: string };
    const version = data.tag_name?.replace(/^v/, '') ?? '0.0.0';

    await kv.put(VERSION_CACHE_KEY, version, { expirationTtl: VERSION_CACHE_TTL });
    return version;
  } catch {
    return cached ?? '0.0.0';
  }
}

// ─── User-Agent parsing ─────────────────────────────────────────────────────

interface ClientInfo {
  version: string;
  os: string;
  arch: string;
}

const KNOWN_OS = new Set(['linux', 'darwin', 'win32', 'freebsd', 'openbsd', 'sunos', 'aix']);
const KNOWN_ARCH = new Set(['arm', 'arm64', 'x64', 'ia32', 'ppc64', 's390x', 'riscv64', 'mips', 'mipsel', 'loong64']);
const MAX_VERSION_LENGTH = 20;

function parseUserAgent(ua: string | null): ClientInfo | null {
  if (!ua) return null;
  const match = ua.match(/^ble-scale-sync\/([\d.]+)\s+\(([^;]+);\s*([^)]+)\)$/);
  if (!match) return null;

  const version = match[1].slice(0, MAX_VERSION_LENGTH);
  const os = KNOWN_OS.has(match[2]) ? match[2] : 'other';
  const arch = KNOWN_ARCH.has(match[3]) ? match[3] : 'other';

  return { version, os, arch };
}

// ─── KV helpers ─────────────────────────────────────────────────────────────

/** Date key in YYYY-MM-DD format (UTC). */
function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

interface DailyStats {
  total: number;
  versions: Record<string, number>;
  os: Record<string, number>;
  arch: Record<string, number>;
}

// Note: read-modify-write is not atomic. Under concurrent requests, some increments
// may be lost due to KV's eventual consistency. This is acceptable for anonymous
// aggregate stats where approximate counts are sufficient.
async function recordHit(kv: KVNamespace, client: ClientInfo): Promise<void> {
  const key = `stats:${todayKey()}`;
  const raw = await kv.get(key);
  const stats: DailyStats = raw
    ? (JSON.parse(raw) as DailyStats)
    : { total: 0, versions: {}, os: {}, arch: {} };

  stats.total++;
  stats.versions[client.version] = (stats.versions[client.version] ?? 0) + 1;
  stats.os[client.os] = (stats.os[client.os] ?? 0) + 1;
  stats.arch[client.arch] = (stats.arch[client.arch] ?? 0) + 1;

  // Keep daily stats for 90 days
  await kv.put(key, JSON.stringify(stats), { expirationTtl: 90 * 86400 });
}

// ─── Stats aggregation ──────────────────────────────────────────────────────

interface AggregatedStats {
  period: string;
  days: number;
  uniqueDays: number;
  totalChecks: number;
  versions: Record<string, number>;
  os: Record<string, number>;
  arch: Record<string, number>;
}

async function aggregateStats(kv: KVNamespace, days: number): Promise<AggregatedStats> {
  const now = new Date();
  const versions: Record<string, number> = {};
  const os: Record<string, number> = {};
  const arch: Record<string, number> = {};
  let totalChecks = 0;
  let uniqueDays = 0;

  for (let i = 0; i < days; i++) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    const key = `stats:${d.toISOString().slice(0, 10)}`;
    const raw = await kv.get(key);
    if (!raw) continue;

    uniqueDays++;
    const stats = JSON.parse(raw) as DailyStats;
    totalChecks += stats.total;

    for (const [k, v] of Object.entries(stats.versions)) {
      versions[k] = (versions[k] ?? 0) + v;
    }
    for (const [k, v] of Object.entries(stats.os)) {
      os[k] = (os[k] ?? 0) + v;
    }
    for (const [k, v] of Object.entries(stats.arch)) {
      arch[k] = (arch[k] ?? 0) + v;
    }
  }

  const label = days === 1 ? '24h' : days === 7 ? '7d' : '30d';

  return { period: label, days, uniqueDays, totalChecks, versions, os, arch };
}

// ─── Stats dashboard HTML ───────────────────────────────────────────────────

function renderDashboard(stats24h: AggregatedStats, stats7d: AggregatedStats, stats30d: AggregatedStats): string {
  const sortedEntries = (obj: Record<string, number>): [string, number][] =>
    Object.entries(obj).sort((a, b) => b[1] - a[1]);

  const renderTable = (data: Record<string, number>, total: number): string => {
    if (total === 0) return '<tr><td colspan="3" class="empty">No data yet</td></tr>';
    return sortedEntries(data)
      .map(([k, v]) => {
        const pct = total > 0 ? ((v / total) * 100).toFixed(1) : '0.0';
        return `<tr><td>${esc(k)}</td><td>${v}</td><td>${pct}%</td></tr>`;
      })
      .join('');
  };

  const renderPeriodCard = (s: AggregatedStats): string => {
    const isDaily = s.days === 1;
    const avg = s.uniqueDays > 0 ? Math.round(s.totalChecks / s.uniqueDays) : 0;
    const value = isDaily ? s.totalChecks : avg;
    const label = isDaily ? 'active installations (est.)' : 'avg daily installations (est.)';
    return `
    <div class="card">
      <h2>${s.period}</h2>
      <div class="big-number">${value}</div>
      <div class="label">${label}</div>
      <div class="sub">${s.uniqueDays} active day${s.uniqueDays !== 1 ? 's' : ''}${!isDaily ? `, ${s.totalChecks} total checks` : ''}</div>
    </div>`;
  };

  const renderBreakdown = (title: string, data24: Record<string, number>, data7: Record<string, number>, data30: Record<string, number>, total24: number, total7: number, total30: number): string => `
    <div class="breakdown">
      <h2>${title}</h2>
      <div class="tabs">
        <div class="tab-group" data-group="${title.toLowerCase()}">
          <button class="tab active" data-period="24h">24h</button>
          <button class="tab" data-period="7d">7d</button>
          <button class="tab" data-period="30d">30d</button>
        </div>
      </div>
      <table class="tab-content active" data-group="${title.toLowerCase()}" data-period="24h">
        <thead><tr><th>${title}</th><th>Count</th><th>Share</th></tr></thead>
        <tbody>${renderTable(data24, total24)}</tbody>
      </table>
      <table class="tab-content" data-group="${title.toLowerCase()}" data-period="7d">
        <thead><tr><th>${title}</th><th>Count</th><th>Share</th></tr></thead>
        <tbody>${renderTable(data7, total7)}</tbody>
      </table>
      <table class="tab-content" data-group="${title.toLowerCase()}" data-period="30d">
        <thead><tr><th>${title}</th><th>Count</th><th>Share</th></tr></thead>
        <tbody>${renderTable(data30, total30)}</tbody>
      </table>
    </div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>BLE Scale Sync Stats</title>
  <link rel="icon" href="https://blescalesync.dev/favicon.svg" type="image/svg+xml">
  <style>
    :root {
      --bg: #0f172a;
      --surface: #1e293b;
      --border: #334155;
      --text: #e2e8f0;
      --text-dim: #94a3b8;
      --accent: #38bdf8;
      --accent-dim: #0284c7;
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      padding: 2rem 1rem;
    }
    .container { max-width: 900px; margin: 0 auto; }
    header {
      text-align: center;
      margin-bottom: 2.5rem;
    }
    header h1 {
      font-size: 1.5rem;
      font-weight: 600;
      color: var(--accent);
    }
    header p { color: var(--text-dim); margin-top: 0.25rem; font-size: 0.875rem; }
    .cards {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 1rem;
      margin-bottom: 2rem;
    }
    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 0.75rem;
      padding: 1.25rem;
      text-align: center;
    }
    .card h2 { font-size: 0.875rem; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.05em; }
    .big-number { font-size: 2.25rem; font-weight: 700; color: var(--accent); margin: 0.25rem 0; }
    .label { font-size: 0.8rem; color: var(--text-dim); }
    .sub { font-size: 0.75rem; color: var(--text-dim); margin-top: 0.25rem; }
    .breakdowns {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 1rem;
    }
    .breakdown {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 0.75rem;
      padding: 1.25rem;
    }
    .breakdown h2 { font-size: 0.875rem; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.75rem; }
    .tabs { margin-bottom: 0.75rem; }
    .tab-group { display: flex; gap: 0.25rem; }
    .tab {
      background: transparent;
      border: 1px solid var(--border);
      color: var(--text-dim);
      padding: 0.25rem 0.625rem;
      border-radius: 0.375rem;
      cursor: pointer;
      font-size: 0.75rem;
    }
    .tab.active { background: var(--accent-dim); color: white; border-color: var(--accent-dim); }
    .tab:hover { border-color: var(--accent); }
    table { width: 100%; border-collapse: collapse; display: none; }
    table.active { display: table; }
    th { text-align: left; font-size: 0.75rem; color: var(--text-dim); padding: 0.375rem 0; border-bottom: 1px solid var(--border); }
    td { padding: 0.375rem 0; font-size: 0.8rem; border-bottom: 1px solid var(--border); }
    td:nth-child(2), td:nth-child(3), th:nth-child(2), th:nth-child(3) { text-align: right; }
    .empty { text-align: center !important; color: var(--text-dim); padding: 1rem 0; }
    footer { text-align: center; margin-top: 2.5rem; color: var(--text-dim); font-size: 0.75rem; }
    footer a { color: var(--accent); text-decoration: none; }
    footer a:hover { text-decoration: underline; }
    @media (max-width: 640px) {
      .cards, .breakdowns { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>BLE Scale Sync</h1>
      <p>Anonymous usage statistics from update checks</p>
    </header>
    <div class="cards">
      ${renderPeriodCard(stats24h)}
      ${renderPeriodCard(stats7d)}
      ${renderPeriodCard(stats30d)}
    </div>
    <div class="breakdowns">
      ${renderBreakdown('Version', stats24h.versions, stats7d.versions, stats30d.versions, stats24h.totalChecks, stats7d.totalChecks, stats30d.totalChecks)}
      ${renderBreakdown('OS', stats24h.os, stats7d.os, stats30d.os, stats24h.totalChecks, stats7d.totalChecks, stats30d.totalChecks)}
      ${renderBreakdown('Architecture', stats24h.arch, stats7d.arch, stats30d.arch, stats24h.totalChecks, stats7d.totalChecks, stats30d.totalChecks)}
    </div>
    <footer>
      <p>Data from update check requests only. No personal data collected.</p>
      <p><a href="https://blescalesync.dev">blescalesync.dev</a></p>
      <p style="margin-top: 0.5rem">Released under the <a href="https://github.com/KristianP26/ble-scale-sync/blob/main/LICENSE">GPL-3.0 License</a>.</p>
      <p>Copyright &copy; 2026 Kristi&aacute;n Partl</p>
    </footer>
  </div>
  <script>
    document.querySelectorAll('.tab').forEach(btn => {
      btn.addEventListener('click', () => {
        const group = btn.closest('.tab-group')?.getAttribute('data-group');
        if (!group) return;
        document.querySelectorAll(\`.tab-group[data-group="\${group}"] .tab\`).forEach(t => t.classList.remove('active'));
        btn.classList.add('active');
        const period = btn.getAttribute('data-period');
        document.querySelectorAll(\`.tab-content[data-group="\${group}"]\`).forEach(t => {
          t.classList.toggle('active', t.getAttribute('data-period') === period);
        });
      });
    });
  </script>
</body>
</html>`;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── Request handler ────────────────────────────────────────────────────────

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'User-Agent',
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (request.method !== 'GET') {
      return new Response('Method not allowed', { status: 405 });
    }

    // GET /version
    if (url.pathname === '/version') {
      const client = parseUserAgent(request.headers.get('User-Agent'));

      // Record stats asynchronously (don't block the response)
      if (client) {
        ctx.waitUntil(recordHit(env.STATS, client));
      }

      const latest = await getLatestVersion(env.STATS);

      return new Response(JSON.stringify({ latest }), {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=3600',
          ...CORS_HEADERS,
        },
      });
    }

    // GET /stats/json
    if (url.pathname === '/stats/json') {
      const [stats24h, stats7d, stats30d] = await Promise.all([
        aggregateStats(env.STATS, 1),
        aggregateStats(env.STATS, 7),
        aggregateStats(env.STATS, 30),
      ]);

      return new Response(JSON.stringify({ stats24h, stats7d, stats30d }, null, 2), {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=300',
          ...CORS_HEADERS,
        },
      });
    }

    // GET /stats (or / on stats.blescalesync.dev)
    const isStatsDomain = url.hostname === 'stats.blescalesync.dev';
    if (url.pathname === '/stats' || (isStatsDomain && url.pathname === '/')) {
      const [stats24h, stats7d, stats30d] = await Promise.all([
        aggregateStats(env.STATS, 1),
        aggregateStats(env.STATS, 7),
        aggregateStats(env.STATS, 30),
      ]);

      return new Response(renderDashboard(stats24h, stats7d, stats30d), {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'public, max-age=300',
        },
      });
    }

    // GET / on api domain (redirect to stats)
    if (url.pathname === '/') {
      return Response.redirect(new URL('/stats', url.origin).toString(), 302);
    }

    return new Response('Not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
