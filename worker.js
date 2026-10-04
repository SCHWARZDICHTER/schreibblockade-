/**
 * Schreibblockade — Cloudflare Worker, EINE Datei. Voller Funktionsumfang.
 * Bindings: DB (D1, app-eigen) · VOUCHERS_DB (D1, 'schwarzdichter-zentrale-db')
 * Secrets: VENICE_API_KEY, DIGISTORE24_IPN_PASSWORD,
 *          ADMIN_SUPPORT_EMAIL, RESEND_API_KEY (optional),
 *          TURNSTILE_SITE_KEY, TURNSTILE_SECRET_KEY (optional – sanfter Fallback)
 */
const PBKDF2_ITERATIONS = 100000;
const te = new TextEncoder();
const RESEND_FROM = 'Schreibblockade <info@schwarzdichter.com>';
const DIGISTORE24_TOKEN_PACKAGES = { '741390': 500, '741391': 1200 };
const TOKEN_COST_USD = 0.019;          // interner Rechenwert: 1 Token ≈ 0,019 $ Netto-Erlös
const R2_PRICE_PER_GB_MONTH = 0.015;   // Cloudflare R2 Standard Storage
const MARGIN_MIN = 1.5;                 // mind. 50 % Marge auf reale API-Einkaufskosten

function adminSet(env) {
  return new Set(String((env && env.ADMIN_SUPPORT_EMAIL) || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
}
function isAdminEmail(env, email) { return adminSet(env).has(cleanEmail(email)); }
// 🔒 Zentrale Datenbank (schwarzdichter-zentrale-db) für Gutscheine & Modellpreise.
function centralDb(env) { return env.VOUCHERS_DB || env.DB; }

const STORAGE = {
  S: { gb: 11, tokens: 200, label: 'Paket S', blurb: 'Ca. 40 Manuskripte à 200 Normseiten. Ein Jahr.' },
  M: { gb: 25, tokens: 500, label: 'Paket M', blurb: 'Ca. 90 Manuskripte à 200 Normseiten. Ein Jahr.' },
  L: { gb: 50, tokens: 1100, label: 'Paket L', blurb: 'Ca. 180 Manuskripte à 200 Normseiten. Ein Jahr.' },
  XL: { gb: 100, tokens: 2200, label: 'Paket XL', blurb: 'Ca. 360 Manuskripte à 200 Normseiten. Ein Jahr.' },
};

// 🖼️ Bild-KIs. usd = realer Ist-Einkaufspreis pro Bild (für Margen-Floor & Dashboard).
// provider: 'Venice' | 'Runware' | 'Fal.ai'
// model = anbieterspezifische Modell-ID (bei Runware/Fal.ai der volle Modellpfad).
const IMAGE_MODELS = [
  // — Venice —
  { id: 'chroma', name: 'CHROMA Bildstark', tokens: 6, provider: 'Venice', model: 'chroma', usd: 0.012, sizing: 'none' },
  { id: 'venice-sd35', name: 'Venedig SD 35', tokens: 6, provider: 'Venice', model: 'venice-sd35', usd: 0.012, sizing: 'pixel' },
  { id: 'muse-image', name: 'Muse Image', tokens: 7, provider: 'Venice', model: 'muse-image', usd: 0.02, sizing: 'aspect' },
  { id: 'wan-27', name: 'WAN 27', tokens: 8, provider: 'Venice', model: 'wan-2-7-text-to-image', usd: 0.03, sizing: 'aspect' },
  { id: 'ideogram-v4', name: 'Ideogram V4', tokens: 9, provider: 'Venice', model: 'ideogram-v4', usd: 0.06, sizing: 'aspect' },
  { id: 'wan-27-pro', name: 'WAN 27 PRO', tokens: 10, provider: 'Venice', model: 'wan-2-7-pro-text-to-image', usd: 0.08, sizing: 'aspect' },
  // — Venice (Grok Imagine) —
  { id: 'grok-imagine', name: 'Grok Imagine', tokens: 9, provider: 'Venice', model: 'grok-imagine-image', usd: 0.05 },
  // — Runware (1. API) — liefert Ist-Preis pro Aufruf im Feld "cost" mit —
  { id: 'rw-flux-schnell', name: 'FLUX Schnell (Runware)', tokens: 7, provider: 'Runware', model: 'runware:100@1', usd: 0.0013 },
  { id: 'rw-sdxl', name: 'SDXL Base (Runware)', tokens: 7, provider: 'Runware', model: 'civitai:101055@128078', usd: 0.0013 },
  { id: 'rw-flux-dev', name: 'FLUX Dev (Runware)', tokens: 8, provider: 'Runware', model: 'runware:101@1', usd: 0.006 },
  { id: 'rw-juggernaut-pro', name: 'Juggernaut Pro FLUX (Runware)', tokens: 8, provider: 'Runware', model: 'rundiffusion:130@100', usd: 0.006 },
  // — Fal.ai (2. API) —
  { id: 'fal-flux-schnell', name: 'FLUX Schnell (Fal.ai)', tokens: 7, provider: 'Fal.ai', model: 'fal-ai/flux/schnell', usd: 0.003 },
  { id: 'fal-sdxl', name: 'SDXL (Fal.ai)', tokens: 7, provider: 'Fal.ai', model: 'fal-ai/fast-sdxl', usd: 0.003 },
  { id: 'fal-flux-dev', name: 'FLUX Dev (Fal.ai)', tokens: 8, provider: 'Fal.ai', model: 'fal-ai/flux/dev', usd: 0.025 },
];
// 🔌 Anbieter, die über den Admin-Master-Schalter pausierbar sind.
const IMAGE_PROVIDERS = ['Venice', 'Runware', 'Fal.ai', 'Google'];

// 📝 Text-KIs — einzeln wählbar. tokens = Kundenpreis/Normseite · inUsd/outUsd = Katalog pro 1 Mio Token.
const TEXT_MODELS = [
  // 💬 UNCENSORED / FREI
  { id: 'venice-uncensored-1-2', name: 'Venice Uncensored 1.2', provider: 'Venice', model: 'venice-uncensored-1-2', tokens: 11, uncensored: true, vision: false, tier: 'uncensored', inUsd: 0.20, outUsd: 0.90, desc: 'Freies, ungeschöntes Schreiben ganz ohne Filter. Haus-Modell für kompromisslose Texte.' },
  { id: 'qwen3-uncensored', name: 'Qwen 3.6 Uncensored', provider: 'Venice', model: 'e2ee-qwen3-6-35b-a3b-uncensored-p', tokens: 11, uncensored: true, vision: false, tier: 'uncensored', inUsd: 0.38, outUsd: 1.88, desc: 'Unzensiert und sehr stark im Erzählen. Gut für dichte, bildhafte Prosa.' },
  { id: 'gemma-4-uncensored', name: 'Gemma 4 Uncensored', provider: 'Venice', model: 'gemma-4-uncensored', tokens: 11, uncensored: true, vision: false, tier: 'uncensored', inUsd: 0.16, outUsd: 0.50, desc: 'Günstiges, freies Modell mit großer Kontextlänge. Ideal für lange Texte.' },
  { id: 'venice-roleplay-uncensored', name: 'Venice Role Play Uncensored', provider: 'Venice', model: 'venice-uncensored-role-play', tokens: 11, uncensored: true, vision: false, tier: 'uncensored', inUsd: 0.50, outUsd: 2.00, desc: 'Auf Figurenstimmen, Dialoge und Rollen spezialisiert — ungefiltert, ausdrucksstark.' },

  // 💵 GÜNSTIG & STARK
  { id: 'mistral-small-4', name: 'Mistral Small 4', provider: 'Venice', model: 'mistral-small-2603', tokens: 10, uncensored: false, vision: false, tier: 'budget', inUsd: 0.19, outUsd: 0.75, desc: 'Zuverlässiger Allrounder mit sauberem, natürlichem Deutsch.' },
  { id: 'deepseek-v3-2', name: 'DeepSeek V3.2', provider: 'Venice', model: 'deepseek-v3-2', tokens: 10, uncensored: false, vision: false, tier: 'budget', inUsd: 0.33, outUsd: 0.48, desc: 'Starkes Reasoning: denkt die Handlung durch, bevor es schreibt.' },
  { id: 'qwen3-6-35b-a3b', name: 'Qwen 3.6 35B', provider: 'Venice', model: 'qwen3-6-35b-a3b', tokens: 10, uncensored: false, vision: false, tier: 'budget', inUsd: 0.15, outUsd: 1.00, desc: 'Schnell und kreativ, sehr günstig. Guter Startpunkt für viele Entwürfe.' },
  { id: 'glm-4-7', name: 'GLM 4.7', provider: 'Venice', model: 'zai-org-glm-4-7', tokens: 10, uncensored: false, vision: false, tier: 'budget', inUsd: 0.55, outUsd: 2.65, desc: 'Stark in Bildsprache und Stimmung. Gut für atmosphärische, poetische Texte.' },

  // ⚡ OBERE MITTELKLASSE
  { id: 'gemini-3-5-flash', name: 'Gemini 3.5 Flash', provider: 'Venice', model: 'gemini-3-5-flash', tokens: 10, uncensored: false, vision: true, tier: 'mid', inUsd: 1.55, outUsd: 9.45, desc: 'Exzellentes Deutsch, versteht hochgeladene Bilder. Top-Allrounder.' },
  { id: 'grok-4-3', name: 'Grok 4.3', provider: 'Venice', model: 'grok-4-3', tokens: 10, uncensored: false, vision: false, tier: 'mid', inUsd: 1.42, outUsd: 2.83, desc: 'Frech, direkt und modern in der Sprache. Gut für kantige Erzählungen.' },
  { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', provider: 'Venice', model: 'deepseek-v4-pro', tokens: 10, uncensored: false, vision: false, tier: 'mid', inUsd: 1.73, outUsd: 3.80, desc: 'Viel Tiefgang bei komplexen Handlungen.' },
  { id: 'kimi-k2-6', name: 'Kimi K2.6', provider: 'Venice', model: 'kimi-k2-6', tokens: 10, uncensored: false, vision: false, tier: 'mid', inUsd: 0.75, outUsd: 3.50, desc: 'Stark bei langen, klar strukturierten Texten mit durchgehendem roten Faden.' },

  // 👑 PREMIUM-FLAGGSCHIFFE
  { id: 'grok-4-5', name: 'Grok 4.5', provider: 'Venice', model: 'grok-4-5', tokens: 10, uncensored: false, vision: false, tier: 'premium', inUsd: 2.27, outUsd: 6.80, desc: 'Premium-Grok: frech und zugleich klug. Moderne Sprache auf Top-Niveau.' },
  { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', provider: 'Venice', model: 'claude-sonnet-5', tokens: 14, uncensored: false, vision: true, tier: 'premium', inUsd: 3.00, outUsd: 15.00, desc: 'Herausragende literarische Qualität, liest auch Bilder.' },
  { id: 'gpt-5-4', name: 'GPT-5.4', provider: 'Venice', model: 'openai-gpt-54', tokens: 18, uncensored: false, vision: true, tier: 'premium', inUsd: 3.13, outUsd: 18.80, desc: 'Sehr vielseitiges Spitzenmodell mit Bildverständnis. Stark in jedem Genre.' },
  { id: 'grok-4-6', name: 'Grok 4.6 (Beste)', provider: 'Venice', model: 'grok-4-6', tokens: 28, uncensored: false, vision: false, tier: 'premium', inUsd: 3.00, outUsd: 9.00, desc: 'Das stärkste Grok-Modell. Tiefste erzählerische Qualität.' },
];
const TEXT_TIER_LABELS = { uncensored: '💬 Uncensored / Frei', budget: '💵 Günstig & stark', mid: '⚡ Obere Mittelklasse', premium: '👑 Premium-Flaggschiff' };
const DEFAULT_TEXT_MODEL = 'gemini-3-5-flash';
const DEFAULT_UNCENSORED = 'venice-uncensored-1-2';
const PAGE_POS = ['bottom-right', 'bottom-center', 'bottom-left', 'top-right', 'top-center', 'top-left', 'hidden'];
const TRIM_IDS = ['normseite', 'a5', '5x8', 'taschenbuch', '6x9', 'hardcover', 'custom'];

function textModelById(id) { return TEXT_MODELS.find(m => m.id === id); }
function imageModelById(id) { return IMAGE_MODELS.find(m => m.id === id); }
function pagesEquiv(pages) { return pages === 'max' ? 20 : Math.max(1, Math.min(60, pages | 0 || 1)); }
// Reale Einkaufskosten/Seite (grobe Schätzung ~800 In- + 420 Out-Token).
function textRealUsdPerPage(m) { return (m.inUsd || 0) / 1e6 * 800 + (m.outUsd || 0) / 1e6 * 420; }
function minTokensForMargin(realUsd) { return Math.max(1, Math.ceil(realUsd * MARGIN_MIN / TOKEN_COST_USD)); }
// Kundenpreis Text = Seiten × fester, geprüfter Preis pro Normseite (model.tokens).
// Identisch zu Tintenkiller: z.B. 20 Seiten mit Grok 4.6 = 20 × 28 = 560 Tokens.
// Jeder Preis in TEXT_MODELS deckt bereits ≥50 % Marge (geprüft, real 90–96 %).
function textCost(model, pages) {
  const eq = pagesEquiv(pages);
  const perPage = Math.max(1, model.tokens | 0);
  return eq * perPage;
}
function imageCost(model) { return Math.max(model.tokens | 0, minTokensForMargin(model.usd || 0)); }

export default {
  async fetch(request, env) {
    try {
      if (!env.DB) return new Response('D1 Binding "DB" fehlt.', { status: 500 });
      await ensureSchema(env);
      const url = new URL(request.url);
      if (url.pathname === '/integrations/digistore24/tokens' || url.pathname === '/ipn/digistore24') return handleDigistore(request, env, url);
      if (url.pathname.startsWith('/api/')) return handleApi(request, env, url);
      if (url.pathname === '/manifest.json') {
        return new Response(JSON.stringify({
          name: 'Schreibblockade', short_name: 'Schreibblockade', start_url: '/', display: 'standalone',
          background_color: '#121216', theme_color: '#121216', lang: 'de',
          icons: [{ src: '/icon.svg', sizes: '512x512', type: 'image/svg+xml', purpose: 'any' }],
        }), { headers: { 'content-type': 'application/manifest+json' } });
      }
      if (url.pathname === '/icon.svg') {
        return new Response(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="80" fill="#121216"/><text x="256" y="300" text-anchor="middle" font-size="220">&#128128;</text></svg>`, { headers: { 'content-type': 'image/svg+xml' } });
      }
      if (url.pathname === '/sw.js') {
        return new Response(`self.addEventListener('install',e=>self.skipWaiting());self.addEventListener('activate',e=>e.waitUntil(clients.claim()));`, { headers: { 'content-type': 'text/javascript', 'cache-control': 'no-store' } });
      }
      if (url.pathname.startsWith('/m/')) return handleShareRead(request, env, url);
      if (request.method === 'GET') return new Response(APP_HTML, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
      return json({ error: 'Nicht gefunden.' }, 404);
    } catch (e) { return json({ error: e.message || 'Serverfehler' }, 500); }
  },
};

function json(obj, status = 200) { return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8' } }); }
function cleanEmail(x) { return String(x || '').trim().toLowerCase(); }
function isValidEmail(x) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(x || '')); }
function escHtml(x) { return String(x || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function originOk(request, url) {
  const o = request.headers.get('Origin'); const r = request.headers.get('Referer');
  if (o) return o === url.origin;
  if (r) return r.startsWith(url.origin + '/') || r === url.origin;
  return false;
}
function getClientIp(request) { return request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'unknown'; }
function constantTimeEqual(a, b) { a = String(a || ''); b = String(b || ''); if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; }
function arrayBufferToBase64(buffer) { const bytes = new Uint8Array(buffer); let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); }
function arrayBufferToHex(buffer) { return Array.from(new Uint8Array(buffer), b => b.toString(16).padStart(2, '0')).join(''); }
async function passwordHash(p, s, iterations) { const key = await crypto.subtle.importKey('raw', te.encode(p), 'PBKDF2', false, ['deriveBits']); const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: te.encode(s), iterations: iterations || PBKDF2_ITERATIONS, hash: 'SHA-256' }, key, 256); return arrayBufferToBase64(bits); }
async function sha(v) { return arrayBufferToBase64(await crypto.subtle.digest('SHA-256', te.encode(v))); }
function cookieToken(request) { const m = (request.headers.get('Cookie') || '').match(/(?:^|;\s*)sb_sid=([^;]+)/); return m ? decodeURIComponent(m[1]) : ''; }
function sessionCookie(raw, maxAge) { return `sb_sid=${encodeURIComponent(raw)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`; }
function splitSentences(text) { const m = String(text || '').match(/[^.!?…]+[.!?…]+["»“”']*\s*|[^.!?…]+$/g); return (m || []).map(s => s.trim()).filter(Boolean); }

async function checkRateLimit(db, key, maxAttempts, windowMs) {
  try {
    const cutoff = Date.now() - windowMs;
    await db.prepare('DELETE FROM sb_rate_limits WHERE created_at < ?').bind(cutoff).run();
    const row = await db.prepare('SELECT COUNT(*) AS n FROM sb_rate_limits WHERE rl_key=? AND created_at>=?').bind(key, cutoff).first();
    if ((row?.n | 0) >= maxAttempts) return false;
    await db.prepare('INSERT INTO sb_rate_limits (rl_key, created_at) VALUES (?,?)').bind(key, Date.now()).run();
    return true;
  } catch (e) { return false; }
}
async function requireTurnstile(env, token, request) {
  if (!env.TURNSTILE_SECRET_KEY || !env.TURNSTILE_SITE_KEY) return;
  if (!token) throw Object.assign(new Error('Sicherheitsprüfung nötig. Bitte Seite neu laden.'), { status: 400 });
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY, response: token, remoteip: getClientIp(request) }) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.success) throw Object.assign(new Error('Sicherheitsprüfung fehlgeschlagen. Bitte erneut versuchen.'), { status: 403 });
}

async function ensureSchema(env) {
  const db = env.DB;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS user_tokens (
      user_email TEXT PRIMARY KEY, token_balance INTEGER NOT NULL DEFAULT 0, role TEXT DEFAULT 'user',
      password_hash TEXT, password_salt TEXT, password_iterations INTEGER DEFAULT 100000,
      failed_login_attempts INTEGER DEFAULT 0, locked_until INTEGER, created_at TEXT)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_email TEXT NOT NULL, expires_at INTEGER NOT NULL)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS sb_books (
      id TEXT PRIMARY KEY, user_email TEXT NOT NULL, title TEXT NOT NULL, genre TEXT DEFAULT 'Roman',
      outline TEXT DEFAULT '', characters_json TEXT DEFAULT '[]', chapters_json TEXT NOT NULL DEFAULT '[]',
      is_adult_content INTEGER NOT NULL DEFAULT 0, quotes_style TEXT DEFAULT 'german', view_mode TEXT DEFAULT 'manuscript',
      trim_format TEXT DEFAULT 'normseite', author_name TEXT DEFAULT '', blurb TEXT DEFAULT '', imprint TEXT DEFAULT '',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, expires_at TEXT NOT NULL,
      bleed_mm INTEGER DEFAULT 3, page_number_pos TEXT DEFAULT 'bottom-center', page_number_visible INTEGER DEFAULT 1,
      custom_width_mm INTEGER, custom_height_mm INTEGER, dedication_from TEXT DEFAULT '', dedication_to TEXT DEFAULT '')`),
    db.prepare(`CREATE TABLE IF NOT EXISTS gt_token_ledger (id TEXT PRIMARY KEY, user_email TEXT NOT NULL, action_type TEXT NOT NULL, description TEXT NOT NULL, token_amount INTEGER NOT NULL, created_at TEXT NOT NULL)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS gt_digistore24_token_orders (order_key TEXT PRIMARY KEY, order_id TEXT NOT NULL, buyer_email TEXT NOT NULL, product_id TEXT NOT NULL, tokens INTEGER NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, processed_at TEXT, note TEXT)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS gt_ai_gallery_support (user_email TEXT PRIMARY KEY, active_since TEXT NOT NULL, expires_at TEXT NOT NULL, is_active INTEGER NOT NULL DEFAULT 1, plan_key TEXT NOT NULL DEFAULT 's')`),
    db.prepare(`CREATE TABLE IF NOT EXISTS sb_rate_limits (id INTEGER PRIMARY KEY AUTOINCREMENT, rl_key TEXT NOT NULL, created_at INTEGER NOT NULL)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_sb_rate_limits_key ON sb_rate_limits (rl_key, created_at)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS gt_api_cost_log (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, provider TEXT NOT NULL, model_id TEXT NOT NULL, model_name TEXT NOT NULL, action TEXT NOT NULL, real_cost_usd REAL, tokens_charged INTEGER)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS sb_provider_switches (provider TEXT PRIMARY KEY, is_active INTEGER NOT NULL DEFAULT 1, updated_at TEXT)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS sb_messages (id TEXT PRIMARY KEY, user_email TEXT NOT NULL, sender TEXT NOT NULL, message TEXT NOT NULL, created_at TEXT NOT NULL, read_by_admin INTEGER NOT NULL DEFAULT 0)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS sb_feedback (id TEXT PRIMARY KEY, name TEXT, email TEXT, message TEXT NOT NULL, created_at TEXT NOT NULL)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS sb_shares (token TEXT PRIMARY KEY, book_id TEXT NOT NULL, owner_email TEXT NOT NULL, r2_key TEXT NOT NULL, title TEXT, created_at TEXT NOT NULL, expires_at TEXT NOT NULL)`),
  ]);
  const alters = [
    "ALTER TABLE sb_books ADD COLUMN genre TEXT DEFAULT 'Roman'",
    "ALTER TABLE sb_books ADD COLUMN outline TEXT DEFAULT ''",
    "ALTER TABLE sb_books ADD COLUMN characters_json TEXT DEFAULT '[]'",
    "ALTER TABLE sb_books ADD COLUMN bleed_mm INTEGER DEFAULT 3",
    "ALTER TABLE sb_books ADD COLUMN page_number_pos TEXT DEFAULT 'bottom-center'",
    "ALTER TABLE sb_books ADD COLUMN page_number_visible INTEGER DEFAULT 1",
    "ALTER TABLE sb_books ADD COLUMN custom_width_mm INTEGER",
    "ALTER TABLE sb_books ADD COLUMN custom_height_mm INTEGER",
    "ALTER TABLE sb_books ADD COLUMN dedication_from TEXT DEFAULT ''",
    "ALTER TABLE sb_books ADD COLUMN dedication_to TEXT DEFAULT ''",
    "ALTER TABLE user_tokens ADD COLUMN vorname TEXT",
    "ALTER TABLE user_tokens ADD COLUMN nachname TEXT",
  ];
  for (const sql of alters) { try { await db.prepare(sql).run(); } catch (e) {} }
  // Zentrale DB: Gutscheine + Modellpreise (schwarzdichter-zentrale-db).
  const cdb = centralDb(env);
  if (cdb) {
    try { await cdb.prepare(`CREATE TABLE IF NOT EXISTS voucher_codes (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT, token_value INTEGER, is_redeemed INTEGER, redeemed_by TEXT)`).run(); } catch (e) {}
    try { await cdb.prepare(`CREATE TABLE IF NOT EXISTS central_model_prices (model_key TEXT PRIMARY KEY, display_name TEXT, provider TEXT, token_cost INTEGER NOT NULL, is_active INTEGER NOT NULL DEFAULT 1, updated_at TEXT)`).run(); } catch (e) {}
  }
}

async function currentUser(request, env) {
  const raw = cookieToken(request); if (!raw) return null;
  const db = env.DB;
  const row = await db.prepare('SELECT s.user_email, s.expires_at, u.token_balance, u.role, u.vorname, u.nachname, u.password_hash, u.password_salt, u.password_iterations FROM sessions s JOIN user_tokens u ON u.user_email=s.user_email WHERE s.token_hash=?').bind(await sha(raw)).first();
  if (!row || row.expires_at < Date.now()) return null;
  const pack = await db.prepare('SELECT plan_key, expires_at, is_active FROM gt_ai_gallery_support WHERE user_email=?').bind(row.user_email).first();
  const packLive = !!(pack && pack.is_active === 1 && pack.expires_at > new Date().toISOString());
  return { email: row.user_email, tokens: row.token_balance | 0, role: isAdminEmail(env, row.user_email) ? 'admin' : (row.role || 'user'), vorname: row.vorname || '', nachname: row.nachname || '', pwHash: row.password_hash, pwSalt: row.password_salt, pwIter: row.password_iterations || 100000, plan: packLive ? String(pack.plan_key || 's').toUpperCase() : 'none', planUntil: packLive ? pack.expires_at : null };
}
async function requireUser(request, env, url) {
  if (['POST', 'PUT', 'DELETE'].includes(request.method) && !originOk(request, url)) throw Object.assign(new Error('Herkunft abgelehnt.'), { status: 403 });
  const u = await currentUser(request, env); if (!u) throw Object.assign(new Error('Bitte anmelden.'), { status: 401 });
  return u;
}
async function logTx(db, email, type, desc, amount) { await db.prepare('INSERT INTO gt_token_ledger (id,user_email,action_type,description,token_amount,created_at) VALUES (?,?,?,?,?,?)').bind(crypto.randomUUID(), email, type, desc, amount, new Date().toISOString()).run(); }
async function logApiCost(db, provider, modelId, modelName, action, realCostUsd, tokensCharged) {
  try { await db.prepare('INSERT INTO gt_api_cost_log (id,created_at,provider,model_id,model_name,action,real_cost_usd,tokens_charged) VALUES (?,?,?,?,?,?,?,?)').bind(crypto.randomUUID(), new Date().toISOString(), provider, modelId, modelName, action, realCostUsd ?? null, tokensCharged ?? null).run(); } catch (e) {}
}
async function debit(db, user, cost, type, desc) {
  if (cost <= 0) return user.tokens;
  const row = await db.prepare('SELECT token_balance FROM user_tokens WHERE user_email=?').bind(user.email).first();
  const bal = row?.token_balance | 0;
  if (bal < cost) throw Object.assign(new Error(`Nicht genug Tokens (${cost} nötig, ${bal} vorhanden). Tokens kaufen oder Gutschein einlösen.`), { status: 402 });
  await db.prepare('UPDATE user_tokens SET token_balance = token_balance - ? WHERE user_email=? AND token_balance >= ?').bind(cost, user.email, cost).run();
  await logTx(db, user.email, type, desc, -cost);
  user.tokens = bal - cost; return user.tokens;
}
function bookExpiry(user) { if (user.plan !== 'none' && user.planUntil) return user.planUntil; return new Date(Date.now() + 7 * 86400000).toISOString(); }
function bookAlive(book, user) { if (user.plan !== 'none') return true; return String(book.expires_at || '') > new Date().toISOString(); }
async function applyPendingDigistore(db, email) {
  const pending = (await db.prepare("SELECT * FROM gt_digistore24_token_orders WHERE buyer_email=? AND status='waiting_for_account'").bind(email).all())?.results || [];
  for (const o of pending) {
    const now = new Date().toISOString();
    await db.batch([
      db.prepare('UPDATE user_tokens SET token_balance = token_balance + ? WHERE user_email=?').bind(o.tokens, email),
      db.prepare("UPDATE gt_digistore24_token_orders SET status='credited', processed_at=? WHERE order_key=?").bind(now, o.order_key),
      db.prepare('INSERT INTO gt_token_ledger (id,user_email,action_type,description,token_amount,created_at) VALUES (?,?,?,?,?,?)').bind(crypto.randomUUID(), email, 'DIGISTORE24', `Digistore24 ${o.order_id}: +${o.tokens} Tokens`, o.tokens, now),
    ]);
  }
}

// Zentrale Preis-/Pausensteuerung (central_model_prices in der zentralen DB).
async function effectiveModel(env, kind, model) {
  const row = await centralDb(env).prepare('SELECT token_cost,is_active FROM central_model_prices WHERE model_key=?').bind(kind + '|' + model.id).first();
  if (!row) return model;
  if (Number(row.is_active) !== 1) throw Object.assign(new Error('🚫 Dieses Modell ist derzeit zentral pausiert.'), { status: 403 });
  return Object.assign({}, model, { tokens: Number(row.token_cost) });
}

// Master-Schalter pro Anbieter (sb_provider_switches, lokale DB). Fehlt eine Zeile → aktiv.
async function assertProviderActive(env, provider) {
  const row = await env.DB.prepare('SELECT is_active FROM sb_provider_switches WHERE provider=?').bind(provider).first();
  if (row && Number(row.is_active) !== 1) throw Object.assign(new Error('🚫 Der Anbieter „' + provider + '" ist derzeit im Admin pausiert.'), { status: 403 });
}

// Text-Anbieter-Pause: Pausierter Anbieter → sofort Gemini-Fallback, wenn konfiguriert (GOOGLE_TEXT_FALLBACK_OFF!=1).
// Nur wenn kein Google-Fallback aktiv ist, wird hart abgelehnt. Rückgabe = ggf. auf Google umgestelltes Modell.
async function resolveTextFallback(env, model) {
  const row = await env.DB.prepare('SELECT is_active FROM sb_provider_switches WHERE provider=?').bind(model.provider).first();
  if (!row || Number(row.is_active) === 1) return model;
  const key = env.GEMINI_API_KEY_2 || env.GEMINI_API_KEY;
  if (!key || env.GOOGLE_TEXT_FALLBACK_OFF === '1') {
    throw Object.assign(new Error('🚫 Der Anbieter „' + model.provider + '" ist derzeit im Admin pausiert und kein Google-Fallback aktiv.'), { status: 403 });
  }
  return Object.assign({}, model, { provider: 'Google', model: String(env.STORY_GEMINI_MODEL || 'gemini-3.6-flash').replace(/^models\//, '') });
}

async function handleApi(request, env, url) {
  const db = env.DB; const path = url.pathname;
  try {
    if (path === '/api/config' && request.method === 'GET') return json({ turnstileSiteKey: env.TURNSTILE_SITE_KEY || '' });
    if (path === '/api/me' && request.method === 'GET') { const u = await currentUser(request, env); return json({ user: publicUser(u), turnstileSiteKey: env.TURNSTILE_SITE_KEY || '', textModels: publicTextModels(), imageModels: publicImageModels() }); }

    if (path === '/api/register' && request.method === 'POST') {
      if (!originOk(request, url)) return json({ error: 'Herkunft abgelehnt.' }, 403);
      const p = await request.json();
      if (String(p.website || '').trim()) return json({ error: 'Anfrage abgelehnt.' }, 400);
      if (!(await checkRateLimit(db, 'register:' + getClientIp(request), 5, 60 * 60 * 1000))) return json({ error: 'Zu viele Registrierungen von deiner Adresse. Bitte in einer Stunde erneut.' }, 429);
      await requireTurnstile(env, p.turnstileToken, request);
      const email = cleanEmail(p.email); const password = String(p.password || '');
      if (!isValidEmail(email)) return json({ error: 'Ungültige E-Mail.' }, 400);
      if (password.length < 8) return json({ error: 'Passwort mindestens 8 Zeichen.' }, 400);
      const exists = await db.prepare('SELECT user_email FROM user_tokens WHERE user_email=?').bind(email).first();
      if (exists) return json({ error: 'Diese E-Mail ist schon registriert.' }, 409);
      const salt = crypto.randomUUID(); const hash = await passwordHash(password, salt, PBKDF2_ITERATIONS);
      const admin = isAdminEmail(env, email);
      // 2 Gratis-Tokens für neue Nutzer (Premium-Features bleiben margengeschützt). Admins erhalten Arbeitsguthaben.
      await db.prepare('INSERT INTO user_tokens (user_email,token_balance,role,password_hash,password_salt,password_iterations,created_at) VALUES (?,?,?,?,?,?,?)')
        .bind(email, admin ? 500 : 2, admin ? 'admin' : 'user', hash, salt, PBKDF2_ITERATIONS, new Date().toISOString()).run();
      await applyPendingDigistore(db, email);
      return setSession(db, env, email);
    }
    if (path === '/api/login' && request.method === 'POST') {
      if (!originOk(request, url)) return json({ error: 'Herkunft abgelehnt.' }, 403);
      const p = await request.json();
      if (String(p.website || '').trim()) return json({ error: 'Anfrage abgelehnt.' }, 400);
      if (!(await checkRateLimit(db, 'login:' + getClientIp(request), 20, 15 * 60 * 1000))) return json({ error: 'Zu viele Login-Versuche. Bitte in 15 Minuten erneut.' }, 429);
      await requireTurnstile(env, p.turnstileToken, request);
      const email = cleanEmail(p.email); const password = String(p.password || '');
      const row = await db.prepare('SELECT * FROM user_tokens WHERE user_email=?').bind(email).first();
      if (row?.locked_until && row.locked_until > Date.now()) return json({ error: 'Konto kurz gesperrt. Bitte später erneut.' }, 423);
      const ok = !!(row && row.password_hash && row.password_salt && constantTimeEqual(await passwordHash(password, row.password_salt, row.password_iterations || 100000), row.password_hash));
      if (!ok) { if (row) { const fails = (row.failed_login_attempts | 0) + 1; await db.prepare('UPDATE user_tokens SET failed_login_attempts=?, locked_until=? WHERE user_email=?').bind(fails, fails >= 8 ? Date.now() + 15 * 60 * 1000 : null, email).run(); } return json({ error: 'E-Mail oder Passwort falsch.' }, 401); }
      await db.prepare('UPDATE user_tokens SET failed_login_attempts=0, locked_until=NULL WHERE user_email=?').bind(email).run();
      if (isAdminEmail(env, email)) await db.prepare("UPDATE user_tokens SET role='admin' WHERE user_email=?").bind(email).run();
      await applyPendingDigistore(db, email);
      return setSession(db, env, email);
    }
    if (path === '/api/logout' && request.method === 'POST') {
      const raw = cookieToken(request); if (raw) await db.prepare('DELETE FROM sessions WHERE token_hash=?').bind(await sha(raw)).run();
      return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json', 'set-cookie': sessionCookie('deleted', 0) } });
    }
    // Gäste-Feedback aus dem Footer – KEIN Login nötig (Honeypot + Rate-Limit gegen Spam).
    if (path === '/api/feedback' && request.method === 'POST') {
      if (!originOk(request, url)) return json({ error: 'Herkunft abgelehnt.' }, 403);
      const p = await request.json();
      if (String(p.website || '').trim()) return json({ ok: true }); // Honeypot: Bot gefüllt → still schlucken
      if (!(await checkRateLimit(db, 'feedback:' + getClientIp(request), 3, 60 * 60 * 1000))) return json({ error: 'Zu viele Nachrichten von deiner Adresse. Bitte in einer Stunde erneut.' }, 429);
      const name = String(p.name || '').trim().slice(0, 100);
      const email = String(p.email || '').trim().slice(0, 200);
      const message = String(p.message || '').trim().slice(0, 4000);
      if (email && !isValidEmail(email)) return json({ error: 'Ungültige E-Mail.' }, 400);
      if (!message) return json({ error: 'Bitte eine Nachricht eingeben.' }, 400);
      await db.prepare('INSERT INTO sb_feedback (id,name,email,message,created_at) VALUES (?,?,?,?,?)').bind(crypto.randomUUID(), name, email, message, new Date().toISOString()).run();
      for (const adminMail of adminSet(env)) {
        await sendResend(env, adminMail, 'Neues Gäste-Feedback (Schreibblockade)', '<div style="font-family:Arial;background:#121216;color:#e0e0e0;padding:24px"><h2 style="color:#ff4b4f">Gäste-Feedback</h2><p><b>Name:</b> ' + escHtml(name || '—') + '</p><p><b>E-Mail:</b> ' + escHtml(email || '—') + '</p><p style="white-space:pre-wrap">' + escHtml(message) + '</p></div>');
      }
      return json({ ok: true });
    }

    const user = await requireUser(request, env, url);

    // ===== Modul 4: Manuskript als PDF in R2 ablegen + Lese-Link (7 Tage) per Mail =====
    if (path === '/api/books/send' && request.method === 'POST') {
      if (!env.BUCKET) return json({ error: 'R2-Speicher (BUCKET) ist nicht eingerichtet.' }, 503);
      if (!(await checkRateLimit(db, 'booksend:' + user.email, 5, 60 * 60 * 1000))) return json({ error: 'Zu viele E-Mails (max. 5 pro Stunde). Bitte später erneut.' }, 429);
      const p = await request.json();
      const bookId = String(p.bookId || '');
      const toEmail = cleanEmail(p.toEmail);
      const pdfB64 = String(p.pdfBase64 || '');
      if (!isValidEmail(toEmail)) return json({ error: 'Ungültige Empfänger-E-Mail.' }, 400);
      if (!pdfB64) return json({ error: 'Keine PDF-Daten erhalten.' }, 400);
      // Buch muss dem Nutzer gehören und leben.
      const b = await db.prepare('SELECT * FROM sb_books WHERE id=? AND user_email=?').bind(bookId, user.email).first();
      if (!b || !bookAlive(b, user)) return json({ error: 'Manuskript nicht gefunden.' }, 404);
      // Base64 → Bytes.
      const raw = pdfB64.includes(',') ? pdfB64.split(',')[1] : pdfB64;
      let bytes;
      try { const bin = atob(raw); bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i); }
      catch (e) { return json({ error: 'PDF-Daten unlesbar.' }, 400); }
      if (bytes.byteLength < 100 || bytes.byteLength > 45 * 1024 * 1024) return json({ error: 'PDF fehlt oder ist zu groß (max. 45 MB).' }, 400);
      // Grobe Plausibilität: PDF beginnt mit %PDF (0x25 0x50 0x44 0x46).
      if (bytes[0] !== 0x25 || bytes[1] !== 0x50 || bytes[2] !== 0x44 || bytes[3] !== 0x46) return json({ error: 'Kein gültiges PDF.' }, 400);
      // In R2 ablegen (Binding BUCKET, Bucket 'schreibblockade-vault').
      const token = (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, '');
      const r2Key = 'manuscripts/' + user.email + '/' + token + '.pdf';
      await env.BUCKET.put(r2Key, bytes, { httpMetadata: { contentType: 'application/pdf' } });
      const now = new Date().toISOString(); const until = new Date(Date.now() + 7 * 86400000).toISOString(); // Link exakt 7 Tage gültig
      await db.prepare('INSERT INTO sb_shares (token,book_id,owner_email,r2_key,title,created_at,expires_at) VALUES (?,?,?,?,?,?,?)').bind(token, bookId, user.email, r2Key, b.title || 'Manuskript', now, until).run();
      // Mail mit Lese-Link.
      const link = url.origin + '/m/' + token;
      const okMail = await sendResend(env, toEmail, (b.title || 'Ein Manuskript') + ' – geteilt über Schreibblockade',
        '<div style="font-family:Arial;background:#121216;color:#e0e0e0;padding:28px"><h2 style="color:#ff4b4f">📖 ' + escHtml(b.title || 'Manuskript') + '</h2><p>' + escHtml(user.email) + ' hat dir ein Manuskript geschickt.</p><p style="margin:22px 0"><a href="' + link + '" style="background:#ff4b4f;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:bold">Manuskript lesen &amp; als PDF laden</a></p><p class="muted" style="color:#9999a2;font-size:13px">Der Link ist 7 Tage gültig.</p></div>');
      return json({ ok: true, link, mailed: okMail !== false });
    }

    // 🎟️ Gutschein gegen zentrale voucher_codes einlösen & entwerten.
    if (path === '/api/voucher' && request.method === 'POST') {
      const code = String((await request.json()).code || '').trim();
      if (!code) return json({ error: 'Bitte einen Gutscheincode eingeben.' }, 400);
      if (!(await checkRateLimit(db, 'voucher:' + getClientIp(request), 15, 60 * 60 * 1000))) return json({ error: 'Zu viele Versuche. Bitte später erneut.' }, 429);
      const cdb = centralDb(env);
      const v = await cdb.prepare('SELECT * FROM voucher_codes WHERE code=? AND is_redeemed=0').bind(code).first();
      if (!v) return json({ error: 'Ungültiger oder bereits eingelöster Code.' }, 404);
      const upd = await cdb.prepare('UPDATE voucher_codes SET is_redeemed=1, redeemed_by=? WHERE id=? AND is_redeemed=0').bind(user.email, v.id).run();
      if (!upd.meta.changes) return json({ error: 'Code wurde gerade schon eingelöst.' }, 409);
      const val = Number(v.token_value || 0);
      await db.prepare('UPDATE user_tokens SET token_balance = token_balance + ? WHERE user_email=?').bind(val, user.email).run();
      await logTx(db, user.email, 'VOUCHER', `Gutschein ${code}: +${val} Tokens`, val);
      const fresh = await currentUser(request, env);
      return json({ ok: true, added: val, user: fresh });
    }

    // ===== Mein Konto: Profil aktualisieren =====
    if (path === '/api/account/profile' && request.method === 'POST') {
      const p = await request.json();
      const vorname = String(p.vorname || '').trim().slice(0, 80);
      const nachname = String(p.nachname || '').trim().slice(0, 80);
      const newPassword = String(p.newPassword || '');
      const current = String(p.currentPassword || '');
      let pwSql = '', pwArgs = [];
      if (newPassword) {
        if (newPassword.length < 8) return json({ error: 'Neues Passwort mindestens 8 Zeichen.' }, 400);
        const full = await db.prepare('SELECT password_hash, password_salt, password_iterations FROM user_tokens WHERE user_email=?').bind(user.email).first();
        const ok = !!(full?.password_hash && full?.password_salt && constantTimeEqual(await passwordHash(current, full.password_salt, full.password_iterations || 100000), full.password_hash));
        if (!ok) return json({ error: 'Aktuelles Passwort ist falsch.' }, 403);
        const salt = crypto.randomUUID(); const hash = await passwordHash(newPassword, salt, PBKDF2_ITERATIONS);
        pwSql = ', password_hash=?, password_salt=?, password_iterations=?'; pwArgs = [hash, salt, PBKDF2_ITERATIONS];
      }
      await db.prepare('UPDATE user_tokens SET vorname=?, nachname=?' + pwSql + ' WHERE user_email=?').bind(vorname, nachname, ...pwArgs, user.email).run();
      return json({ ok: true, user: publicUser(await currentUser(request, env)) });
    }

    // ===== Mein Konto: Support-Nachricht (intern + E-Mail an Admin) =====
    if (path === '/api/account/support' && request.method === 'POST') {
      if (!(await checkRateLimit(db, 'support:' + user.email, 10, 60 * 60 * 1000))) return json({ error: 'Zu viele Nachrichten. Bitte später erneut.' }, 429);
      const msg = String((await request.json()).message || '').trim().slice(0, 4000);
      if (!msg) return json({ error: 'Bitte eine Nachricht eingeben.' }, 400);
      await db.prepare('INSERT INTO sb_messages (id,user_email,sender,message,created_at,read_by_admin) VALUES (?,?,?,?,?,0)').bind(crypto.randomUUID(), user.email, 'user', msg, new Date().toISOString()).run();
      // E-Mail an alle Admin-Adressen (ADMIN_SUPPORT_EMAIL), inkl. machtohnemacht@gmail.com.
      for (const adminMail of adminSet(env)) {
        await sendResend(env, adminMail, 'Neue Support-Nachricht von ' + user.email, '<div style="font-family:Arial;background:#121216;color:#e0e0e0;padding:24px"><h2 style="color:#ff4b4f">Neue Support-Nachricht</h2><p><b>Von:</b> ' + escHtml(user.email) + '</p><p style="white-space:pre-wrap">' + escHtml(msg) + '</p></div>');
      }
      return json({ ok: true });
    }

    // ===== Mein Konto: eigener Nachrichtenverlauf =====
    if (path === '/api/account/messages' && request.method === 'GET') {
      const rows = (await db.prepare('SELECT sender, message, created_at FROM sb_messages WHERE user_email=? ORDER BY created_at ASC LIMIT 200').bind(user.email).all())?.results || [];
      return json({ messages: rows, user });
    }

    // ===== Mein Konto: Konto löschen =====
    if (path === '/api/account/delete' && request.method === 'POST') {
      const p = await request.json();
      if (String(p.confirm || '') !== 'LÖSCHEN') return json({ error: 'Bitte zur Bestätigung LÖSCHEN eingeben.' }, 400);
      const current = String(p.currentPassword || '');
      const full = await db.prepare('SELECT password_hash, password_salt, password_iterations FROM user_tokens WHERE user_email=?').bind(user.email).first();
      const ok = !!(full?.password_hash && full?.password_salt && constantTimeEqual(await passwordHash(current, full.password_salt, full.password_iterations || 100000), full.password_hash));
      if (!ok) return json({ error: 'Aktuelles Passwort ist falsch.' }, 403);
      await db.batch([
        db.prepare('DELETE FROM sb_books WHERE user_email=?').bind(user.email),
        db.prepare('DELETE FROM sb_messages WHERE user_email=?').bind(user.email),
        db.prepare('DELETE FROM gt_token_ledger WHERE user_email=?').bind(user.email),
        db.prepare('DELETE FROM gt_ai_gallery_support WHERE user_email=?').bind(user.email),
        db.prepare('DELETE FROM sessions WHERE user_email=?').bind(user.email),
        db.prepare('DELETE FROM user_tokens WHERE user_email=?').bind(user.email),
      ]);
      return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json', 'set-cookie': sessionCookie('deleted', 0) } });
    }

    if (path === '/api/books' && request.method === 'GET') {
      const rows = (await db.prepare('SELECT id,title,genre,is_adult_content,created_at,expires_at,updated_at,chapters_json FROM sb_books WHERE user_email=? ORDER BY COALESCE(updated_at,created_at) DESC').bind(user.email).all())?.results || [];
      const books = [];
      for (const b of rows) { if (!bookAlive(b, user)) continue; let pages = []; try { pages = JSON.parse(b.chapters_json || '[]'); } catch (e) { pages = []; } const chars = pages.reduce((n, pg) => n + String(pg.body || '').length, 0); books.push({ id: b.id, title: b.title, genre: b.genre || 'Roman', isAdult: !!b.is_adult_content, pages: pages.length, chars, expiresAt: user.plan === 'none' ? b.expires_at : null }); }
      return json({ books, user });
    }
    if (path === '/api/books' && request.method === 'POST') {
      const p = await request.json(); const id = crypto.randomUUID(); const now = new Date().toISOString();
      const chapters = JSON.stringify([{ id: crypto.randomUUID(), body: '', imageUrl: '', imagePrompt: '' }]);
      await db.prepare('INSERT INTO sb_books (id,user_email,title,genre,outline,characters_json,chapters_json,is_adult_content,created_at,updated_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .bind(id, user.email, String(p.title || 'Ohne Titel').slice(0, 180), String(p.genre || 'Roman').slice(0, 80), '', '[]', chapters, p.isAdult ? 1 : 0, now, now, bookExpiry(user)).run();
      return json({ id });
    }
    const bookGet = path.match(/^\/api\/books\/([0-9a-f-]{36})$/i);
    if (bookGet && request.method === 'GET') {
      const b = await db.prepare('SELECT * FROM sb_books WHERE id=? AND user_email=?').bind(bookGet[1], user.email).first();
      if (!b || !bookAlive(b, user)) return json({ error: 'Manuskript nicht gefunden.' }, 404);
      return json({ book: serializeBook(b), user });
    }
    if (bookGet && request.method === 'PUT') {
      const b = await db.prepare('SELECT id FROM sb_books WHERE id=? AND user_email=?').bind(bookGet[1], user.email).first();
      if (!b) return json({ error: 'Manuskript nicht gefunden.' }, 404);
      const p = await request.json();
      const pages = Array.isArray(p.pages) ? p.pages : [];
      const clean = pages.slice(0, 2000).map(pg => ({ id: String(pg.id || crypto.randomUUID()), body: String(pg.body || '').slice(0, 8000), imageUrl: String(pg.imageUrl || '').slice(0, 180000), imagePrompt: String(pg.imagePrompt || '').slice(0, 2000) }));
      if (!clean.length) clean.push({ id: crypto.randomUUID(), body: '', imageUrl: '', imagePrompt: '' });
      const chars = Array.isArray(p.characters) ? JSON.stringify(p.characters.slice(0, 40).map(c => ({ name: String(c.name || '').slice(0, 120), role: String(c.role || '').slice(0, 120), traits: String(c.traits || '').slice(0, 1200) }))) : '[]';
      const now = new Date().toISOString();
      await db.prepare(`UPDATE sb_books SET title=?, genre=?, outline=?, characters_json=?, chapters_json=?, is_adult_content=?,
        quotes_style=?, view_mode=?, trim_format=?, author_name=?, blurb=?, imprint=?, dedication_from=?, dedication_to=?, expires_at=?, updated_at=?,
        bleed_mm=?, page_number_pos=?, page_number_visible=?, custom_width_mm=?, custom_height_mm=? WHERE id=? AND user_email=?`)
        .bind(String(p.title || 'Ohne Titel').slice(0, 180), String(p.genre || 'Roman').slice(0, 80), String(p.outline || '').slice(0, 6000), chars, JSON.stringify(clean), p.isAdult ? 1 : 0,
          ['french', 'swiss', 'german', 'english'].includes(p.quotesStyle) ? p.quotesStyle : 'german', p.viewMode === 'book' ? 'book' : 'manuscript', TRIM_IDS.includes(p.trimFormat) ? p.trimFormat : 'normseite',
          String(p.authorName || '').slice(0, 180), String(p.blurb || '').slice(0, 4000), String(p.imprint || '').slice(0, 2000), String(p.dedicationFrom || '').slice(0, 180), String(p.dedicationTo || '').slice(0, 180),
          bookExpiry(user), now, Math.max(0, Math.min(20, p.bleedMm | 0 || 3)), PAGE_POS.includes(p.pageNumberPos) ? p.pageNumberPos : 'bottom-center', p.pageNumberVisible === false ? 0 : 1, p.customWidthMm | 0 || null, p.customHeightMm | 0 || null, bookGet[1], user.email).run();
      return json({ ok: true, user, savedAt: now });
    }
    if (bookGet && request.method === 'DELETE') { await db.prepare('DELETE FROM sb_books WHERE id=? AND user_email=?').bind(bookGet[1], user.email).run(); return json({ ok: true }); }

    if (path === '/api/ledger' && request.method === 'GET') {
      const rows = (await db.prepare('SELECT action_type,description,token_amount,created_at FROM gt_token_ledger WHERE user_email=? ORDER BY created_at DESC LIMIT 400').bind(user.email).all())?.results || [];
      return json({ rows, user });
    }
    if (path === '/api/storage' && request.method === 'POST') {
      const p = await request.json(); const tier = String(p.tier || '').toUpperCase(); const plan = STORAGE[tier];
      if (!plan) return json({ error: 'Unbekanntes Paket.' }, 400);
      await debit(db, user, plan.tokens, 'STORAGE', `${plan.label} für ein Jahr`);
      const now = new Date().toISOString(); const until = new Date(Date.now() + 365 * 86400000).toISOString();
      await db.prepare(`INSERT INTO gt_ai_gallery_support (user_email,active_since,expires_at,is_active,plan_key) VALUES (?,?,?,1,?) ON CONFLICT(user_email) DO UPDATE SET active_since=excluded.active_since, expires_at=excluded.expires_at, is_active=1, plan_key=excluded.plan_key`).bind(user.email, now, until, tier.toLowerCase()).run();
      await db.prepare('UPDATE sb_books SET expires_at=? WHERE user_email=?').bind(until, user.email).run();
      user.plan = tier; user.planUntil = until; return json({ ok: true, user });
    }

    // ===== Co-Writer =====
    if (path === '/api/spell' && request.method === 'POST') {
      const text = String((await request.json()).text || '').slice(0, 15000);
      await debit(db, user, 1, 'SPELL', 'Rechtschreibprüfung');
      const res = await fetch('https://api.languagetool.org/v2/check', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ text, language: 'de-DE' }) });
      if (!res.ok) return json({ error: 'LanguageTool nicht erreichbar.', user }, 502);
      const data = await res.json(); let corrected = text;
      const matches = (data.matches || []).map(m => ({ replacements: (m.replacements || []).slice(0, 5).map(r => r.value), offset: m.offset, length: m.length }));
      for (const m of [...matches].sort((a, b) => b.offset - a.offset)) { if (!m.replacements[0]) continue; corrected = corrected.slice(0, m.offset) + m.replacements[0] + corrected.slice(m.offset + m.length); }
      return json({ corrected, user });
    }
    if (path === '/api/synonyms' && request.method === 'POST') {
      const word = String((await request.json()).word || '').trim().slice(0, 60);
      await debit(db, user, 1, 'SYNONYM', `Synonym: ${word}`);
      const res = await fetch('https://www.openthesaurus.de/synonyme/search?q=' + encodeURIComponent(word) + '&format=application/json');
      const data = await res.json().catch(() => ({}));
      const list = [...new Set((data.synsets || []).flatMap(s => (s.terms || []).map(t => t.term)))].filter(t => t.toLowerCase() !== word.toLowerCase()).slice(0, 16);
      return json({ list, user });
    }
    // Lektorat SATZWEISE: liefert Satz-Paare (orig/neu) zum einzelnen Übernehmen.
    if (path === '/api/improve' && request.method === 'POST') {
      const p = await request.json(); const text = String(p.text || '').slice(0, 6000);
      if (!text.trim()) return json({ error: 'Kein Text.' }, 400);
      let model = textModelById(p.modelId) || textModelById(DEFAULT_TEXT_MODEL);
      model = await resolveTextFallback(env, model);
      model = await effectiveModel(env, 'text', model);
      await debit(db, user, Math.max(1, model.tokens | 0), 'IMPROVE', 'Lektorat (' + model.name + ')');
      const improved = await aiGenerate(db, env, model, false, 'Du bist deutscher Lektor. Formuliere klarer und flüssiger, OHNE Sinn, Tempus oder Reihenfolge zu ändern. Behalte die Satzanzahl möglichst exakt bei. Gib NUR den überarbeiteten Text zurück.', text, 2600, 'improve');
      const o = splitSentences(text), n = splitSentences(improved);
      let pairs;
      if (n.length === o.length && o.length > 1) pairs = o.map((s, i) => ({ orig: s, neu: n[i] }));
      else pairs = [{ orig: text, neu: improved }];
      return json({ pairs, user });
    }
    if (path === '/api/continue' && request.method === 'POST') {
      const p = await request.json();
      const pages = p.pages === 'max' ? 'max' : Math.max(1, Math.min(40, p.pages | 0 || 1));
      let model = textModelById(p.modelId) || textModelById(DEFAULT_TEXT_MODEL); const adult = !!p.isAdult;
      if (adult && !model.uncensored) model = textModelById(DEFAULT_UNCENSORED);
      model = await resolveTextFallback(env, model);
      model = await effectiveModel(env, 'text', model);
      const soFar = String(p.text || '').slice(-8000);
      if (!soFar.trim()) return json({ error: 'Es gibt noch keinen Text.' }, 400);
      await debit(db, user, textCost(model, pages), 'CONTINUE', `Weiterschreiben (${pages === 'max' ? 'max' : pages} Seiten · ${model.name})`);
      const sys = adult ? 'Du bist Ghostwriter. Literarisch hart und explizit erlaubt. Keine Zensur, kein Meta-Kommentar.' : 'Du bist Ghostwriter für deutschsprachige Literatur. Kein Meta-Kommentar.';
      const lenHint = pages === 'max' ? 'Schreibe so viel zusammenhängenden, hochwertigen Text wie möglich (volles Output-Fenster ausnutzen).' : `Schreibe GENAU ${pages} Normseite(n) (je ca. 1500 Zeichen).`;
      const out = await aiGenerate(db, env, model, adult, sys, `Bisheriger Text:\n"""${soFar}"""\n\nSchreibe direkt weiter. ${lenHint} Gleicher Stil.`, pages === 'max' ? 32000 : pages * 2200, 'continue');
      return json({ continuation: out, user });
    }
    // ===== Autopilot =====
    if (path === '/api/autopilot' && request.method === 'POST') {
      const p = await request.json();
      const pages = p.pages === 'max' ? 'max' : Math.max(1, Math.min(20, p.pages | 0 || 5));
      let model = textModelById(p.modelId) || textModelById('grok-4-3'); const adult = !!p.isAdult;
      if (adult && !model.uncensored) model = textModelById(DEFAULT_UNCENSORED);
      model = await resolveTextFallback(env, model);
      model = await effectiveModel(env, 'text', model);
      const title = String(p.title || '').slice(0, 180); const genre = String(p.genre || 'Roman').slice(0, 80);
      const outline = String(p.outline || '').slice(0, 4000); const chapterGoal = String(p.chapterGoal || '').slice(0, 2000); const prev = String(p.previousContext || '').slice(-4000);
      const chars = Array.isArray(p.characters) ? p.characters.slice(0, 40) : [];
      const bible = chars.map(c => `- ${String(c.name || '').slice(0, 120)}${c.role ? ' (' + String(c.role).slice(0, 120) + ')' : ''}: ${String(c.traits || '').slice(0, 600)}`).join('\n');
      await debit(db, user, textCost(model, pages), 'AUTOPILOT', `Autopilot-Kapitel (${pages === 'max' ? 'max' : pages} Seiten · ${model.name})`);
      const sys = adult ? 'Du bist Romanautor. Literarisch hart und explizit erlaubt. Keine Zensur, kein Meta-Kommentar, keine Überschrift.' : 'Du bist professioneller deutschsprachiger Romanautor. Kein Meta-Kommentar.';
      const lenHint = pages === 'max' ? 'Schreibe ein möglichst vollständiges, langes Kapitel (volles Output-Fenster ausnutzen).' : `Schreibe ein Kapitel von GENAU ${pages} Normseite(n) (je ca. 1500 Zeichen).`;
      const promptParts = [`Buchtitel: ${title || '(ohne)'}`, `Genre: ${genre}`, bible ? `Figuren-Bibel:\n${bible}` : '', outline ? `Gesamt-Outline:\n${outline}` : '', prev ? `Was bisher geschah (Ausschnitt):\n"""${prev}"""` : '', chapterGoal ? `Ziel dieses Kapitels:\n${chapterGoal}` : '', `${lenHint} Deutsch, konsistenter Stil, direkt als Fließtext. Keine Überschrift, keine Erklärungen.`].filter(Boolean);
      const out = await aiGenerate(db, env, model, adult, sys, promptParts.join('\n\n'), pages === 'max' ? 32000 : pages * 2200, 'autopilot');
      return json({ chapter: out, user });
    }
    if (path === '/api/image' && request.method === 'POST') {
      const p = await request.json(); let model = imageModelById(p.modelId) || IMAGE_MODELS[0];
      await assertProviderActive(env, model.provider);
      model = await effectiveModel(env, 'image', model);
      const prompt = String(p.prompt || '').trim().slice(0, 1200);
      if (!prompt) return json({ error: 'Bitte einen Bildprompt.' }, 400);
      const cost = Math.max(model.tokens | 0, imageCost(model));
      await debit(db, user, cost, 'IMAGE', model.name);
      const imgRes = await makeImage(env, model, prompt, !!p.isAdult);
      await logApiCost(db, model.provider, model.id, model.name, 'image', imgRes.realUsd ?? model.usd ?? null, cost);
      return json({ url: imgRes.url, user });
    }

    // ===== Admin =====
    if (path === '/api/admin' && request.method === 'GET') {
      if (user.role !== 'admin') return json({ error: 'Kein Admin.' }, 403);
      const wallets = (await db.prepare('SELECT user_email, token_balance, role FROM user_tokens ORDER BY token_balance DESC LIMIT 200').all())?.results || [];
      const books = await db.prepare('SELECT COUNT(*) AS n FROM sb_books').first();
      const since = new Date(Date.now() - 24 * 3600000).toISOString();
      const raw = (await db.prepare('SELECT provider,model_name,action,real_cost_usd,tokens_charged FROM gt_api_cost_log WHERE created_at>=?').bind(since).all())?.results || [];
      const grouped = {};
      for (const r of raw) { const k = r.provider + '|' + r.model_name + '|' + r.action; if (!grouped[k]) grouped[k] = { provider: r.provider, model_name: r.model_name, action: r.action, calls: 0, usd: 0, costTokens: 0, income: 0, hasCost: false }; const g = grouped[k]; g.calls++; g.income += r.tokens_charged || 0; if (r.real_cost_usd != null) { g.hasCost = true; g.usd += Number(r.real_cost_usd); g.costTokens += Math.max(1, Math.ceil(Number(r.real_cost_usd) / TOKEN_COST_USD)); } }
      const cost24 = Object.values(grouped).map(g => ({ ...g, usd: +g.usd.toFixed(4), margin: g.hasCost ? g.income - g.costTokens : null, pct: g.hasCost && g.costTokens ? Math.round((g.income - g.costTokens) / g.income * 100) : null })).sort((a, b) => b.usd - a.usd);
      const overrides = {}; (await centralDb(env).prepare('SELECT model_key,token_cost,is_active FROM central_model_prices').all())?.results?.forEach(r => overrides[r.model_key] = r);
      const central = [
        ...TEXT_MODELS.map(m => ({ kind: 'text', id: m.id, name: m.name, provider: m.provider, uncensored: !!m.uncensored, tokens: overrides['text|' + m.id]?.token_cost ?? m.tokens, active: overrides['text|' + m.id] ? Number(overrides['text|' + m.id].is_active) === 1 : true, floor: minTokensForMargin(textRealUsdPerPage(m)) })),
        ...IMAGE_MODELS.map(m => ({ kind: 'image', id: m.id, name: m.name, provider: m.provider, tokens: overrides['image|' + m.id]?.token_cost ?? m.tokens, active: overrides['image|' + m.id] ? Number(overrides['image|' + m.id].is_active) === 1 : true, floor: minTokensForMargin(m.usd || 0) })),
      ];
      const storageEcon = Object.keys(STORAGE).map(k => { const s = STORAGE[k]; const costUsd = s.gb * R2_PRICE_PER_GB_MONTH * 12; const costTokens = Math.ceil(costUsd / TOKEN_COST_USD); const margin = s.tokens - costTokens; return { key: k, label: s.label, gb: s.gb, tokens: s.tokens, costUsd: +costUsd.toFixed(3), costTokens, margin, pct: s.tokens ? Math.round(margin / s.tokens * 100) : 0 }; });
      const provRows = (await db.prepare('SELECT provider,is_active FROM sb_provider_switches').all())?.results || [];
      const provMap = {}; provRows.forEach(r => provMap[r.provider] = Number(r.is_active) === 1);
      const providers = IMAGE_PROVIDERS.map(pv => ({ provider: pv, active: provMap[pv] !== false }));
      const supportMsgs = (await db.prepare('SELECT s.user_email, s.sender, s.message, s.created_at, s.read_by_admin FROM sb_messages s ORDER BY s.created_at DESC LIMIT 100').all())?.results || [];
      const feedbackMsgs = (await db.prepare('SELECT id, name, email, message, created_at FROM sb_feedback ORDER BY created_at DESC LIMIT 100').all())?.results || [];
      // Support-Nachrichten als gelesen markieren, sobald Admin das Dashboard öffnet.
      await db.prepare('UPDATE sb_messages SET read_by_admin=1 WHERE sender=? AND read_by_admin=0').bind('user').run();
      return json({ wallets, bookCount: books?.n | 0, cost24, central, storageEcon, providers, supportMsgs, feedbackMsgs, central_db: !!env.VOUCHERS_DB, user });
    }
    if (path === '/api/admin/venice-prices' && request.method === 'GET') {
      if (user.role !== 'admin') return json({ error: 'Kein Admin.' }, 403);
      if (!env.VENICE_API_KEY) return json({ error: 'VENICE_API_KEY fehlt.' }, 503);
      const want = new Set([...TEXT_MODELS, ...IMAGE_MODELS].filter(m => m.provider === 'Venice').map(m => m.model));
      const out = [];
      for (const t of ['text', 'image']) { const res = await fetch('https://api.venice.ai/api/v1/models?type=' + t, { headers: { authorization: 'Bearer ' + env.VENICE_API_KEY } }); const j = await res.json().catch(() => ({})); (j.data || []).forEach(m => { if (want.has(m.id)) out.push({ id: m.id, type: t, pricing: m.model_spec?.pricing || m.pricing || null }); }); }
      return json({ models: out, user });
    }
    if (path === '/api/admin/model-price' && request.method === 'POST') {
      if (user.role !== 'admin') return json({ error: 'Kein Admin.' }, 403);
      const p = await request.json(); const kind = p.kind === 'image' ? 'image' : 'text';
      const m = kind === 'image' ? imageModelById(p.id) : textModelById(p.id);
      if (!m) return json({ error: 'Unbekanntes Modell.' }, 400);
      const floor = kind === 'image' ? minTokensForMargin(m.usd || 0) : minTokensForMargin(textRealUsdPerPage(m));
      let tokenCost = Math.max(1, Math.min(100000, p.tokenCost | 0 || m.tokens));
      if (tokenCost < floor) return json({ error: `Preis zu niedrig – mindestens ${floor} Tokens nötig (50 %-Marge).` }, 400);
      const active = p.active === false ? 0 : 1;
      await centralDb(env).prepare(`INSERT INTO central_model_prices (model_key,display_name,provider,token_cost,is_active,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(model_key) DO UPDATE SET token_cost=excluded.token_cost, is_active=excluded.is_active, updated_at=excluded.updated_at`).bind(kind + '|' + m.id, m.name, m.provider, tokenCost, active, new Date().toISOString()).run();
      return json({ ok: true, user });
    }
    if (path === '/api/admin/provider-switch' && request.method === 'POST') {
      if (user.role !== 'admin') return json({ error: 'Kein Admin.' }, 403);
      const p = await request.json(); const provider = String(p.provider || '');
      if (!IMAGE_PROVIDERS.includes(provider)) return json({ error: 'Unbekannter Anbieter.' }, 400);
      const active = p.active ? 1 : 0;
      await db.prepare('INSERT INTO sb_provider_switches (provider,is_active,updated_at) VALUES (?,?,?) ON CONFLICT(provider) DO UPDATE SET is_active=excluded.is_active, updated_at=excluded.updated_at').bind(provider, active, new Date().toISOString()).run();
      return json({ ok: true, user });
    }
    if (path === '/api/admin/reply' && request.method === 'POST') {
      if (user.role !== 'admin') return json({ error: 'Kein Admin.' }, 403);
      const p = await request.json(); const target = cleanEmail(p.email); const msg = String(p.message || '').trim().slice(0, 4000);
      if (!isValidEmail(target) || !msg) return json({ error: 'E-Mail und Nachricht nötig.' }, 400);
      await db.prepare('INSERT INTO sb_messages (id,user_email,sender,message,created_at,read_by_admin) VALUES (?,?,?,?,?,1)').bind(crypto.randomUUID(), target, 'admin', msg, new Date().toISOString()).run();
      await sendResend(env, target, 'Antwort vom Schreibblockade-Support', '<div style="font-family:Arial;background:#121216;color:#e0e0e0;padding:24px"><h2 style="color:#4ade80">Antwort vom Support</h2><p style="white-space:pre-wrap">' + escHtml(msg) + '</p></div>');
      return json({ ok: true, user });
    }

    if (path === '/api/admin/feedback-delete' && request.method === 'POST') {
      if (user.role !== 'admin') return json({ error: 'Kein Admin.' }, 403);
      const id = String((await request.json()).id || '');
      await db.prepare('DELETE FROM sb_feedback WHERE id=?').bind(id).run();
      return json({ ok: true, user });
    }
    if (path === '/api/admin/adjust' && request.method === 'POST') {
      if (user.role !== 'admin') return json({ error: 'Kein Admin.' }, 403);
      const p = await request.json(); const target = cleanEmail(p.email); const delta = p.delta | 0;
      const t = await db.prepare('SELECT token_balance FROM user_tokens WHERE user_email=?').bind(target).first();
      if (!t) return json({ error: 'User nicht gefunden.' }, 404);
      const nb = Math.max(0, (t.token_balance | 0) + delta);
      await db.prepare('UPDATE user_tokens SET token_balance=? WHERE user_email=?').bind(nb, target).run();
      if (delta) await logTx(db, target, 'ADMIN_ADJUST', 'Admin-Anpassung', delta);
      return json({ ok: true, user });
    }
    return json({ error: 'Nicht gefunden.' }, 404);
  } catch (e) { return json({ error: e.message || 'Fehler' }, e.status || 500); }
}

// Entfernt sensible Felder (Passwort-Hash/Salt) aus dem User-Objekt, bevor es an den Client geht.
function publicUser(u) { if (!u) return null; return { email: u.email, tokens: u.tokens, role: u.role, vorname: u.vorname || '', nachname: u.nachname || '', plan: u.plan, planUntil: u.planUntil }; }
function publicTextModels() { return TEXT_MODELS.map(m => ({ id: m.id, name: m.name, tokens: Math.max(1, m.tokens | 0), uncensored: !!m.uncensored, vision: !!m.vision, tier: m.tier || 'budget', desc: m.desc || '', provider: m.provider })); }
function publicImageModels() { return IMAGE_MODELS.map(m => ({ id: m.id, name: m.name, tokens: Math.max(m.tokens, minTokensForMargin(m.usd || 0)) })); }

function serializeBook(b) {
  let pages = []; try { pages = JSON.parse(b.chapters_json || '[]'); } catch (e) { pages = []; }
  if (!pages.length) pages = [{ id: crypto.randomUUID(), body: '', imageUrl: '', imagePrompt: '' }];
  let characters = []; try { characters = JSON.parse(b.characters_json || '[]'); } catch (e) { characters = []; }
  return { id: b.id, title: b.title, genre: b.genre || 'Roman', outline: b.outline || '', characters, isAdult: !!b.is_adult_content, quotesStyle: b.quotes_style || 'german', viewMode: b.view_mode || 'manuscript', trimFormat: TRIM_IDS.includes(b.trim_format) ? b.trim_format : 'normseite', bleedMm: b.bleed_mm | 0 || 3, pageNumberPos: PAGE_POS.includes(b.page_number_pos) ? b.page_number_pos : 'bottom-center', pageNumberVisible: b.page_number_visible !== 0, customWidthMm: b.custom_width_mm | 0 || 148, customHeightMm: b.custom_height_mm | 0 || 210, authorName: b.author_name || '', blurb: b.blurb || '', imprint: b.imprint || '', dedicationFrom: b.dedication_from || '', dedicationTo: b.dedication_to || '', pages };
}
async function setSession(db, env, email) {
  const raw = crypto.randomUUID() + crypto.randomUUID(); const exp = Date.now() + 30 * 86400000;
  await db.prepare('INSERT INTO sessions (token_hash,user_email,expires_at) VALUES (?,?,?)').bind(await sha(raw), email, exp).run();
  const u = await db.prepare('SELECT token_balance, role FROM user_tokens WHERE user_email=?').bind(email).first();
  return new Response(JSON.stringify({ ok: true, user: { email, tokens: u?.token_balance | 0, role: isAdminEmail(env, email) ? 'admin' : (u?.role || 'user'), plan: 'none', planUntil: null } }), { headers: { 'content-type': 'application/json', 'set-cookie': sessionCookie(raw, 30 * 86400) } });
}
async function sendResend(env, to, subject, html) {
  if (!env.RESEND_API_KEY) return false;
  try {
    const res = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { authorization: 'Bearer ' + env.RESEND_API_KEY, 'content-type': 'application/json' }, body: JSON.stringify({ from: RESEND_FROM, to: [to], subject, html }) });
    return res.ok;
  } catch (e) { return false; }
}

async function aiGenerate(db, env, model, isAdult, system, content, maxTokens, action) {
  const isGoogle = model.provider === 'Google';
  let out, usedFallback = false;
  try {
    if (isGoogle) {
      // Direkter Gemini-Aufruf – greift, wenn der gewählte Anbieter im Admin pausiert ist und ein Google-Fallback aktiv ist.
      const key = env.GEMINI_API_KEY_2 || env.GEMINI_API_KEY;
      if (!key) throw new Error('GEMINI_API_KEY fehlt.');
      const gModel = String(model.model || env.STORY_GEMINI_MODEL || 'gemini-3.6-flash').replace(/^models\//, '');
      const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(gModel) + ':generateContent', { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify({ contents: [{ parts: [{ text: system + '\n\n' + content }] }], generationConfig: { maxOutputTokens: Math.min(32768, maxTokens || 4000), temperature: 0.95, topP: 0.97 } }) });
      const j = await res.json().catch(() => ({})); if (!res.ok) throw new Error(j?.error?.message || 'Gemini-Fehler');
      out = j?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('\n').trim();
      if (!out) throw new Error('Gemini hat keinen Text zurückgegeben.');
    } else {
      // Alle übrigen Modelle (inkl. Grok) laufen über den Venice-API-Key.
      if (!env.VENICE_API_KEY) throw new Error('VENICE_API_KEY fehlt.');
      const res = await fetch('https://api.venice.ai/api/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + env.VENICE_API_KEY }, body: JSON.stringify({ model: model.model, messages: [{ role: 'system', content: system }, { role: 'user', content }], temperature: 0.95, max_completion_tokens: Math.min(32768, maxTokens || 4000), venice_parameters: { include_venice_system_prompt: false } }) });
      const j = await res.json().catch(() => ({})); if (!res.ok) throw new Error((typeof j.error === 'string' ? j.error : j.error?.message) || 'Venice-Fehler'); out = j.choices?.[0]?.message?.content?.trim();
    }
    if (!out) throw new Error('Die KI hat keinen Text zurückgegeben.');
  } catch (primaryError) {
    if (isGoogle) throw primaryError; // Direkter Fallback: kein weiterer Gemini-Versuch nötig.
    const key = env.GEMINI_API_KEY_2 || env.GEMINI_API_KEY;
    const fallbackOff = env.GOOGLE_TEXT_FALLBACK_OFF === '1';
    if (!key || fallbackOff) throw primaryError;
    try {
      const gModel = String(env.STORY_GEMINI_MODEL || 'gemini-3.6-flash').replace(/^models\//, '');
      const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(gModel) + ':generateContent', { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify({ contents: [{ parts: [{ text: system + '\n\n' + content }] }], generationConfig: { maxOutputTokens: Math.min(32768, maxTokens || 4000), temperature: 0.95, topP: 0.97 } }) });
      const j = await res.json().catch(() => ({})); if (!res.ok) throw new Error(j?.error?.message || 'Gemini-Fehler');
      out = j?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('\n').trim();
      if (!out) throw new Error('Gemini hat keinen Text zurückgegeben.');
      usedFallback = true;
    } catch (fallbackError) {
      throw primaryError;
    }
  }
  const inTok = Math.ceil((system.length + content.length) / 4), outTok = Math.ceil(out.length / 4);
  const realUsd = (model.inUsd || 0) / 1e6 * inTok + (model.outUsd || 0) / 1e6 * outTok;
  const fallbackActive = usedFallback || isGoogle;
  await logApiCost(db, fallbackActive ? 'Google (Fallback)' : model.provider, model.id, model.name + (fallbackActive ? ' → Gemini-Notfall' : ''), action || 'text', realUsd, null);
  return out;
}

// Lädt eine entfernte Bild-URL herunter und wandelt sie in data:-Base64 (dauerhaft, da
// Runware/Fal.ai-URLs ablaufen). Begrenzt auf 15 MB, prüft den Content-Type.
async function urlToDataUri(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('Ergebnisbild nicht ladbar.');
  const type = (res.headers.get('content-type') || 'image/png').split(';')[0];
  if (!type.startsWith('image/')) throw new Error('Kein gültiges Bildformat.');
  const buf = await res.arrayBuffer();
  if (buf.byteLength > 15 * 1024 * 1024) throw new Error('Bild zu groß.');
  return 'data:' + type + ';base64,' + arrayBufferToBase64(buf);
}

async function makeImage(env, model, prompt, isAdult) {
  const p = (isAdult ? 'Literary cinematic illustration, tasteful. ' : 'Literary cinematic illustration. ') + prompt;

  if (model.provider === 'Venice') {
    if (!env.VENICE_API_KEY) throw Object.assign(new Error('VENICE_API_KEY fehlt.'), { status: 503 });
    const body = { model: model.model, prompt: p, format: 'png', return_binary: false };
    if (model.sizing === 'pixel') { body.width = 832; body.height = 1216; }
    else if (model.sizing === 'aspect') { body.aspect_ratio = '2:3'; }
    const res = await fetch('https://api.venice.ai/api/v1/image/generate', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + env.VENICE_API_KEY }, body: JSON.stringify(body) });
    const type = (res.headers.get('content-type') || '').toLowerCase();
    if (res.ok && type.startsWith('image/')) return { url: 'data:' + type.split(';')[0] + ';base64,' + arrayBufferToBase64(await res.arrayBuffer()), realUsd: model.usd || null };
    const j = await res.json().catch(() => ({})); if (!res.ok) throw new Error(j.error?.message || j.error || 'Bildfehler'); const b64 = j.images?.[0]; if (!b64) throw new Error('Kein Bild.'); return { url: 'data:image/png;base64,' + b64, realUsd: model.usd || null };
  }

  if (model.provider === 'Runware') {
    if (!env.RUNWARE_API_KEY) throw Object.assign(new Error('RUNWARE_API_KEY fehlt.'), { status: 503 });
    const taskUUID = crypto.randomUUID();
    const res = await fetch('https://api.runware.ai/v1', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + env.RUNWARE_API_KEY }, body: JSON.stringify([{ taskType: 'imageInference', taskUUID, positivePrompt: p, model: model.model, width: 832, height: 1216, numberResults: 1, includeCost: true }]) });
    const j = await res.json().catch(() => ({}));
    const r = j?.data?.find(d => d.taskUUID === taskUUID) || j?.data?.[0];
    if (!r?.imageURL) throw new Error(j?.errors?.[0]?.message || 'Runware-Fehler');
    return { url: await urlToDataUri(r.imageURL), realUsd: typeof r.cost === 'number' ? r.cost : (model.usd || null) };
  }

  if (model.provider === 'Fal.ai') {
    if (!env.FAL_KEY) throw Object.assign(new Error('FAL_KEY fehlt.'), { status: 503 });
    const res = await fetch('https://fal.run/' + model.model, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Key ' + env.FAL_KEY }, body: JSON.stringify({ prompt: p, image_size: 'portrait_4_3', num_images: 1 }) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j?.detail || j?.error || 'Fal.ai-Fehler');
    const u = j?.images?.[0]?.url || j?.image?.url;
    if (!u) throw new Error('Kein Bild.');
    return { url: await urlToDataUri(u), realUsd: model.usd || null };
  }

  throw new Error('Unbekannter Bild-Anbieter.');
}

async function handleDigistore(request, env, url) {
  const db = env.DB; const passphrase = String(env.DIGISTORE24_IPN_PASSWORD || '');
  if (!passphrase) return new Response('Digistore24 nicht konfiguriert.', { status: 503 });
  const params = Object.fromEntries(url.searchParams.entries());
  if (request.method === 'POST') { const type = request.headers.get('content-type') || ''; if (type.includes('application/x-www-form-urlencoded') || type.includes('multipart/form-data')) { const form = await request.formData(); for (const [k, v] of form.entries()) params[k] = String(v); } }
  if (params.event === 'connection_test') return new Response('OK', { status: 200 });
  const keys = Object.keys(params).filter(k => k.toLowerCase() !== 'sha_sign' && k.toLowerCase() !== '__sha_sign__').sort();
  let value = ''; for (const key of keys) { const pr = params[key]; if (pr === '' || pr === false || pr == null) continue; value += `${key}=${pr}${passphrase}`; }
  const expected = arrayBufferToHex(await crypto.subtle.digest('SHA-512', te.encode(value))).toUpperCase();
  const received = params.sha_sign || params.__sha_sign__;
  const urlSecretValid = constantTimeEqual(url.searchParams.get('key'), passphrase);
  const signatureValid = received && constantTimeEqual(String(received).toUpperCase(), expected);
  if (!signatureValid && !urlSecretValid) return new Response('Ungültige Signatur.', { status: 403 });
  const productId = String(params.product_id || '').trim(); const tokenAmount = DIGISTORE24_TOKEN_PACKAGES[productId];
  if (!tokenAmount) return new Response('Unbekanntes Produkt.', { status: 400 });
  const orderId = String(params.order_id || '').trim(); const orderKey = String(params.order_item_id || orderId).trim(); const buyerEmail = cleanEmail(params.buyer_email || params.email || '');
  if (!orderId || !orderKey || !buyerEmail) return new Response('Unvollständige Daten.', { status: 400 });
  const inserted = await db.prepare(`INSERT OR IGNORE INTO gt_digistore24_token_orders (order_key,order_id,buyer_email,product_id,tokens,status,created_at) VALUES (?,?,?,?,?,'received',?)`).bind(orderKey, orderId, buyerEmail, productId, tokenAmount, new Date().toISOString()).run();
  if (!inserted.meta.changes) return new Response('Bereits verarbeitet.', { status: 200 });
  const account = await db.prepare('SELECT user_email FROM user_tokens WHERE user_email=?').bind(buyerEmail).first();
  if (!account && /@test-ds24\.com$/i.test(buyerEmail)) { await db.prepare("UPDATE gt_digistore24_token_orders SET status='test_order', processed_at=? WHERE order_key=?").bind(new Date().toISOString(), orderKey).run(); return new Response('OK', { status: 200 }); }
  if (!account) { await db.prepare("UPDATE gt_digistore24_token_orders SET status='waiting_for_account', note=? WHERE order_key=?").bind('Kein Konto mit dieser E-Mail.', orderKey).run(); return new Response('Käufer nicht registriert.', { status: 422 }); }
  await db.batch([
    db.prepare('UPDATE user_tokens SET token_balance = token_balance + ? WHERE user_email=?').bind(tokenAmount, buyerEmail),
    db.prepare("UPDATE gt_digistore24_token_orders SET status='credited', processed_at=? WHERE order_key=?").bind(new Date().toISOString(), orderKey),
    db.prepare('INSERT INTO gt_token_ledger (id,user_email,action_type,description,token_amount,created_at) VALUES (?,?,?,?,?,?)').bind(crypto.randomUUID(), buyerEmail, 'DIGISTORE24', `Digistore24 ${orderId}: +${tokenAmount} Tokens`, tokenAmount, new Date().toISOString()),
  ]);
  return new Response('OK', { status: 200 });
}

// Öffentliche Lese-/Download-Seite für ein per Mail geteiltes Manuskript (kein Login).
// Link ist exakt 7 Tage gültig. Beim Aufruf wird beiläufig Abgelaufenes aufgeräumt (R2 + DB).
async function handleShareRead(request, env, url) {
  const token = url.pathname.replace(/^\/m\//, '').replace(/[^a-f0-9]/gi, '');
  if (!token) return new Response('Nicht gefunden.', { status: 404 });
  const db = env.DB;
  // Sanfte Bereinigung abgelaufener Shares, max. 20 pro Aufruf.
  try {
    const old = (await db.prepare('SELECT token, r2_key FROM sb_shares WHERE expires_at < ? LIMIT 20').bind(new Date().toISOString()).all())?.results || [];
    for (const o of old) { if (env.BUCKET) { try { await env.BUCKET.delete(o.r2_key); } catch (e) {} } await db.prepare('DELETE FROM sb_shares WHERE token=?').bind(o.token).run(); }
  } catch (e) {}
  const s = await db.prepare('SELECT * FROM sb_shares WHERE token=?').bind(token).first();
  if (!s) return new Response('Dieser Link ist ungültig.', { status: 404 });
  if (String(s.expires_at || '') < new Date().toISOString()) return new Response('Dieser Link ist abgelaufen.', { status: 410 });
  // Direkter PDF-Download: /m/<token>?dl=1
  if (url.searchParams.get('dl') === '1') {
    if (!env.BUCKET) return new Response('Speicher nicht verfügbar.', { status: 503 });
    const obj = await env.BUCKET.get(s.r2_key);
    if (!obj) return new Response('Datei nicht mehr vorhanden.', { status: 404 });
    return new Response(obj.body, { headers: { 'content-type': 'application/pdf', 'content-disposition': 'inline; filename="manuskript.pdf"', 'cache-control': 'private, no-store' } });
  }
  // Lese-Seite mit Einbettung + Download-Button.
  const title = escHtml(s.title || 'Manuskript');
  const page = '<!DOCTYPE html><html lang="de"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>' + title + '</title><style>body{margin:0;background:#121216;color:#e0e0e0;font:16px/1.5 Arial,sans-serif}header{padding:18px 24px;border-bottom:1px solid #2a2a35;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px}h1{font-size:20px;margin:0;color:#fff}a.dl{background:#ff4b4f;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;font-weight:bold}iframe{width:100%;height:calc(100vh - 70px);border:0;background:#333}.exp{color:#9999a2;font-size:13px;padding:8px 24px}</style></head><body><header><h1>📖 ' + title + '</h1><a class="dl" href="/m/' + token + '?dl=1" download="manuskript.pdf">⬇️ Als PDF speichern</a></header><iframe src="/m/' + token + '?dl=1"></iframe><div class="exp">Dieser Link ist 7 Tage ab Versand gültig. Geteilt über Schreibblockade.</div></body></html>';
  return new Response(page, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

const APP_HTML = `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"/>
<meta name="theme-color" content="#121216"/>
<meta name="apple-mobile-web-app-capable" content="yes"/>
<meta name="apple-mobile-web-app-title" content="Schreibblockade"/>
<link rel="manifest" href="/manifest.json"/>
<link rel="icon" href="/icon.svg"/>
<title>Schreibblockade</title>
<style>
:root{color-scheme:dark;--red:#ff4b4f;--bg-main:#121216;--bg-sidebar:#18181f;--bg-box:#18181f;--bg-textarea:#1a1a22;--border-color:#2a2a35;--accent-red:#ff4b4f;--text-main:#e0e0e0;--text-muted:#9999a2}
*{box-sizing:border-box}
body{margin:0;background:var(--bg-main);color:var(--text-main);font:16px/1.5 Arial,sans-serif;min-height:100vh}
.app-container{display:flex;min-height:100vh}
.sidebar{width:340px;background:var(--bg-sidebar);border-right:1px solid var(--border-color);padding:25px;display:flex;flex-direction:column;position:sticky;top:0;height:100vh;overflow-y:auto;flex-shrink:0}
.sidebar-bottom{margin-top:auto;padding-top:15px;border-top:1px solid var(--border-color)}
.main{flex:1;padding:40px 60px;min-width:0}
.logo-sq{width:100%;aspect-ratio:1/1;background:#121216;border-radius:8px;border:1px solid var(--border-color);overflow:hidden;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:16px}
.logo-sq .sk{font-size:72px;line-height:1}.logo-sq strong{color:#fff;letter-spacing:2px;font-size:15px;margin-top:12px}.logo-sq span{color:#ff4b4f;font-size:12px;margin-top:6px}
.box{background:var(--bg-box);padding:28px;border-radius:10px;border:1px solid var(--border-color);margin-bottom:24px}
label{display:block;margin:10px 0 6px;font-weight:bold}
input[type=email],input[type=password],input[type=text],input[type=number],select,textarea{width:100%;background:var(--bg-textarea);color:#fff;border:1px solid var(--border-color);padding:12px;border-radius:6px;font:inherit;margin-bottom:12px}
button{background:var(--accent-red);color:#fff;border:none;padding:12px 18px;border-radius:6px;font-weight:bold;cursor:pointer;width:100%}
button:hover{background:#e03e3e}button.ghost{background:transparent;border:1px solid var(--border-color);color:var(--text-main)}button.sm{width:auto;padding:10px 14px}
a.btnlink{display:inline-block;background:#13381e;color:#4ade80;border:1px solid #4ade80;padding:10px 14px;border-radius:6px;text-decoration:none;font-weight:bold}
h1{font-size:28px;margin:0 0 8px;color:#fff;display:flex;align-items:center;gap:12px;flex-wrap:wrap}h2{font-size:22px;margin:0 0 15px;color:#fff}h3{font-size:16px;color:#fff;margin:15px 0 8px}
.tabs{display:flex;gap:18px;margin:30px 0 28px;border-bottom:1px solid var(--border-color);padding-bottom:15px;flex-wrap:wrap}
.tab-link{color:var(--text-muted);text-decoration:none;font-size:16px;font-weight:500;padding:4px 2px;background:none;border:none;width:auto}
.tab-link.active{color:var(--text-main);border-bottom:2px solid var(--accent-red);padding-bottom:13px;border-radius:0;background:none}
.alert-error{background:#3f1515;color:#f87171;padding:12px 16px;border-radius:8px;margin-bottom:16px;border:1px solid #5c2020}
.alert-ok{background:#13381e;color:#4ade80;padding:12px 16px;border-radius:8px;margin-bottom:16px}
.muted{color:var(--text-muted);font-size:14px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px}
.card{background:var(--bg-box);border:1px solid var(--border-color);border-radius:10px;padding:18px;color:inherit;text-decoration:none;display:block;min-height:140px}
.card strong{display:block;color:var(--text-main);font-size:17px;margin:8px 0}.more{display:block;color:#ff6670;margin-top:12px;font-weight:bold;font-size:13px}
.beta{font-size:12px;background:#2a1215;color:#ff4b4b;border:1px solid #ff4b4b;padding:2px 8px;border-radius:4px;font-weight:600;letter-spacing:1px}
.skull{width:40px;height:40px;background:#18181f;border-radius:8px;border:1px solid var(--border-color);display:inline-flex;align-items:center;justify-content:center;font-size:24px}
.toprow{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:15px}
.homebtn{width:auto;background:#18181f;border:1px solid var(--border-color);padding:8px 14px}
.hp{position:absolute;left:-10000px;top:auto;width:1px;height:1px;overflow:hidden}
.sheet{background:#f6f0e4;color:#1a1612;box-shadow:0 18px 50px #0008;margin:0 auto;padding:20px 24px 16px;width:calc(60ch + 48px);max-width:100%;border-radius:2px;box-sizing:border-box;overflow:hidden}
.sheet textarea,.sheet .bodytxt{background:transparent;color:#1a1612;border:0;resize:none;outline:none;font-family:"Courier New",Courier,monospace;font-size:12pt;line-height:1.5;width:60ch;max-width:100%;height:calc(30 * 1.5em);overflow:hidden;margin:0;padding:0;white-space:pre-wrap;word-wrap:break-word;display:block}
.sheet .foot{font:11px Arial,sans-serif;color:#5a5348;display:flex;justify-content:space-between;margin-top:8px}
.stack{display:flex;flex-direction:column;align-items:center;gap:36px;padding:8px 0 60px}
.sheet.right,.bleed.right{transform:translateX(32px)}.sheet.left,.bleed.left{transform:translateX(-32px)}
.bookview{font-family:Georgia,"Times New Roman",serif}
.jumprow{position:sticky;top:0;z-index:6;background:#121216;padding:10px 0;display:flex;gap:8px;align-items:center;flex-wrap:wrap}.jumprow input{width:72px;margin:0}.jumprow button{width:auto}
.ed{display:grid;gap:16px}@media(min-width:1100px){.ed{grid-template-columns:1fr 330px}}
.tools{background:var(--bg-box);border:1px solid var(--border-color);border-radius:10px;padding:16px}
.pending{border:1px solid #ff4b4f;background:#1b1216;padding:12px;border-radius:8px;margin:12px 0}
.sent{display:block;border:1px solid var(--border-color);border-radius:6px;padding:8px;margin-bottom:6px;cursor:pointer}
.sent.on{border-color:#4ade80;background:#13381e}
.sent .o{color:#f87171;text-decoration:line-through;font-size:13px}.sent .n{color:#4ade80;font-size:13px;margin-top:3px}
.adult-flag{background:#3f1515;color:#f87171;border:1px solid #ff4b4b;padding:8px 12px;border-radius:8px;font-size:13px;margin:8px 0}
.imgbox{margin-top:14px;border:1px solid var(--border-color);border-radius:8px;padding:12px}
.charrow{display:flex;gap:8px;margin-bottom:8px;flex-wrap:wrap}.charrow input{margin:0;flex:1;min-width:120px}
.tbl{width:100%;border-collapse:collapse;font-size:13px}.tbl th,.tbl td{border-bottom:1px solid var(--border-color);padding:7px 9px;text-align:left}.tbl th{color:var(--text-muted)}
.footer-bar{margin-top:80px;border-top:1px solid var(--border-color);padding-top:20px;display:flex;justify-content:space-between;flex-wrap:wrap;gap:12px;color:var(--text-muted);font-size:13px}
.pwa{background:#18181f;border:1px solid var(--border-color);border-radius:10px;padding:12px 16px;margin-bottom:18px}.pwa.hidden{display:none}
.bleed{background:repeating-linear-gradient(-45deg,#6b2222,#6b2222 7px,#4a1616 7px,#4a1616 14px);display:inline-block;position:relative;margin:8px auto;max-width:100%}
.bleed .tag{position:absolute;top:3px;left:6px;z-index:2;background:#0009;color:#ffb4b4;font:11px/1.3 Arial;padding:3px 7px;border-radius:4px}
.trim{background:#f6f0e4;color:#1a1612;position:relative;overflow:hidden;box-sizing:border-box}
.trim textarea,.trim .bodytxt{width:100%;height:100%;min-height:0;font:12.5pt/1.55 Georgia,"Times New Roman",serif;text-align:justify;overflow:hidden;resize:none;border:0;background:transparent;white-space:pre-wrap}
.pnum{position:absolute;left:0;right:0;font:10pt Georgia,serif;color:#1a1612;pointer-events:none;padding:0 12px;box-sizing:border-box}
.pnum.top{top:5px}.pnum.bottom{bottom:5px}.pnum.left{text-align:left}.pnum.center{text-align:center}.pnum.right{text-align:right}.pnum.ghost{color:transparent}
.ovl{position:fixed;inset:0;background:#000c;z-index:50;display:flex;align-items:flex-start;justify-content:center;overflow:auto;padding:30px 12px}
.ovl .inner{background:#f6f0e4;color:#1a1612;max-width:760px;width:100%;border-radius:6px;padding:40px 48px;font:13pt/1.7 Georgia,serif}.ovl .inner h2{color:#1a1612}
.micbar{display:none}
@media(max-width:900px){.app-container{flex-direction:column}.sidebar{position:static;width:100%;height:auto}.main{padding:16px}.sheet{width:100%;padding:14px;transform:none}.sheet textarea,.sheet .bodytxt{width:100%}.micbar{display:flex;position:sticky;bottom:0;z-index:20;gap:8px;background:#121216;padding:10px 0;border-top:1px solid var(--border-color)}.micbar button{flex:1}}
img.illu{width:100%;border-radius:8px;margin-top:8px}
@media print{body{background:#fff}.sidebar,.tabs,.footer-bar,.tools,.pwa,.toprow,button,.micbar,.jumprow,.screen-only,.ovl{display:none!important}}
</style>
</head>
<body>
<div class="app-container">
  <aside class="sidebar" id="sidebar"></aside>
  <div class="main">
    <div class="toprow">
      <div><h1><span class="skull">💀</span> Schreibblockade <span class="beta">BETA</span></h1><p class="muted" style="margin:6px 0 0">Co-Writer, Autopilot, Normseite, Lektorat, Bilder, Vorlesen. Tippen & Diktieren sind gratis – alles KI-Generierte ist ein Premium-Feature.</p></div>
      <button class="homebtn sm" type="button" id="gohome">⌂ Startseite</button>
      <button class="sm" type="button" id="pwa-install">App aufs Handy</button>
    </div>
    <div class="pwa" id="pwa-banner"></div>
    <nav class="tabs" id="tabs"></nav>
    <div id="content"></div>
    <footer class="footer-bar">
      <div>© 2026 Schwarzdichter App Familie</div>
      <div><button type="button" class="homebtn sm" id="fb-toggle">💬 Feedback / Kontakt</button></div>
      <div><a href="https://mein.online-impressum.de/hajodanckesongwriter/" target="_blank" style="color:var(--accent-red);text-decoration:none">Impressum</a></div>
    </footer>
    <div id="fb-box" style="display:none;max-width:520px;margin:20px auto 0;background:var(--bg-box);border:1px solid var(--border-color);border-radius:10px;padding:20px">
      <h3 style="margin-top:0">💬 Feedback / Kontakt</h3>
      <p class="muted">Für Gäste und schnelle Rückmeldungen. Eingeloggte Nutzer nutzen besser „Mein Konto → Support".</p>
      <div id="fb-msg"></div>
      <form id="fbform">
        <input type="text" id="fb-name" placeholder="Name (optional)" maxlength="100"/>
        <input type="email" id="fb-email" placeholder="E-Mail (optional, für Antwort)" maxlength="200"/>
        <textarea id="fb-text" rows="4" placeholder="Deine Nachricht …" maxlength="4000"></textarea>
        <div class="hp" aria-hidden="true"><label>Bitte leer lassen</label><input id="fb-website" type="text" tabindex="-1" autocomplete="off"/></div>
        <button type="submit">Absenden</button>
      </form>
    </div>
  </div>
</div>
<div id="ovlbox"></div>
<script>
if("serviceWorker" in navigator){navigator.serviceWorker.register("/sw.js").catch(function(){});}
// 🧠 Text-KI-Picker (Sidebar). TEXT_TIER_LABELS als Client-Kopie des Server-Konstanten (nötig, da Client-Script kein Zugriff auf Worker-Konstanten hat).
const TEXT_TIER_LABELS={uncensored:'💬 Uncensored / Frei',budget:'💵 Günstig & stark',mid:'⚡ Obere Mittelklasse',premium:'👑 Premium-Flaggschiff'};
function savedTextModel(){try{return localStorage.getItem('sb_text_model')||'';}catch(e){return '';}}
function activeTextModel(){const id=savedTextModel();return TMODELS.find(m=>m.id===id)||TMODELS.find(m=>m.id==='gemini-3-5-flash')||TMODELS[0];}
function textModelSidebarHtml(){
  if(!TMODELS.length) return '';
  const active=activeTextModel(); if(!active) return '';
  const group=(tier)=>{const list=TMODELS.filter(m=>m.tier===tier); if(!list.length) return '';
    return '<div style="font-size:10px;font-weight:bold;color:#fff;background:#2a2a35;padding:3px 7px;border-radius:5px;margin:6px 0 4px">'+TEXT_TIER_LABELS[tier]+'</div>'+list.map(m=>
      '<div class="tms-opt" data-id="'+m.id+'" style="cursor:pointer;background:'+(m.id===active.id?'#27163f':'#101114')+';border:1px solid '+(m.id===active.id?'#7c3aed':'#3b3d48')+';border-radius:6px;padding:7px;margin-bottom:5px">'
        +'<div style="display:flex;justify-content:space-between;gap:6px"><span style="font-size:11px;font-weight:bold;color:#fff">'+esc(m.name)+(m.uncensored?' 🔓':'')+(m.vision?' 🖼️':'')+'</span><span style="font-size:10px;color:#4ade80;font-weight:bold;white-space:nowrap">'+m.tokens+' T/Seite</span></div>'
        +'<div style="font-size:10px;color:#a1a1aa;margin-top:2px;line-height:1.3">'+esc(m.desc)+'</div></div>').join('');};
  return '<div style="margin-top:20px;border-top:1px solid var(--border-color);padding-top:15px">'
    +'<h3 style="margin:0 0 4px">🧠 Text-KI auswählen</h3>'
    +'<p style="margin:0 0 9px;font-size:11px;color:var(--text-muted)">Mit welcher KI sollen deine Texte geschrieben werden?</p>'
    +'<div id="tms_active" style="background:#101114;border:1px solid #7c3aed;border-radius:7px;padding:9px">'
      +'<div style="font-size:12px;font-weight:bold;color:#c4b5fd" id="tms_name">Aktiv: '+esc(active.name)+(active.uncensored?' 🔓':'')+(active.vision?' 🖼️':'')+'</div>'
      +'<div style="font-size:10px;color:#a1a1aa;margin-top:3px" id="tms_desc">'+esc(active.desc)+'</div>'
      +'<div style="font-size:10px;color:#4ade80;margin-top:4px;font-weight:bold" id="tms_price">'+active.tokens+' Tokens pro Normseite</div></div>'
    +'<div id="tms_toggle" style="cursor:pointer;margin-top:8px;background:#27163f;border:1px solid #7c3aed;border-radius:6px;padding:7px;text-align:center;color:#c4b5fd;font-size:12px;font-weight:bold">▾ Alle '+TMODELS.length+' Text-KIs ansehen &amp; wählen</div>'
    +'<div id="tms_list" style="display:none;margin-top:8px;max-height:340px;overflow-y:auto;background:#14151a;border:1px solid #7c3aed;border-radius:8px;padding:9px">'
      +group('uncensored')+group('budget')+group('mid')+group('premium')
      +'<p style="font-size:9px;color:#71717a;margin:8px 0 0">🔓 = uncensored · 🖼️ = liest Bilder · läuft über Venice, bei Ausfall Google-Notfall.</p></div></div>';
}
function bindTextModelPicker(){
  const toggle=document.getElementById('tms_toggle'),list=document.getElementById('tms_list');
  if(!toggle||!list) return;
  toggle.onclick=()=>{list.style.display=list.style.display==='none'?'block':'none';};
  list.querySelectorAll('.tms-opt').forEach(o=>{o.onclick=()=>{
    const m=TMODELS.find(x=>x.id===o.dataset.id); if(!m) return;
    try{localStorage.setItem('sb_text_model',m.id);}catch(e){}
    document.getElementById('tms_name').textContent='Aktiv: '+m.name+(m.uncensored?' 🔓':'')+(m.vision?' 🖼️':'');
    document.getElementById('tms_desc').textContent=m.desc;
    document.getElementById('tms_price').textContent=m.tokens+' Tokens pro Normseite';
    list.querySelectorAll('.tms-opt').forEach(x=>{x.style.background='#101114';x.style.borderColor='#3b3d48';});
    o.style.background='#27163f';o.style.borderColor='#7c3aed';
    list.style.display='none';
    document.querySelectorAll('#cmodel,#a_model').forEach(sel=>{if([...sel.options].some(op=>op.value===m.id))sel.value=m.id;});
  };});
}

const TRIMS={a5:{w:148,h:210,label:"DIN A5 · 14,8 \u00d7 21,0 cm"},"5x8":{w:127,h:203,label:"12,7 \u00d7 20,3 cm (5\u00d78)"},taschenbuch:{w:135,h:205,label:"Taschenbuch 13,5 \u00d7 20,5 cm"},"6x9":{w:152,h:229,label:"15,2 \u00d7 22,9 cm (6\u00d79)"},hardcover:{w:156,h:234,label:"Hardcover 15,6 \u00d7 23,4 cm"},custom:{w:148,h:210,label:"Eigenes Ma\u00df"}};
const STORAGE={S:{label:"Paket S",tokens:200,blurb:"Ca. 40 Manuskripte a 200 Normseiten. Ein Jahr."},M:{label:"Paket M",tokens:500,blurb:"Ca. 90 Manuskripte a 200 Normseiten. Ein Jahr."},L:{label:"Paket L",tokens:1100,blurb:"Ca. 180 Manuskripte a 200 Normseiten. Ein Jahr."},XL:{label:"Paket XL",tokens:2200,blurb:"Ca. 360 Manuskripte a 200 Normseiten. Ein Jahr."}};
const CONT_PAGES=[["1","1 Seite"],["2","2 Seiten"],["3","3 Seiten"],["5","5 Seiten"],["max","Maximal"]];
const AUTO_PAGES=[["2","2 Seiten"],["5","5 Seiten"],["10","10 Seiten"],["15","15 Seiten"],["20","20 Seiten"],["max","Maximal mögliche Länge"]];
const WORLD=[["✍️","Schwarzdichter","Songtexte aus Idee, Stichworten oder Bild.","https://schwarzdichter.com/?tab=directory"],["🖼️","Bildertonne","KI-Bilder erzeugen, bearbeiten, speichern.","https://bildertonne.etmfilm.workers.dev/?tab=tab_community"],["📖","Schreibblockade","Co-Writer, Autopilot, Normseite, Bilder.","/"],["🪶","Federflausen","Kindergeschichten bis 12 Jahre.","https://federflausen.schwarzdichter.com/?tab=tab_community"],["🧠","Gedankensammler","Gedanken geschützt verwahren.","https://gedankensammler.schwarzdichter.com"],["🔐","Gedankentresor","Verschlüsseltes Schließfach.","https://gedankentresor.schwarzdichter.com"]];
let USER=null,VIEW="guest",BOOKS=[],BOOK=null,ACTIVE=0,SAVE=null,WORK=null,MSG="",OK="",MIC=null,INSTALL_EVT=null,PENDING=null,SITEKEY="",TSWIDGET=null,TMODELS=[],IMODELS=[];

function isStandalone(){return window.matchMedia("(display-mode: standalone)").matches||window.navigator.standalone===true;}
function isIOS(){return /iphone|ipad|ipod/i.test(navigator.userAgent);}
function pwaHint(){ if(isStandalone())return ""; if(isIOS())return "iPhone: Teilen \u2192 <b>Zum Home-Bildschirm</b>. Diktieren kostet keine Tokens."; if(INSTALL_EVT)return "Android: Button <b>App aufs Handy</b> oben."; return "Handy: Browser-Men\u00fc \u2192 <b>Zum Home-Bildschirm</b>."; }
window.addEventListener("beforeinstallprompt", function(e){ e.preventDefault(); INSTALL_EVT=e; var b=document.getElementById("pwa-banner"); if(b){ b.className="pwa"; b.innerHTML=pwaHint(); }});

function trimMetrics(){
  var id=(BOOK&&BOOK.trimFormat)||"normseite";
  if(!BOOK || BOOK.viewMode!=="book" || id==="normseite") return {max:1500,lines:30,cpl:60,w:210,h:297,bleed:0,ml:20,mr:20,mt:20,mb:20,norm:true};
  var t=TRIMS[id]||TRIMS.a5, w=id==="custom"?Math.max(80,BOOK.customWidthMm|0||148):t.w, h=id==="custom"?Math.max(100,BOOK.customHeightMm|0||210):t.h;
  var bleed=Math.max(0,Math.min(20,BOOK.bleedMm|0||3)), ml=18,mr=15,mt=16,mb=20, innerW=Math.max(40,w-ml-mr), innerH=Math.max(50,h-mt-mb), lineMm=12.5*0.352777*1.55, charMm=12.5*0.352777*0.48;
  var lines=Math.max(12,Math.floor(innerH/lineMm)), cpl=Math.max(20,Math.floor(innerW/charMm));
  return {max:lines*cpl,lines:lines,cpl:cpl,w:w,h:h,bleed:bleed,ml:ml,mr:mr,mt:mt,mb:mb,norm:false};
}
function visualLines(text){var cpl=trimMetrics().cpl,out=[];String(text||"").replace(/\\r/g,"").split("\\n").forEach(function(p){if(!p.length){out.push("");return;}var rest=p;while(rest.length>cpl){var slice=rest.slice(0,cpl),sp=slice.lastIndexOf(" "),cut=sp>24?sp:cpl;out.push(rest.slice(0,cut).trimEnd());rest=rest.slice(cut).trimStart();}out.push(rest);});return out;}
function fits(t){var L=trimMetrics();return t.length<=L.max&&visualLines(t).length<=L.lines;}
function splitAt(text){if(fits(text))return{kept:text,overflow:""};var lo=0,hi=text.length;while(lo<hi){var mid=Math.ceil((lo+hi)/2);if(fits(text.slice(0,mid)))lo=mid;else hi=mid-1;}var cut=lo;var sp=Math.max(text.lastIndexOf(" ",cut),text.lastIndexOf("\\n",cut));if(sp>cut-48&&sp>0)cut=sp+1;return{kept:text.slice(0,cut).replace(/\\s+$/g,""),overflow:text.slice(cut).replace(/^\\s+/g,"")};}
function paginate(pages,start){var next=pages.slice(),i=start;while(i<next.length){var r=splitAt(next[i]||"");next[i]=r.kept;if(!r.overflow)break;if(i+1>=next.length)next.push("");next[i+1]=r.overflow+(next[i+1]?(next[i+1].charAt(0)==="\\n"?"":" ")+next[i+1]:"");i++;}if(!next.length)next.push("");return next;}
function applyQuotes(text,style){var pairs={french:["«","»"],swiss:["»","«"],german:["„","“"],english:["“","”"]};var pc=pairs[style]||pairs.german;var out="",open=true,i,ch,q="«»„“”"+'"';for(i=0;i<text.length;i++){ch=text.charAt(i);if(q.indexOf(ch)>=0){out+=open?pc[0]:pc[1];open=!open;}else out+=ch;}return out;}
function esc(s){return String(s||"").replace(/[&<>"']/g,function(c){return {"&":"&"+"amp;","<":"&"+"lt;",">":"&"+"gt;",'"':"&"+"quot;","'":"&#39;"}[c];});}
async function api(path,opt){var r=await fetch(path,Object.assign({credentials:"same-origin",headers:{"content-type":"application/json"}},opt||{}));var d=await r.json().catch(function(){return {};});if(d.user)USER=d.user;if(!r.ok)throw new Error(d.error||("HTTP "+r.status));return d;}
function textModelOptions(sel){return TMODELS.map(function(m){return '<option value="'+m.id+'"'+(m.id===sel?" selected":"")+'>'+esc(m.name)+(m.uncensored?" 🔓":"")+' · '+m.tokens+' T/Seite</option>';}).join("");}
function opts(arr,sel){return arr.map(function(o){return '<option value="'+o[0]+'"'+(o[0]===sel?" selected":"")+'>'+o[1]+'</option>';}).join("");}

function renderTurnstile(){ if(!SITEKEY||!window.turnstile) return; var el=document.getElementById("ts-box"); if(!el) return; try{ TSWIDGET=window.turnstile.render(el,{sitekey:SITEKEY}); }catch(e){} }
function tsToken(){ if(!SITEKEY||!window.turnstile||TSWIDGET===null) return ""; try{ return window.turnstile.getResponse(TSWIDGET)||""; }catch(e){ return ""; } }

function logoHtml(){return '<div class="logo-sq"><div class="sk">💀</div><strong>SCHREIBBLOCKADE</strong><span>Aus Schmerz wird Kunst</span></div>';}
function sidebarHtml(){
  var inner;
  if(!USER){
    inner='<h3>🔐 Anmeldung</h3>'+(MSG?'<div class="alert-error">'+esc(MSG)+'</div>':'')+(OK?'<div class="alert-ok">'+esc(OK)+'</div>':'')+
      '<form id="auth" autocomplete="off"><label>E-Mail</label><input name="email" type="email" required autocomplete="username"/><label>Passwort</label><input name="password" type="password" required minlength="8" autocomplete="current-password"/>'+
      '<div class="hp" aria-hidden="true"><label>Bitte leer lassen</label><input name="website" type="text" tabindex="-1" autocomplete="off"/></div>'+
      '<div id="ts-box" style="margin:8px 0"></div>'+
      '<button type="submit" name="mode" value="login">Anmelden</button><button class="ghost" type="submit" name="mode" value="register" style="margin-top:8px">Registrieren</button></form><p class="muted" style="margin-top:8px">Tippen & Diktieren sind kostenlos. Für KI-Funktionen brauchst du Tokens.</p>';
  } else {
    inner='<h3>🔐 Account</h3><p style="margin:0 0 6px">'+esc(USER.email)+'</p><p id="tk_sidebar_tokens" style="font-size:18px;font-weight:bold;color:#4ade80;margin:0 0 12px">'+(USER.tokens|0)+' Tokens</p><p class="muted">'+(USER.plan==="none"?"Ohne Speicherpaket · 7 Tage":("Paket "+USER.plan))+'</p><button class="ghost" id="logout" type="button">Abmelden</button>';
  }
  var voucher=USER?('<div class="sidebar-bottom"><h3>🎟️ Gutschein einlösen</h3><div id="vmsg"></div><form id="voucher" style="margin:0"><input type="text" id="vcode" placeholder="Gutscheincode eingeben" autocomplete="off"/><button type="submit">Einlösen</button></form><p class="muted" style="margin-top:8px"><a href="https://payhip.com/HajoDancke" target="_blank" rel="noopener" style="color:var(--accent-red)">🛒 Gutscheine kaufen</a></p></div>'):'<div class="sidebar-bottom"><p class="muted">Digistore24- & Payhip-Käufe werden dem Konto mit derselben E-Mail gutgeschrieben.</p></div>';
  return logoHtml()+'<div style="margin-top:15px;flex:1">'+inner+'</div>'+(USER?textModelSidebarHtml():'')+voucher;
}
function tabsHtml(){
  var items=[["guest","Startseite"]];
  if(USER){ items=[["desk","✍️ Manuskripte"],["edit","📖 Schreiben"],["auto","🤖 Autopilot"],["konto","👤 Mein Konto"]]; if(USER.role==="admin") items.push(["admin","🛠️ Admin"]); }
  return items.map(function(it){return '<button type="button" class="tab-link'+(VIEW===it[0]?" active":"")+'" data-go="'+it[0]+'">'+it[1]+'</button>';}).join("");
}
function guestPage(){
  var feats=[["📄","Offizielle Normseite","1.500 Zeichen, 30 Zeilen, Courier, DIN-A4."],["📝","Lektorat satzweise","Vorschläge Satz für Satz einzeln übernehmen."],["🤖","Co-Writer & Autopilot","Jedes Modell wählbar. Kapitel aus Titel, Genre, Figuren, Outline."],["🎤","Diktieren am Handy","0 Tokens."],["🔊","Vorlesen","Manuskript vorlesen lassen – 0 Tokens."],["🖼️","Bilder pro Seite","Gezielt pro Seite erzeugen – CHROMA, Venice, Grok."]];
  var feat=feats.map(function(f){return '<div class="card"><div style="font-size:28px">'+f[0]+'</div><strong>'+f[1]+'</strong><span class="muted">'+f[2]+'</span></div>';}).join("");
  var world=WORLD.map(function(w){return '<a class="card" href="'+w[3]+'"><div style="font-size:28px">'+w[0]+'</div><strong>'+w[1]+'</strong><span class="muted">'+w[2]+'</span><span class="more">Mehr erfahren →</span></a>';}).join("");
  return '<div class="box" style="text-align:center"><h2>Das kannst du hier erschaffen — sobald du dabei bist</h2><p class="muted" style="max-width:640px;margin:0 auto 22px">Registriere dich links. Tippen und Diktieren sind gratis; KI-Funktionen laufen über Tokens (Gutschein oder Kauf).</p><div class="grid" style="text-align:left">'+feat+'</div></div><section class="box"><h2 style="text-align:center">Entdecke die Schwarzdichter-Welt</h2><div class="grid">'+world+'</div></section>';
}
function deskPage(){
  var list=BOOKS.map(function(b){return '<div class="card" style="min-height:0"><a href="#" data-open="'+b.id+'" style="color:inherit;text-decoration:none"><strong>'+(esc(b.title)||"Ohne Titel")+'</strong>'+(b.isAdult?' <span class="muted">ADULT</span>':'')+'<div class="muted">'+esc(b.genre||"Roman")+' · '+b.pages+' Normseiten · '+Number(b.chars).toLocaleString("de-DE")+' Zeichen'+(b.expiresAt?' · bis '+new Date(b.expiresAt).toLocaleDateString("de-DE"):' · im Jahrespaket')+'</div></a><button class="ghost sm" data-del="'+b.id+'" style="margin-top:10px">Löschen</button></div>';}).join("")||'<div class="muted">Noch nichts auf dem Schreibtisch.</div>';
  var deskWarn = (USER.plan==="none") ? '<div class="alert-error" style="margin-bottom:16px">⚠️ Ohne Speicherpaket werden Manuskripte nach 7 Tagen automatisch gelöscht. Sichere sie dir mit einem günstigen Paket (ein Jahr) unter „Mein Konto → Tokens".</div>' : '';
  return deskWarn + '<div class="box"><div class="toprow"><div><h2>Manuskripte</h2></div><div style="display:flex;gap:8px"><button class="sm" id="new" type="button">Neues Manuskript</button><button class="ghost sm" id="newa" type="button">Adult</button></div></div><div class="grid" style="margin-top:18px">'+list+'</div></div>';
}
let KONTO_SUB='overview';
function kontoPage(){
  var nav=[['overview','👤 Übersicht & Kontodaten'],['support','📨 Support & Feedback'],['tokens','💎 Tokens & Gutscheine'],['history','📜 Transaktions-Historie'],['delete','⚠️ Kontolöschung']];
  var navHtml=nav.map(function(n){return '<button type="button" class="ghost sm konto-subtab" data-ksub="'+n[0]+'" style="'+(KONTO_SUB===n[0]?'background:var(--accent-red);color:#fff;border-color:var(--accent-red)':'')+'">'+n[1]+'</button>';}).join(" ");
  return '<div class="box"><h2>👤 Mein Konto</h2><p class="muted">'+esc(USER.email)+'</p><div style="display:flex;gap:8px;flex-wrap:wrap;margin:16px 0 22px;border-bottom:1px solid var(--border-color);padding-bottom:16px">'+navHtml+'</div><div id="ksub-content"></div></div>';
}
function kontoSubHtml(){
  if(KONTO_SUB==='overview') return kontoOverview();
  if(KONTO_SUB==='support') return kontoSupport();
  if(KONTO_SUB==='tokens') return kontoTokens();
  if(KONTO_SUB==='history') return '<h3>Transaktions-Historie</h3><div id="ledger" class="muted">Lädt …</div>';
  if(KONTO_SUB==='delete') return kontoDelete();
  return '';
}
function kontoOverview(){
  var warn = (USER.plan==="none") ? '<div class="alert-error" style="margin-bottom:16px">⚠️ <b>Ohne Speicherpaket werden alle Manuskripte nach 7 Tagen gelöscht.</b> Mit einem Paket (S/M/L/XL) bleiben sie ein ganzes Jahr erhalten. → Tab „💎 Tokens & Gutscheine".</div>' : '';
  return warn + '<div class="grid" style="margin-bottom:22px"><div class="card" style="min-height:0"><div class="muted">Guthaben</div><h2 style="margin:4px 0 0">'+(USER.tokens|0)+' Tokens</h2></div><div class="card" style="min-height:0"><div class="muted">Status</div><h2 style="margin:4px 0 0">'+(USER.role==="admin"?"Admin":"Mitglied")+'</h2></div><div class="card" style="min-height:0"><div class="muted">Speicher</div><h2 style="margin:4px 0 0">'+(USER.plan==="none"?"Ohne Paket":("Paket "+USER.plan))+'</h2><div class="muted">'+(USER.planUntil?("bis "+new Date(USER.planUntil).toLocaleDateString("de-DE")):"7 Tage ohne Paket")+'</div></div></div>'+
    '<h3>Kontodaten bearbeiten</h3><div id="pf_msg"></div><form id="profileform"><div style="display:flex;gap:10px;flex-wrap:wrap"><div style="flex:1;min-width:160px"><label>Vorname</label><input id="pf_vorname" value="'+esc(USER.vorname||"")+'" maxlength="80"/></div><div style="flex:1;min-width:160px"><label>Nachname</label><input id="pf_nachname" value="'+esc(USER.nachname||"")+'" maxlength="80"/></div></div>'+
    '<h3 style="margin-top:18px">Passwort ändern (optional)</h3><label>Neues Passwort (min. 8 Zeichen, leer lassen = unverändert)</label><input id="pf_newpw" type="password" autocomplete="new-password"/><label>Aktuelles Passwort (nur nötig, wenn du das Passwort änderst)</label><input id="pf_curpw" type="password" autocomplete="current-password"/>'+
    '<button type="submit" style="margin-top:12px">Änderungen speichern</button></form>';
}
function kontoSupport(){
  return '<h3>📨 Support kontaktieren</h3><p class="muted">Deine Nachricht geht direkt an den Admin (intern + per E-Mail). Antworten erscheinen hier im Verlauf.</p><div id="sup_msg"></div><form id="supportform"><textarea id="sup_text" rows="4" placeholder="Deine Nachricht an den Support …" maxlength="4000"></textarea><button type="submit" style="margin-top:8px">Nachricht senden</button></form>'+
    '<h3 style="margin-top:22px">Nachrichtenverlauf</h3><div id="sup_history" class="muted">Lädt …</div>';
}
function kontoTokens(){
  var packs=Object.keys(STORAGE).map(function(k){return '<button class="ghost" style="text-align:left;display:flex;justify-content:space-between;align-items:center" data-pack="'+k+'"><span><b>'+STORAGE[k].label+'</b><div class="muted">'+STORAGE[k].blurb+'</div></span><span>'+STORAGE[k].tokens+' Tokens / Jahr</span></button>';}).join("");
  return '<h3>💎 Tokens kaufen</h3><p class="muted">Käufe werden dem Konto ('+esc(USER.email)+') automatisch gutgeschrieben.</p><div class="grid" style="margin:12px 0 22px"><div class="card"><strong>500 Tokens</strong><span class="muted">Digistore24</span><div style="margin-top:12px"><a class="btnlink" href="https://www.digistore24.com/product/741390" target="_blank" rel="noopener">💎 500 Tokens kaufen</a></div></div><div class="card"><strong>1.200 Tokens</strong><span class="muted">Digistore24</span><div style="margin-top:12px"><a class="btnlink" href="https://www.digistore24.com/product/741391" target="_blank" rel="noopener">💎 1.200 Tokens kaufen</a></div></div><div class="card"><strong>Payhip-Gutscheine</strong><span class="muted">Alternative</span><div style="margin-top:12px"><a class="btnlink" style="background:#2a1215;color:#ff8080;border-color:#ff4b4b" href="https://payhip.com/HajoDancke" target="_blank" rel="noopener">🛒 Zu Payhip</a></div></div></div>'+
    '<h3>🎟️ Gutschein einlösen</h3><div id="kv_msg"></div><form id="kvoucher" style="display:flex;gap:8px;flex-wrap:wrap"><input type="text" id="kv_code" placeholder="Gutscheincode" autocomplete="off" style="flex:1;min-width:200px;margin:0"/><button type="submit" class="sm">Einlösen</button></form>'+
    '<h3 style="margin-top:22px">Speicher-Tarife (ein Jahr)</h3><p class="muted">Ohne Paket bleiben Manuskripte 7 Tage. Mit Paket ein ganzes Jahr.</p><div style="display:grid;gap:10px;margin-top:12px">'+packs+'</div>';
}
function kontoDelete(){
  return '<h3 style="color:#f87171">⚠️ Konto unwiderruflich löschen</h3><p class="muted">Löscht dein Konto, alle Manuskripte, Nachrichten und den Verlauf endgültig. Das kann nicht rückgängig gemacht werden.</p><div id="del_msg"></div><form id="deleteform"><label>Aktuelles Passwort</label><input id="del_pw" type="password" autocomplete="current-password"/><label>Zur Bestätigung „LÖSCHEN" eingeben</label><input id="del_confirm" type="text" placeholder="LÖSCHEN"/><button type="submit" style="margin-top:12px;background:#8b0000">Konto endgültig löschen</button></form>';
}
function shopPage(){
  var packs=Object.keys(STORAGE).map(function(k){return '<button class="ghost" style="text-align:left;display:flex;justify-content:space-between;align-items:center" data-pack="'+k+'"><span><b>'+STORAGE[k].label+'</b><div class="muted">'+STORAGE[k].blurb+'</div></span><span>'+STORAGE[k].tokens+' Tokens / Jahr</span></button>';}).join("");
  return '<div class="box"><h2>Tokens kaufen</h2><p class="muted">Käufe werden deinem Konto ('+esc(USER.email)+') automatisch gutgeschrieben. Gutscheincodes löst du links unten ein.</p><div class="grid" style="margin-top:14px"><div class="card"><strong>500 Tokens</strong><span class="muted">Digistore24</span><div style="margin-top:12px"><a class="btnlink" href="https://www.digistore24.com/product/741390" target="_blank" rel="noopener">💎 500 Tokens kaufen</a></div></div><div class="card"><strong>1.200 Tokens</strong><span class="muted">Digistore24</span><div style="margin-top:12px"><a class="btnlink" href="https://www.digistore24.com/product/741391" target="_blank" rel="noopener">💎 1.200 Tokens kaufen</a></div></div><div class="card"><strong>Payhip-Gutscheine</strong><span class="muted">Alternative Kaufquelle</span><div style="margin-top:12px"><a class="btnlink" style="background:#2a1215;color:#ff8080;border-color:#ff4b4b" href="https://payhip.com/HajoDancke" target="_blank" rel="noopener">🛒 Zu Payhip</a></div></div></div></div>'+
    '<div class="box"><h2>Speicher-Tarife (ein Jahr)</h2><p class="muted">Ohne Paket bleiben Manuskripte 7 Tage. Mit Paket ein ganzes Jahr.</p><div style="display:grid;gap:10px;margin-top:16px">'+packs+'</div></div>';
}
function adminPage(){return '<div class="box"><h2>🛠️ Admin-Zentrale</h2><div id="adminbox" class="muted">Lädt …</div></div>';}
function autoPage(){
  if(!BOOK) return '<div class="box"><h2>🤖 Autopilot</h2><p class="muted">Öffne oder erstelle zuerst ein Manuskript.</p><button class="sm" id="auto-new" type="button" style="margin-top:10px">Neues Manuskript starten</button></div>';
  var chars=(BOOK.characters||[]);
  var charRows=chars.map(function(c,i){return '<div class="charrow" data-ci="'+i+'"><input placeholder="Name" value="'+esc(c.name||"")+'" data-cf="name"/><input placeholder="Rolle" value="'+esc(c.role||"")+'" data-cf="role"/><input placeholder="Eigenschaften" value="'+esc(c.traits||"")+'" data-cf="traits"/><button class="ghost sm" data-cdel="'+i+'" type="button">✕</button></div>';}).join("");
  return '<div class="box"><div class="toprow"><h2>🤖 Autopilot · Kapitel-Generator</h2><button class="ghost sm" type="button" id="auto-toedit">Zum Schreiben</button></div>'+
    (MSG?'<div class="alert-error">'+esc(MSG)+'</div>':'')+(WORK?'<div class="alert-ok">'+esc(WORK)+'</div>':'')+
    '<label>Buchtitel</label><input id="a_title" value="'+esc(BOOK.title||"")+'"/>'+
    '<label>Genre</label><input id="a_genre" value="'+esc(BOOK.genre||"Roman")+'" placeholder="z.B. Thriller, Fantasy, Liebesroman"/>'+
    '<label>Gesamt-Outline (roter Faden)</label><textarea id="a_outline" rows="4" placeholder="Grober Handlungsbogen.">'+esc(BOOK.outline||"")+'</textarea>'+
    '<label>Figuren-Bibel</label><div id="charlist">'+charRows+'</div><button class="ghost sm" type="button" id="addchar">+ Figur</button>'+
    '<label style="margin-top:14px">Ziel dieses Kapitels</label><textarea id="a_goal" rows="3" placeholder="Was soll in DIESEM Kapitel passieren?"></textarea>'+
    '<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;margin-top:8px"><div style="flex:1;min-width:200px"><label>Schreibende KI</label><select id="a_model">'+textModelOptions(savedTextModel() || "grok-4-3")+'</select></div><div style="min-width:190px"><label>Länge</label><select id="a_pages">'+opts(AUTO_PAGES,"5")+'</select></div></div>'+
    '<label style="margin-top:4px"><input type="checkbox" id="a_adult" '+(BOOK.isAdult?"checked":"")+'/> Adult 18+ (nutzt gezielt ein Venice-Uncensored-Modell)</label>'+
    '<button type="button" id="a_go" style="margin-top:14px">Kapitel erzeugen & ans Manuskript anhängen</button>'+
    '<p class="muted" style="margin-top:10px">„Maximal" nutzt das Kontext-/Output-Fenster der gewählten KI voll aus. Mindestens 50 % Marge sind in jedem Preis garantiert.</p></div>';
}
function editorPage(){
  if(!BOOK) return '<div class="box">Lädt …</div>';
  var storeWarn = (USER.plan==="none") ? '<div class="alert-error" style="margin-bottom:12px">⚠️ Ohne Speicherpaket wird dieses Manuskript nach 7 Tagen gelöscht. Paket im Tab „Mein Konto → Tokens" sichern.</div>' : '';
  var page=BOOK.pages[ACTIVE]||BOOK.pages[0];
  var L=trimMetrics(); var isBook=BOOK.viewMode==="book" && (BOOK.trimFormat||"normseite")!=="normseite"; var pos=BOOK.pageNumberPos||"bottom-center";
  var modelOpts=IMODELS.map(function(m){return '<option value="'+m.id+'">'+esc(m.name)+' · '+m.tokens+' T</option>';}).join("");
  var pageTargetOpts=BOOK.pages.map(function(p,i){return '<option value="'+i+'"'+(i===ACTIVE?" selected":"")+'>Seite '+(i+1)+'</option>';}).join("");
  var sheets="", i, from=Math.max(0,ACTIVE-1), to=Math.min(BOOK.pages.length-1, ACTIVE+2);
  if(BOOK.pages.length<=12){ from=0; to=BOOK.pages.length-1; }
  for(i=from;i<=to;i++){
    var pg=BOOK.pages[i], txt=pg.body||"", side=isBook?(i%2===0?" right":" left"):"";
    var chars=txt.length, lines=visualLines(txt).length;
    var posClass="pnum "+(pos.indexOf("top")===0?"top":"bottom")+" "+(pos.indexOf("left")>=0?"left":pos.indexOf("right")>=0?"right":"center")+(BOOK.pageNumberVisible===false||pos==="hidden"?" ghost":"");
    var pnumHtml='<div class="'+posClass+'">'+(i+1)+'</div>';
    var inner=(i===ACTIVE)?'<textarea id="body" maxlength="12000" placeholder="Fang einfach an zu schreiben …">'+esc(txt)+'</textarea>':'<div class="bodytxt" data-pg="'+i+'">'+esc(txt)+'</div>';
    if(isBook){
      var px=2.2, padB=Math.round(L.bleed*px), tw=Math.round(L.w*px), th=Math.round(L.h*px), padL=Math.round((i%2===0?L.ml+6:L.ml)*px), padR=Math.round((i%2===1?L.mr+6:L.mr)*px), padT=Math.round(L.mt*px), padBt=Math.round(L.mb*px);
      sheets+='<div class="bleed'+side+'" data-pg="'+i+'" style="padding:'+padB+'px"><span class="tag screen-only">Verschnitt '+L.bleed+' mm</span><div class="trim bookview" lang="de" style="width:'+tw+'px;height:'+th+'px;max-width:100%;padding:'+padT+'px '+padR+'px '+padBt+'px '+padL+'px;overflow:hidden">'+pnumHtml+inner+'</div></div>';
    } else {
      sheets+='<article class="sheet" data-pg="'+i+'">'+inner+'<div class="foot screen-only"><span>'+chars+' / '+L.max+' · '+lines+' / '+L.lines+' Zeilen</span><span>Normseite '+(i+1)+' / '+BOOK.pages.length+'</span></div></article>';
    }
  }
  if(from>0) sheets='<p class="muted screen-only">… '+from+' Seite(n) darüber</p>'+sheets;
  if(to<BOOK.pages.length-1) sheets+='<p class="muted screen-only">… '+(BOOK.pages.length-1-to)+' Seite(n) darunter</p>';
  var trimOpts=[{id:"normseite",l:"VG Wort Normseite (A4)"},{id:"a5",l:"DIN A5 14,8×21 cm"},{id:"5x8",l:"12,7×20,3 cm (5×8)"},{id:"taschenbuch",l:"Taschenbuch 13,5×20,5 cm"},{id:"6x9",l:"15,2×22,9 cm (6×9)"},{id:"hardcover",l:"Hardcover 15,6×23,4 cm"},{id:"custom",l:"Eigenes Maß"}].map(function(o){return '<option value="'+o.id+'"'+((BOOK.trimFormat||"normseite")===o.id?" selected":"")+'>'+o.l+'</option>';}).join("");
  var pnOpts=[["bottom-right","unten rechts"],["bottom-center","unten mitte"],["bottom-left","unten links"],["top-right","oben rechts"],["top-center","oben mitte"],["top-left","oben links"],["hidden","unsichtbar"]].map(function(o){return '<option value="'+o[0]+'"'+(pos===o[0]?" selected":"")+'>'+o[1]+'</option>';}).join("");
  var customBox=(BOOK.trimFormat==="custom")?'<div style="display:flex;gap:8px"><input id="cw" type="text" inputmode="numeric" value="'+(BOOK.customWidthMm||148)+'" placeholder="Breite mm" style="margin:0"/><input id="ch" type="text" inputmode="numeric" value="'+(BOOK.customHeightMm||210)+'" placeholder="Höhe mm" style="margin:0"/></div>':'';
  var pending="";
  if(PENDING){
    pending='<div class="pending"><p><b>Lektorat-Vorschlag</b> — Sätze einzeln an/aus klicken:</p><div id="sentlist">'+PENDING.pairs.map(function(pr,idx){return '<div class="sent on" data-si="'+idx+'">'+(pr.orig!==pr.neu?('<div class="o">'+esc(pr.orig)+'</div>'):'')+'<div class="n">'+esc(pr.neu)+'</div></div>';}).join("")+'</div><div style="display:flex;gap:8px;margin-top:8px"><button class="sm" type="button" id="acc">Ausgewählte übernehmen</button><button class="ghost sm" type="button" id="rej">Verwerfen</button></div></div>';
  }
  var adultNote=BOOK.isAdult?'<div class="adult-flag">ADULT 18+ ist an. Co-Writer nutzt gezielt ein unzensiertes Venice-Modell.</div>':'';
  return storeWarn + '<div class="ed"><div><div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center"><input id="title" value="'+esc(BOOK.title)+'" placeholder="Buchtitel" style="flex:1;margin:0"/><button class="ghost sm" type="button" id="modeM">Normseite</button><button class="ghost sm" type="button" id="modeB">Buchseite</button></div>'+
    '<div class="jumprow screen-only"><span class="muted">Seite</span><input id="jump" type="text" inputmode="numeric" value="'+(ACTIVE+1)+'"/><span class="muted">von '+BOOK.pages.length+'</span><button class="ghost sm" type="button" id="gojump">Gehe zu</button><button class="ghost sm" type="button" id="addp">Neue Seite</button><button class="ghost sm" type="button" id="prev">👁️ Vorschau</button></div>'+
    '<div class="stack" id="stack">'+sheets+'</div><div class="micbar"><button type="button" id="mic2">Diktieren (0 Token)</button></div></div><aside class="tools"><p class="muted" id="savestate">Autosave</p>'+(WORK?'<p class="muted">'+esc(WORK)+'</p>':'')+(MSG?'<div class="alert-error">'+esc(MSG)+'</div>':'')+pending+
    '<div style="display:flex;gap:8px;flex-wrap:wrap"><button class="sm" type="button" data-act="spell">Korrigieren</button><button class="ghost sm" type="button" data-act="syn">Synonyme</button><button class="ghost sm" type="button" data-act="imp">Lektorat (satzweise)</button></div>'+
    '<p class="muted" style="margin-top:14px">Diktieren · 0 Token</p><button class="ghost" type="button" id="mic">Diktieren</button>'+
    '<p class="muted" style="margin-top:14px">🔊 Vorlesen · 0 Token</p><div style="display:flex;gap:8px"><button class="ghost sm" type="button" id="speak">Vorlesen</button><button class="ghost sm" type="button" id="stopspeak">Stopp</button></div>'+
    '<p class="muted" style="margin-top:14px">Co-Writer · Modell + Länge</p><select id="cmodel">'+textModelOptions(savedTextModel() || (BOOK.isAdult?"venice-uncensored-1-2":"gemini-3-5-flash"))+'</select><select id="cpages">'+opts(CONT_PAGES,"1")+'</select><button class="sm" type="button" data-act="cont" style="margin-top:6px">KI schreibt weiter</button><div id="synbox"></div>'+
    '<button class="ghost" type="button" id="toauto" style="margin-top:10px">🤖 Autopilot (ganze Kapitel)</button>'+
    '<div class="imgbox"><p class="muted" style="margin:0 0 8px">🖼️ Bild gezielt pro Seite</p><label class="muted" style="margin:0">Zielseite</label><select id="ipage">'+pageTargetOpts+'</select><label class="muted" style="margin:0">Bild-KI</label><select id="imodel">'+modelOpts+'</select><textarea id="iprompt" rows="3" placeholder="Prompt – oder „Aus Seiteninhalt“ nutzen">'+esc(page.imagePrompt||"")+'</textarea><div style="display:flex;gap:8px"><button class="ghost sm" type="button" id="ifill">Aus Seiteninhalt</button><button class="ghost sm" type="button" data-act="img">Bild generieren</button></div>'+(page.imageUrl?'<img class="illu" src="'+page.imageUrl+'"/>':'')+'</div>'+
    '<p class="muted" style="margin-top:14px">Deckblatt / Widmung (für PDF)</p><input id="author" placeholder="Autor:in" value="'+esc(BOOK.authorName||"")+'"/><input id="dedf" placeholder="Von (optional)" value="'+esc(BOOK.dedicationFrom||"")+'"/><input id="dedt" placeholder="Widmung: Für …" value="'+esc(BOOK.dedicationTo||"")+'"/>'+
    '<p class="muted" style="margin-top:14px">Buchformat / Verschnitt</p><select id="trim">'+trimOpts+'</select>'+customBox+
    '<label class="muted">Verschnitt mm</label><input id="bleed" type="text" inputmode="numeric" value="'+(BOOK.bleedMm||3)+'"/>'+
    '<label class="muted">Seitenzahl</label><select id="pnpos">'+pnOpts+'</select>'+
    '<p class="muted" style="margin-top:14px">Anführungszeichen</p><select id="quotes"><option value="german">Deutsch „ so “</option><option value="french">Französisch « so »</option><option value="swiss">Spitze »so«</option><option value="english">Englisch “ so ”</option></select>'+
    '<label class="muted"><input type="checkbox" id="adult" '+(BOOK.isAdult?"checked":"")+'/> Adult 18+</label>'+adultNote+
    '<button class="ghost" type="button" data-act="quotes">Anführungszeichen setzen</button><button class="sm" type="button" id="doprint" style="margin-top:8px">📄 Als PDF (mit Deckblatt)</button>'+
    '<p class="muted" style="margin-top:14px">📧 Manuskript als PDF per E-Mail</p><input id="sendto" type="email" placeholder="Empfänger-E-Mail"/><button class="sm" type="button" id="dosend">Als PDF senden</button><div id="sendmsg" class="muted" style="margin-top:6px"></div></aside></div>';
}

function render(){
  if(!USER && VIEW!=="guest") VIEW="guest";
  document.getElementById("sidebar").innerHTML=sidebarHtml();
  document.getElementById("tabs").innerHTML=tabsHtml();
  var ban=document.getElementById("pwa-banner"); if(ban){ var h=pwaHint(); ban.innerHTML=h; ban.className=h?"pwa":"pwa hidden"; }
  var el=document.getElementById("content");
  if(!USER||VIEW==="guest") el.innerHTML=guestPage();
  else if(VIEW==="desk") el.innerHTML=deskPage();
  else if(VIEW==="konto"){ el.innerHTML=kontoPage(); var kc=document.getElementById("ksub-content"); if(kc) kc.innerHTML=kontoSubHtml(); }
  else if(VIEW==="auto") el.innerHTML=autoPage();
  else if(VIEW==="admin") el.innerHTML=(USER.role==="admin"?adminPage():guestPage());
  else if(VIEW==="edit") el.innerHTML=editorPage();
  bind();
  bindTextModelPicker();
  if(!USER){ TSWIDGET=null; renderTurnstile(); }
}
function bind(){
  document.querySelectorAll("[data-go]").forEach(function(a){a.onclick=function(){go(a.getAttribute("data-go"));};});
  var gh=document.getElementById("gohome"); if(gh) gh.onclick=function(){VIEW=USER?"desk":"guest"; MSG=""; render();};
  var lo=document.getElementById("logout"); if(lo) lo.onclick=async function(){await api("/api/logout",{method:"POST",body:"{}"}); USER=null; VIEW="guest"; render();};
  var f=document.getElementById("auth");
  if(f) f.addEventListener("submit", async function(e){ e.preventDefault(); MSG=""; OK=""; var mode=(e.submitter && e.submitter.value==="register")?"register":"login"; try{ var fd=new FormData(f); await api("/api/"+mode,{method:"POST",body:JSON.stringify({email:fd.get("email"),password:fd.get("password"),website:fd.get("website"),turnstileToken:tsToken()})}); VIEW="desk"; await loadBooks(); } catch(err){MSG=err.message; render();} });
  var vf=document.getElementById("voucher");
  if(vf) vf.addEventListener("submit", async function(e){ e.preventDefault(); var vm=document.getElementById("vmsg"); try{ var d=await api("/api/voucher",{method:"POST",body:JSON.stringify({code:document.getElementById("vcode").value})}); if(vm){vm.className="alert-ok";vm.textContent="+"+d.added+" Tokens!";} render(); }catch(err){ if(vm){vm.className="alert-error";vm.textContent=err.message;} } });
  var n=document.getElementById("new"); if(n) n.onclick=function(){createBook(false);};
  var na=document.getElementById("newa"); if(na) na.onclick=function(){createBook(true);};
  var an=document.getElementById("auto-new"); if(an) an.onclick=function(){createBook(false,"auto");};
  document.querySelectorAll("[data-open]").forEach(function(a){a.onclick=function(e){e.preventDefault(); openBook(a.getAttribute("data-open"));};});
  document.querySelectorAll("[data-del]").forEach(function(a){a.onclick=async function(){if(!confirm("Wirklich löschen?"))return; await api("/api/books/"+a.getAttribute("data-del"),{method:"DELETE"}); await loadBooks();};});
  var ate=document.getElementById("auto-toedit"); if(ate) ate.onclick=function(){go("edit");};
  var toauto=document.getElementById("toauto"); if(toauto) toauto.onclick=function(){go("auto");};
  if(VIEW==="auto" && BOOK){
    var at=document.getElementById("a_title"); if(at) at.oninput=function(){BOOK.title=at.value; scheduleSave();};
    var ag=document.getElementById("a_genre"); if(ag) ag.oninput=function(){BOOK.genre=ag.value; scheduleSave();};
    var ao=document.getElementById("a_outline"); if(ao) ao.oninput=function(){BOOK.outline=ao.value; scheduleSave();};
    var aad=document.getElementById("a_adult"); if(aad) aad.onchange=function(){BOOK.isAdult=aad.checked; scheduleSave();};
    var addc=document.getElementById("addchar"); if(addc) addc.onclick=function(){BOOK.characters=BOOK.characters||[]; BOOK.characters.push({name:"",role:"",traits:""}); scheduleSave(); render();};
    document.querySelectorAll("[data-cdel]").forEach(function(b){b.onclick=function(){BOOK.characters.splice(+b.getAttribute("data-cdel"),1); scheduleSave(); render();};});
    document.querySelectorAll(".charrow").forEach(function(row){var ci=+row.getAttribute("data-ci"); row.querySelectorAll("[data-cf]").forEach(function(inp){inp.oninput=function(){BOOK.characters[ci][inp.getAttribute("data-cf")]=inp.value; scheduleSave();};});});
    var ago=document.getElementById("a_go"); if(ago) ago.onclick=runAutopilot;
  }

  var title=document.getElementById("title"); if(title) title.oninput=function(){BOOK.title=title.value; scheduleSave();};
  ["author","dedf","dedt"].forEach(function(id){var e=document.getElementById(id); if(e) e.oninput=function(){ if(id==="author")BOOK.authorName=e.value; if(id==="dedf")BOOK.dedicationFrom=e.value; if(id==="dedt")BOOK.dedicationTo=e.value; scheduleSave(); };});
  var body=document.getElementById("body");
  if(body){body.oninput=function(){ BOOK.pages[ACTIVE].body=body.value; var next=paginate(BOOK.pages.map(function(p){return p.body||"";}),ACTIVE), overflow=!fits(body.value); BOOK.pages=next.map(function(t,i){return {id:(BOOK.pages[i]&&BOOK.pages[i].id)||crypto.randomUUID(),body:t,imageUrl:(BOOK.pages[i]&&BOOK.pages[i].imageUrl)||"",imagePrompt:(BOOK.pages[i]&&BOOK.pages[i].imagePrompt)||""};}); scheduleSave(); if(overflow){ ACTIVE=Math.min(ACTIVE+1, BOOK.pages.length-1); render(); var b2=document.getElementById("body"); if(b2){b2.focus(); var nn=b2.value.length; b2.selectionStart=b2.selectionEnd=nn;} } };}
  document.querySelectorAll("[data-pg]").forEach(function(b){b.onclick=function(){ACTIVE=+b.getAttribute("data-pg"); render();};});
  var addp=document.getElementById("addp"); if(addp) addp.onclick=function(){BOOK.pages.push({id:crypto.randomUUID(),body:"",imageUrl:"",imagePrompt:""}); ACTIVE=BOOK.pages.length-1; scheduleSave(); render();};
  function reflowAll(){ var blob=BOOK.pages.map(function(p){return p.body||"";}).join("\\n\\n").replace(/^\\n+|\\n+$/g,""); var next=paginate([blob],0); BOOK.pages=next.map(function(t,i){return {id:(BOOK.pages[i]&&BOOK.pages[i].id)||crypto.randomUUID(),body:t,imageUrl:(BOOK.pages[i]&&BOOK.pages[i].imageUrl)||"",imagePrompt:(BOOK.pages[i]&&BOOK.pages[i].imagePrompt)||""};}); if(ACTIVE>=BOOK.pages.length) ACTIVE=BOOK.pages.length-1; }
  var modeM=document.getElementById("modeM"); if(modeM) modeM.onclick=function(){BOOK.viewMode="manuscript"; BOOK.trimFormat="normseite"; reflowAll(); scheduleSave(); render();};
  var modeB=document.getElementById("modeB"); if(modeB) modeB.onclick=function(){BOOK.viewMode="book"; if(!BOOK.trimFormat||BOOK.trimFormat==="normseite") BOOK.trimFormat="a5"; reflowAll(); scheduleSave(); render();};
  var trim=document.getElementById("trim"); if(trim) trim.onchange=function(){ BOOK.trimFormat=trim.value; BOOK.viewMode=trim.value==="normseite"?"manuscript":"book"; reflowAll(); scheduleSave(); render(); };
  var bleed=document.getElementById("bleed"); if(bleed) bleed.onchange=function(){ BOOK.bleedMm=Math.max(0,Math.min(20,bleed.value|0||3)); scheduleSave(); render(); };
  var pnpos=document.getElementById("pnpos"); if(pnpos) pnpos.onchange=function(){ BOOK.pageNumberPos=pnpos.value; BOOK.pageNumberVisible=pnpos.value!=="hidden"; scheduleSave(); render(); };
  var cw=document.getElementById("cw"); if(cw) cw.onchange=function(){ BOOK.customWidthMm=Math.max(80,cw.value|0||148); reflowAll(); scheduleSave(); render(); };
  var ch=document.getElementById("ch"); if(ch) ch.onchange=function(){ BOOK.customHeightMm=Math.max(100,ch.value|0||210); reflowAll(); scheduleSave(); render(); };
  var doprint=document.getElementById("doprint"); if(doprint) doprint.onclick=printAll;
  var dosend=document.getElementById("dosend"); if(dosend) dosend.onclick=async function(){
    var to=document.getElementById("sendto").value.trim(); var m=document.getElementById("sendmsg");
    if(!to){ m.className="alert-error"; m.textContent="Bitte Empfänger-E-Mail eingeben."; return; }
    m.className="muted"; m.textContent="PDF wird erstellt …"; dosend.disabled=true;
    try{
      await persist(); // sicherstellen, dass der neueste Stand gespeichert ist
      var b64=await buildBookPdfBase64();
      m.textContent="Wird versendet …";
      var d=await api("/api/books/send",{method:"POST",body:JSON.stringify({bookId:BOOK.id,toEmail:to,pdfBase64:b64})});
      m.className="alert-ok"; m.textContent=d.mailed?("Gesendet an "+to+" (Link 7 Tage gültig)."):("Gespeichert, aber E-Mail-Versand ist nicht konfiguriert. Link: "+d.link);
    }catch(err){ m.className="alert-error"; m.textContent=err.message; }
    finally{ dosend.disabled=false; }
  };
  var prev=document.getElementById("prev"); if(prev) prev.onclick=showPreview;
  var ifill=document.getElementById("ifill"); if(ifill) ifill.onclick=function(){ var pi=+(document.getElementById("ipage").value||ACTIVE); var t=(BOOK.pages[pi]&&BOOK.pages[pi].body||"").slice(0,600); document.getElementById("iprompt").value=t; };
  var gojump=document.getElementById("gojump"); if(gojump) gojump.onclick=function(){ var nn=parseInt(document.getElementById("jump").value,10); if(!nn||nn<1) nn=1; if(nn>BOOK.pages.length) nn=BOOK.pages.length; ACTIVE=nn-1; render(); };
  var jump=document.getElementById("jump"); if(jump) jump.onkeydown=function(e){ if(e.key==="Enter"){ e.preventDefault(); gojump && gojump.click(); } };
  document.querySelectorAll(".bodytxt[data-pg], article.sheet[data-pg], .bleed[data-pg]").forEach(function(el){ el.onclick=function(){ var nn=+el.getAttribute("data-pg"); if(!isNaN(nn) && nn!==ACTIVE){ ACTIVE=nn; render(); } }; });
  document.querySelectorAll(".sent").forEach(function(s){ s.onclick=function(){ s.classList.toggle("on"); }; });
  var acc=document.getElementById("acc"); if(acc) acc.onclick=function(){ if(!PENDING||!BOOK) return; var chosen=[]; document.querySelectorAll(".sent").forEach(function(s){ var idx=+s.getAttribute("data-si"); chosen.push(s.classList.contains("on")?PENDING.pairs[idx].neu:PENDING.pairs[idx].orig); }); BOOK.pages[ACTIVE].body=chosen.join(" "); PENDING=null; scheduleSave(); render(); };
  var rej=document.getElementById("rej"); if(rej) rej.onclick=function(){ PENDING=null; render(); };
  var pwa=document.getElementById("pwa-install"); if(pwa) pwa.onclick=async function(){ if(INSTALL_EVT){ INSTALL_EVT.prompt(); await INSTALL_EVT.userChoice; INSTALL_EVT=null; return; } alert(isIOS()?"iPhone: Teilen → Zum Home-Bildschirm.":"Android Chrome: Menü ⋮ → App installieren."); };
  var quotes=document.getElementById("quotes"); if(quotes){quotes.value=BOOK&&BOOK.quotesStyle||"german"; quotes.onchange=function(){BOOK.quotesStyle=quotes.value; scheduleSave();};}
  var adult=document.getElementById("adult"); if(adult) adult.onchange=function(){BOOK.isAdult=adult.checked; scheduleSave(); render();};
  var ip=document.getElementById("iprompt"); if(ip) ip.oninput=function(){BOOK.pages[ACTIVE].imagePrompt=ip.value;};
  document.querySelectorAll("[data-act]").forEach(function(b){b.onclick=function(){act(b.getAttribute("data-act"));};});
  var mic=document.getElementById("mic"); if(mic) mic.onclick=toggleMic;
  var mic2=document.getElementById("mic2"); if(mic2) mic2.onclick=toggleMic;
  var sp=document.getElementById("speak"); if(sp) sp.onclick=speak;
  var ss=document.getElementById("stopspeak"); if(ss) ss.onclick=stopSpeak;
  if(VIEW==="konto"){
    document.querySelectorAll(".konto-subtab").forEach(function(b){ b.onclick=function(){ KONTO_SUB=b.getAttribute("data-ksub"); render(); }; });
    if(KONTO_SUB==="history") loadLedger();
    if(KONTO_SUB==="support") loadSupportHistory();
    var pf=document.getElementById("profileform");
    if(pf) pf.addEventListener("submit", async function(e){ e.preventDefault(); var m=document.getElementById("pf_msg"); try{ var d=await api("/api/account/profile",{method:"POST",body:JSON.stringify({vorname:document.getElementById("pf_vorname").value,nachname:document.getElementById("pf_nachname").value,newPassword:document.getElementById("pf_newpw").value,currentPassword:document.getElementById("pf_curpw").value})}); USER=d.user||USER; m.className="alert-ok"; m.textContent="Gespeichert."; document.getElementById("pf_newpw").value=""; document.getElementById("pf_curpw").value=""; }catch(err){ m.className="alert-error"; m.textContent=err.message; } });
    var sf=document.getElementById("supportform");
    if(sf) sf.addEventListener("submit", async function(e){ e.preventDefault(); var m=document.getElementById("sup_msg"); try{ await api("/api/account/support",{method:"POST",body:JSON.stringify({message:document.getElementById("sup_text").value})}); m.className="alert-ok"; m.textContent="Nachricht gesendet."; document.getElementById("sup_text").value=""; loadSupportHistory(); }catch(err){ m.className="alert-error"; m.textContent=err.message; } });
    var kvf=document.getElementById("kvoucher");
    if(kvf) kvf.addEventListener("submit", async function(e){ e.preventDefault(); var m=document.getElementById("kv_msg"); try{ var d=await api("/api/voucher",{method:"POST",body:JSON.stringify({code:document.getElementById("kv_code").value})}); m.className="alert-ok"; m.textContent="+"+d.added+" Tokens!"; render(); }catch(err){ m.className="alert-error"; m.textContent=err.message; } });
    document.querySelectorAll("[data-pack]").forEach(function(a){a.onclick=async function(){if(!confirm("Paket "+a.getAttribute("data-pack")+" buchen?"))return; try{await api("/api/storage",{method:"POST",body:JSON.stringify({tier:a.getAttribute("data-pack")})}); render();}catch(err){alert(err.message);}};});
    var df=document.getElementById("deleteform");
    if(df) df.addEventListener("submit", async function(e){ e.preventDefault(); var m=document.getElementById("del_msg"); if(!confirm("Konto wirklich endgültig löschen?")) return; try{ await api("/api/account/delete",{method:"POST",body:JSON.stringify({currentPassword:document.getElementById("del_pw").value,confirm:document.getElementById("del_confirm").value})}); USER=null; VIEW="guest"; BOOK=null; BOOKS=[]; render(); }catch(err){ m.className="alert-error"; m.textContent=err.message; } });
  }
  if(VIEW==="admin" && USER && USER.role==="admin") loadAdmin();
  if(VIEW==="edit"){ var live=document.getElementById("body"); if(live) live.scrollIntoView({block:"center"}); }
}
async function go(v){ if(!USER){ VIEW="guest"; render(); return; } if(v==="admin" && USER.role!=="admin"){ VIEW="desk"; render(); return; } VIEW=v; MSG=""; if(v==="desk") await loadBooks(); if((v==="edit"||v==="auto") && !BOOK){ await loadBooks(); if(BOOKS[0]) await openBook(BOOKS[0].id,v); else { await createBook(false,v); return; } } render(); }
async function loadBooks(){ var d=await api("/api/books"); BOOKS=d.books||[]; render(); }
async function createBook(adult,view){ var d=await api("/api/books",{method:"POST",body:JSON.stringify({title:adult?"Adult-Manuskript":"Ohne Titel",isAdult:adult})}); await openBook(d.id,view||"edit"); }
async function openBook(id,view){ var d=await api("/api/books/"+id); BOOK=d.book; if(!BOOK.characters) BOOK.characters=[]; ACTIVE=0; VIEW=view||"edit"; render(); }
function scheduleSave(){ var st=document.getElementById("savestate"); if(st) st.textContent="Speichert …"; clearTimeout(SAVE); SAVE=setTimeout(persist,400); try{ localStorage.setItem("sb:"+BOOK.id, JSON.stringify(BOOK)); }catch(e){} }
async function persist(){ if(!BOOK) return; try{ await api("/api/books/"+BOOK.id,{method:"PUT",body:JSON.stringify(BOOK)}); var st=document.getElementById("savestate"); if(st) st.textContent="Gespeichert"; var t=document.getElementById("tk_sidebar_tokens"); if(t && USER) t.textContent=(USER.tokens|0)+" Tokens"; }catch(e){ var st=document.getElementById("savestate"); if(st) st.textContent=e.message; } }

async function runAutopilot(){
  MSG=""; WORK="Autopilot schreibt ein Kapitel …"; var btn=document.getElementById("a_go"); if(btn){btn.disabled=true; btn.textContent="Schreibt …";} render();
  try{
    var prev=BOOK.pages.map(function(p){return p.body||"";}).join("\\n\\n").slice(-4000);
    var d=await api("/api/autopilot",{method:"POST",body:JSON.stringify({ title:BOOK.title,genre:BOOK.genre,outline:BOOK.outline,characters:BOOK.characters||[], chapterGoal:document.getElementById("a_goal").value, pages:document.getElementById("a_pages").value, modelId:document.getElementById("a_model").value, isAdult:!!BOOK.isAdult, previousContext:prev })});
    var texts=BOOK.pages.map(function(p){return p.body||"";}); var last=texts.length-1;
    texts[last]=(texts[last]||"").replace(/\\s+$/,"")+(texts[last].trim()?"\\n\\n":"")+d.chapter;
    var next=paginate(texts,last);
    BOOK.pages=next.map(function(tx,i){return {id:(BOOK.pages[i]&&BOOK.pages[i].id)||crypto.randomUUID(),body:tx,imageUrl:(BOOK.pages[i]&&BOOK.pages[i].imageUrl)||"",imagePrompt:(BOOK.pages[i]&&BOOK.pages[i].imagePrompt)||""};});
    WORK="Kapitel erzeugt und angehängt."; scheduleSave(); ACTIVE=BOOK.pages.length-1; VIEW="edit"; render();
  }catch(e){ WORK=null; MSG=e.message; render(); }
}
function showPreview(){
  if(!BOOK) return;
  var pagesHtml=BOOK.pages.map(function(pg){ return '<div style="margin-bottom:28px;white-space:pre-wrap">'+esc(applyQuotes(pg.body||"",BOOK.quotesStyle||"german"))+'</div>'; }).join("");
  var cover='<div style="text-align:center;padding:40px 0;border-bottom:1px solid #ccc;margin-bottom:28px"><h2 style="font-size:24pt">'+esc(BOOK.title||"Ohne Titel")+'</h2>'+(BOOK.authorName?'<div style="margin-top:10px">'+esc(BOOK.authorName)+'</div>':'')+(BOOK.dedicationTo?'<div style="margin-top:24px;font-style:italic">'+esc(BOOK.dedicationTo)+'</div>':'')+'</div>';
  document.getElementById("ovlbox").innerHTML='<div class="ovl" id="ovl"><div class="inner"><button class="sm" type="button" id="closeprev" style="float:right;background:#1a1612;color:#fff">Schließen</button>'+cover+pagesHtml+'</div></div>';
  document.getElementById("closeprev").onclick=function(){ document.getElementById("ovlbox").innerHTML=""; };
  document.getElementById("ovl").onclick=function(e){ if(e.target.id==="ovl") document.getElementById("ovlbox").innerHTML=""; };
}
function speak(){ if(!window.speechSynthesis){ alert("Vorlesen wird von diesem Browser nicht unterstützt."); return; } var txt=BOOK.pages.map(function(p){return p.body||"";}).join("\\n\\n").trim(); if(!txt){ alert("Kein Text zum Vorlesen."); return; } var u=new SpeechSynthesisUtterance(txt.slice(0,32000)); u.lang="de-DE"; u.rate=1; window.speechSynthesis.cancel(); window.speechSynthesis.speak(u); }
function stopSpeak(){ if(window.speechSynthesis) window.speechSynthesis.cancel(); }
function printAll(){
  if(!BOOK) return; var L=trimMetrics(); var isBook=BOOK.viewMode==="book" && (BOOK.trimFormat||"normseite")!=="normseite";
  var css="body{margin:0;background:#fff;color:#111} .pg{page-break-after:always;box-sizing:border-box;overflow:hidden;position:relative;";
  if(isBook) css+="width:"+L.w+"mm;height:"+L.h+"mm;padding:"+L.mt+"mm "+L.mr+"mm "+L.mb+"mm "+L.ml+"mm;font:12.5pt/1.55 Georgia,serif;text-align:justify;}";
  else css+="width:210mm;height:297mm;padding:25mm 20mm;font:12pt/1.5 'Courier New',Courier,monospace;}";
  css+=" .pg:last-child{page-break-after:auto} .n{position:absolute;font:10pt Georgia,serif;width:100%;text-align:center;bottom:12mm;left:0}";
  css+=" .cover{display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center} .cover h1{font-size:26pt;margin:0 0 16pt} .cover .au{font-size:14pt} .cover .ded{font-style:italic;margin-top:40pt}";
  css+=" @page{size:"+(isBook?(L.w+"mm "+L.h+"mm"):"A4 portrait")+";margin:0}";
  var html="<!DOCTYPE html><html><head><meta charset=utf-8><title>"+esc(BOOK.title||"Manuskript")+"</title><style>"+css+"</style></head><body>";
  html+='<div class="pg cover"><h1>'+esc(BOOK.title||"Ohne Titel")+'</h1>'+(BOOK.authorName?'<div class="au">'+esc(BOOK.authorName)+'</div>':'')+(BOOK.dedicationTo?'<div class="ded">'+esc(BOOK.dedicationTo)+'</div>':'')+'</div>';
  if(BOOK.imprint){ html+='<div class="pg"><div style="font:10pt Georgia,serif;white-space:pre-wrap">'+esc(BOOK.imprint)+'</div></div>'; }
  BOOK.pages.forEach(function(pg,i){ var txt=applyQuotes(pg.body||"", BOOK.quotesStyle||"german"); var hide=BOOK.pageNumberPos==="hidden"||BOOK.pageNumberVisible===false; html+='<div class="pg">'+(hide?"":'<div class="n">'+(i+1)+"</div>")+esc(txt).replace(/\\n/g,"<br/>")+"</div>"; });
  html+="</body></html>";
  var w=window.open("","_blank"); if(!w){ alert("Pop-ups erlauben, dann nochmal auf PDF."); return; } w.document.write(html); w.document.close(); w.focus(); setTimeout(function(){ w.print(); }, 300);
}
// ===== Modul 5: Echtes, vektorbasiertes Text-PDF (auswählbarer Text, klein, schnell) =====
// Baut ein PDF mit echtem Text (Helvetica, Standard-Core-Font, kein Font-Embedding nötig).
// Bilder pro Seite werden – falls vorhanden – als JPEG-XObject eingebettet; der Text bleibt echter Text.
// Rückgabe: Base64-String (ohne data:-Präfix), identische Signatur wie die alte Raster-Funktion.
async function buildBookPdfBase64(){
  var L = trimMetrics();
  // Seitenmaße in PDF-Punkten (1 mm = 2.83465 pt). Normseite => A4, sonst Trim-Format.
  var MM = 2.83465;
  var isBook = BOOK.viewMode === "book" && (BOOK.trimFormat || "normseite") !== "normseite";
  var pageW = Math.round((isBook ? L.w : 210) * MM);
  var pageH = Math.round((isBook ? L.h : 297) * MM);
  var mL = Math.round((isBook ? L.ml : 20) * MM);
  var mR = Math.round((isBook ? L.mr : 20) * MM);
  var mT = Math.round((isBook ? L.mt : 25) * MM);
  var mB = Math.round((isBook ? L.mb : 25) * MM);
  var fontSize = 11, lineH = Math.round(fontSize * 1.5);
  var textW = pageW - mL - mR;
  var pnHide = BOOK.pageNumberPos === "hidden" || BOOK.pageNumberVisible === false;

  var pdf = new PdfDoc(pageW, pageH);

  // --- Deckblatt ---
  pdf.newPage();
  var cx = pageW / 2;
  pdf.textCenter((BOOK.title || "Ohne Titel"), cx, Math.round(pageH * 0.40), 24, true);
  if (BOOK.authorName) pdf.textCenter(BOOK.authorName, cx, Math.round(pageH * 0.40) + 46, 14, false);
  if (BOOK.dedicationTo) pdf.textCenter(BOOK.dedicationTo, cx, Math.round(pageH * 0.60), 12, false, true);

  // --- Impressum (optional) ---
  if (BOOK.imprint) {
    pdf.newPage();
    pdf.paragraph(String(BOOK.imprint), mL, mT, textW, 10, Math.round(10 * 1.4));
  }

  // --- Textseiten ---
  for (var pi = 0; pi < BOOK.pages.length; pi++) {
    pdf.newPage();
    var y = mT;
    var txt = applyQuotes(BOOK.pages[pi].body || "", BOOK.quotesStyle || "german");

    // Optionales Seitenbild zuerst oben einbetten (als JPEG), Text fließt darunter weiter.
    if (BOOK.pages[pi].imageUrl) {
      try {
        var jpg = await imageToJpegBytes(BOOK.pages[pi].imageUrl, 900);
        if (jpg) {
          var drawW = textW;
          var drawH = Math.round(drawW * (jpg.h / jpg.w));
          var maxH = Math.round((pageH - mT - mB) * 0.45);
          if (drawH > maxH) { drawH = maxH; drawW = Math.round(drawH * (jpg.w / jpg.h)); }
          pdf.image(jpg, mL, y, drawW, drawH);
          y += drawH + lineH;
        }
      } catch (e) {}
    }

    // Absätze per Zeilenumbruch aufteilen und zeilenweise umbrechen.
    var paras = String(txt).split("\\n");
    for (var a = 0; a < paras.length; a++) {
      var words = paras[a].split(/\\s+/).filter(function(w){ return w.length; });
      if (!words.length) { y += lineH; if (y > pageH - mB) { finishPageNumber(); pdf.newPage(); y = mT; } continue; }
      var line = "";
      for (var wi = 0; wi < words.length; wi++) {
        var test = line ? (line + " " + words[wi]) : words[wi];
        if (pdf.textWidth(test, fontSize) > textW && line) {
          pdf.text(line, mL, y, fontSize);
          y += lineH;
          line = words[wi];
          if (y > pageH - mB) { finishPageNumber(); pdf.newPage(); y = mT; }
        } else {
          line = test;
        }
      }
      if (line) {
        pdf.text(line, mL, y, fontSize);
        y += lineH;
        if (y > pageH - mB) { finishPageNumber(); pdf.newPage(); y = mT; }
      }
      y += Math.round(lineH * 0.4); // Absatzabstand
    }
    finishPageNumber();
  }

  function finishPageNumber(){
    if (pnHide) return;
    var n = String(pdf.pageCountVisible());
    var pos = BOOK.pageNumberPos || "bottom-center";
    var py = pos.indexOf("top") === 0 ? Math.round(mT * 0.5) : pageH - Math.round(mB * 0.5);
    if (pos.indexOf("left") >= 0) pdf.text(n, mL, py, 9);
    else if (pos.indexOf("right") >= 0) pdf.text(n, pageW - mR - pdf.textWidth(n, 9), py, 9);
    else pdf.textCenter(n, pageW / 2, py, 9, false);
  }

  return pdf.toBase64();
}

// Lädt eine Bild-URL (auch data:) und gibt { bytes, w, h } als JPEG zurück, max. Breite maxW.
async function imageToJpegBytes(url, maxW){
  var img = new Image();
  img.crossOrigin = "anonymous";
  img.src = url;
  await img.decode();
  var scale = Math.min(1, maxW / (img.width || maxW));
  var w = Math.max(1, Math.round((img.width || maxW) * scale));
  var h = Math.max(1, Math.round((img.height || maxW) * scale));
  var c = document.createElement("canvas"); c.width = w; c.height = h;
  var ctx = c.getContext("2d"); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h); ctx.drawImage(img, 0, 0, w, h);
  var dataUrl = c.toDataURL("image/jpeg", 0.82);
  var b64 = dataUrl.split(",")[1];
  var bytes = Uint8Array.from(atob(b64), function(ch){ return ch.charCodeAt(0); });
  return { bytes: bytes, w: w, h: h };
}

// Minimaler PDF-Writer mit echtem Text (Core-Font Helvetica, WinAnsi). Kein Font-Embedding.
function PdfDoc(pageW, pageH){
  this.pageW = pageW; this.pageH = pageH;
  this.objects = [];       // index -> bytes/string
  this.pages = [];         // { content:[], images:[] }
  this.cur = null;
  this.visibleCount = 0;   // Seitenzähler ohne Deckblatt/Impressum
}
// Escaping für PDF-Textstrings (WinAnsi). Nur benötigte Sonderzeichen.
PdfDoc.prototype.esc = function(s){
  return String(s).replace(/\\\\/g, "\\\\\\\\").replace(/\\(/g, "\\\\(").replace(/\\)/g, "\\\\)");
};
// Breite in pt für Helvetica (approximiert über mittlere Zeichenbreite 0.5*fontSize – robust für Umbruch).
PdfDoc.prototype.textWidth = function(s, fs){
  // etwas genauer: schmale Zeichen zählen weniger
  var w = 0, narrow = "iljtfr.,;:'\\\"|!", wide = "mwMW@";
  for (var i = 0; i < s.length; i++){
    var c = s.charAt(i);
    if (narrow.indexOf(c) >= 0) w += 0.33; else if (wide.indexOf(c) >= 0) w += 0.80; else w += 0.52;
  }
  return w * fs;
};
PdfDoc.prototype.newPage = function(){
  this.cur = { content: [], images: [], isVisible: this.pages.length >= 1 }; // Seite 0 = Deckblatt => nicht sichtbar gezählt
  this.pages.push(this.cur);
};
// Interne Seitennummer, die Deckblatt (+ Impressum) überspringt.
PdfDoc.prototype.pageCountVisible = function(){
  this.visibleCount++;
  return this.visibleCount;
};
// PDF-Y ist von unten; wir rechnen top-basiert um.
PdfDoc.prototype._y = function(yTop){ return this.pageH - yTop; };
PdfDoc.prototype.text = function(s, x, yTop, fs){
  if (!s) return;
  this.cur.content.push("BT /F1 " + fs + " Tf 1 0 0 1 " + x + " " + (this._y(yTop) - fs) + " Tm (" + this.esc(s) + ") Tj ET");
};
PdfDoc.prototype.textCenter = function(s, cx, yTop, fs, bold, italic){
  var font = bold ? "F2" : (italic ? "F3" : "F1");
  var w = this.textWidth(s, fs);
  var x = cx - w / 2;
  this.cur.content.push("BT /" + font + " " + fs + " Tf 1 0 0 1 " + x + " " + (this._y(yTop) - fs) + " Tm (" + this.esc(s) + ") Tj ET");
};
PdfDoc.prototype.paragraph = function(s, x, yTop, w, fs, lh){
  var words = String(s).replace(/\\n/g, " \\n ").split(/\\s+/), line = "", y = yTop;
  for (var i = 0; i < words.length; i++){
    if (words[i] === "\\n") { if (line) { this.text(line, x, y, fs); y += lh; line = ""; } y += lh; continue; }
    var test = line ? line + " " + words[i] : words[i];
    if (this.textWidth(test, fs) > w && line) { this.text(line, x, y, fs); y += lh; line = words[i]; }
    else line = test;
  }
  if (line) this.text(line, x, y, fs);
};
PdfDoc.prototype.image = function(jpg, x, yTop, w, h){
  var name = "Im" + this.cur.images.length;
  this.cur.images.push({ name: name, jpg: jpg });
  var yBottom = this._y(yTop) - h;
  this.cur.content.push("q " + w + " 0 0 " + h + " " + x + " " + yBottom + " cm /" + name + " Do Q");
};
PdfDoc.prototype.toBase64 = function(){
  var enc = new TextEncoder();
  var chunks = [], offsets = [], size = 0;
  function push(v){ var b = (typeof v === "string") ? enc.encode(v) : v; chunks.push(b); size += b.length; }
  var objOffsets = {};
  function startObj(n){ objOffsets[n] = size; push(n + " 0 obj\\n"); }
  function endObj(){ push("\\nendobj\\n"); }

  push("%PDF-1.4\\n%\\u00e2\\u00e3\\u00cf\\u00d3\\n");

  // Objekt-Nummern planen:
  // 1 Catalog, 2 Pages, 3 F1(Helvetica), 4 F2(Helvetica-Bold), 5 F3(Helvetica-Oblique)
  // danach pro Seite: Page-Obj + Content-Obj + je Bild ein XObject
  var pageObjNums = [], n = 6, self = this;
  var imageObjs = []; // {num, jpg}
  this.pages.forEach(function(pg){
    var pageNum = n++; var contentNum = n++;
    var imgRefs = [];
    pg.images.forEach(function(im){ var inum = n++; imageObjs.push({ num: inum, jpg: im.jpg, name: im.name }); imgRefs.push({ num: inum, name: im.name }); });
    pageObjNums.push({ pageNum: pageNum, contentNum: contentNum, imgRefs: imgRefs, content: pg.content.join("\\n") });
  });

  startObj(1); push("<< /Type /Catalog /Pages 2 0 R >>"); endObj();
  var kids = pageObjNums.map(function(p){ return p.pageNum + " 0 R"; }).join(" ");
  startObj(2); push("<< /Type /Pages /Count " + pageObjNums.length + " /Kids [" + kids + "] >>"); endObj();
  startObj(3); push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"); endObj();
  startObj(4); push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>"); endObj();
  startObj(5); push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique /Encoding /WinAnsiEncoding >>"); endObj();

  pageObjNums.forEach(function(p){
    var xobj = p.imgRefs.map(function(r){ return "/" + r.name + " " + r.num + " 0 R"; }).join(" ");
    startObj(p.pageNum);
    push("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 " + self.pageW + " " + self.pageH + "] " +
         "/Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R >>" + (xobj ? " /XObject << " + xobj + " >>" : "") + " >> " +
         "/Contents " + p.contentNum + " 0 R >>");
    endObj();
    startObj(p.contentNum);
    var stream = p.content;
    push("<< /Length " + enc.encode(stream).length + " >>\\nstream\\n"); push(stream); push("\\nendstream");
    endObj();
  });

  imageObjs.forEach(function(im){
    startObj(im.num);
    push("<< /Type /XObject /Subtype /Image /Width " + im.jpg.w + " /Height " + im.jpg.h +
         " /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length " + im.jpg.bytes.length + " >>\\nstream\\n");
    push(im.jpg.bytes); push("\\nendstream");
    endObj();
  });

  var xrefStart = size;
  var maxN = n - 1;
  push("xref\\n0 " + (maxN + 1) + "\\n0000000000 65535 f \\n");
  for (var i = 1; i <= maxN; i++){
    var off = objOffsets[i] || 0;
    push(String(off).padStart(10, "0") + " 00000 n \\n");
  }
  push("trailer\\n<< /Size " + (maxN + 1) + " /Root 1 0 R >>\\nstartxref\\n" + xrefStart + "\\n%%EOF");

  // chunks -> ein Uint8Array -> Base64
  var total = new Uint8Array(size), pos = 0;
  chunks.forEach(function(c){ total.set(c, pos); pos += c.length; });
  var bin = "";
  for (var k = 0; k < total.length; k += 0x8000) bin += String.fromCharCode.apply(null, total.subarray(k, k + 0x8000));
  return btoa(bin);
}
function toggleMic(){
  var Rec=window.SpeechRecognition||window.webkitSpeechRecognition; if(!Rec){ alert("Diktieren geht in Chrome oder Safari."); return; }
  if(MIC){ MIC.stop(); MIC=null; var b=document.getElementById("mic"); if(b) b.textContent="Diktieren"; var b2=document.getElementById("mic2"); if(b2) b2.textContent="Diktieren (0 Token)"; return; }
  MIC=new Rec(); MIC.lang="de-DE"; MIC.continuous=true; MIC.interimResults=false;
  MIC.onresult=function(ev){ var i,t=""; for(i=ev.resultIndex;i<ev.results.length;i++) if(ev.results[i].isFinal) t+=ev.results[i][0].transcript; if(!t||!BOOK) return; var page=BOOK.pages[ACTIVE]; page.body=((page.body||"")+" "+t).replace(/\\s+/g," ").trim(); var next=paginate(BOOK.pages.map(function(p){return p.body||"";}),ACTIVE); BOOK.pages=next.map(function(tx,i){return {id:(BOOK.pages[i]&&BOOK.pages[i].id)||crypto.randomUUID(),body:tx,imageUrl:(BOOK.pages[i]&&BOOK.pages[i].imageUrl)||"",imagePrompt:(BOOK.pages[i]&&BOOK.pages[i].imagePrompt)||""};}); scheduleSave(); render(); };
  MIC.onend=function(){ MIC=null; var b=document.getElementById("mic"); if(b) b.textContent="Diktieren"; var b2=document.getElementById("mic2"); if(b2) b2.textContent="Diktieren (0 Token)"; };
  MIC.start(); var b=document.getElementById("mic"); if(b) b.textContent="Aufnahme läuft — tippen zum Stoppen"; var b2=document.getElementById("mic2"); if(b2) b2.textContent="Aufnahme läuft";
}
async function act(kind){
  MSG=""; var page=BOOK.pages[ACTIVE];
  try{
    if(kind==="spell"){ WORK="Wird korrigiert …"; render(); var d=await api("/api/spell",{method:"POST",body:JSON.stringify({text:page.body||""})}); page.body=d.corrected; WORK=null; scheduleSave(); render(); }
    else if(kind==="syn"){
      var ta=document.getElementById("body"), w="", t=page.body||"";
      if(ta){ var s=ta.selectionStart, e=ta.selectionEnd; w=t.slice(s,e).trim(); if(!w){ var a=s,b=e; while(a>0&&/[A-Za-zÄÖÜäöüß-]/.test(t.charAt(a-1))) a--; while(b<t.length&&/[A-Za-zÄÖÜäöüß-]/.test(t.charAt(b))) b++; w=t.slice(a,b);} }
      if(!w) throw new Error("Wort markieren oder Cursor ins Wort.");
      WORK="Synonyme …"; render(); var d=await api("/api/synonyms",{method:"POST",body:JSON.stringify({word:w})}); WORK=null; render();
      var box=document.getElementById("synbox"); if(box) box.innerHTML='<p class="muted">Synonyme für '+esc(w)+'</p>'+(d.list||[]).map(function(x){return '<button class="ghost sm" type="button" data-syn="'+esc(x)+'">'+esc(x)+'</button>';}).join(" ");
      document.querySelectorAll("[data-syn]").forEach(function(b){b.onclick=function(){ page.body=(page.body||"").replace(w, b.getAttribute("data-syn")); scheduleSave(); render(); };});
    }
    else if(kind==="imp"){ WORK="Lektorat-Vorschlag wird geholt …"; render(); var mdl=(document.getElementById("cmodel")||{}).value; var d=await api("/api/improve",{method:"POST",body:JSON.stringify({text:page.body||"",modelId:mdl})}); WORK=null; PENDING={pairs:d.pairs||[]}; render(); }
    else if(kind==="cont"){
      WORK="KI schreibt weiter …"; render(); var mdl=(document.getElementById("cmodel")||{}).value, pg=(document.getElementById("cpages")||{}).value||"1";
      var d=await api("/api/continue",{method:"POST",body:JSON.stringify({text:page.body||"",pages:pg,modelId:mdl,isAdult:!!BOOK.isAdult})});
      var texts=BOOK.pages.map(function(p){return p.body||"";}); texts[ACTIVE]=(texts[ACTIVE]||"").replace(/\\s+$/,"")+"\\n\\n"+d.continuation;
      var next=paginate(texts, ACTIVE); BOOK.pages=next.map(function(tx,i){return {id:(BOOK.pages[i]&&BOOK.pages[i].id)||crypto.randomUUID(),body:tx,imageUrl:(BOOK.pages[i]&&BOOK.pages[i].imageUrl)||"",imagePrompt:(BOOK.pages[i]&&BOOK.pages[i].imagePrompt)||""};});
      WORK=null; scheduleSave(); render();
    }
    else if(kind==="img"){
      var model=document.getElementById("imodel").value, pi=+(document.getElementById("ipage").value||ACTIVE);
      var prompt=(document.getElementById("iprompt").value||(BOOK.pages[pi]&&BOOK.pages[pi].body)||"").slice(0,1200);
      if(!prompt.trim()) throw new Error("Bitte Prompt oder „Aus Seiteninhalt“ nutzen.");
      WORK="Bild entsteht für Seite "+(pi+1)+" …"; render();
      var d=await api("/api/image",{method:"POST",body:JSON.stringify({prompt:prompt,modelId:model,isAdult:!!BOOK.isAdult})});
      BOOK.pages[pi].imageUrl=d.url; BOOK.pages[pi].imagePrompt=prompt; WORK="Bild auf Seite "+(pi+1)+" eingebaut."; scheduleSave(); render();
    }
    else if(kind==="quotes"){ BOOK.pages=BOOK.pages.map(function(p){return Object.assign({},p,{body:applyQuotes(p.body||"", BOOK.quotesStyle||"german")});}); scheduleSave(); render(); }
  }catch(e){ WORK=null; MSG=e.message; render(); }
}
async function loadLedger(){
  try{
    var d=await api("/api/ledger"); var rows=d.rows||[]; var byMonth={};
    rows.forEach(function(r){ var m=new Date(r.created_at).toLocaleDateString("de-DE",{year:"numeric",month:"long"}); (byMonth[m]=byMonth[m]||[]).push(r); });
    var html=Object.keys(byMonth).map(function(m){ var sum=byMonth[m].reduce(function(n,r){return n+r.token_amount;},0); return '<div style="margin-top:14px"><h3 style="margin:0 0 6px">'+esc(m)+' <span class="muted" style="font-weight:normal">('+(sum>0?"+":"")+sum+' Tokens netto)</span></h3>'+byMonth[m].map(function(r){return '<div style="display:flex;justify-content:space-between;border-bottom:1px solid var(--border-color);padding:7px 0"><span>'+esc(r.description)+'<div class="muted">'+esc(r.action_type)+' · '+new Date(r.created_at).toLocaleString("de-DE")+'</div></span><b style="color:'+(r.token_amount>0?"#4ade80":"#f87171")+'">'+(r.token_amount>0?"+":"")+r.token_amount+'</b></div>';}).join("")+'</div>'; }).join("")||"Noch keine Buchungen.";
    document.getElementById("ledger").innerHTML=html;
  }catch(e){}
}
async function loadSupportHistory(){
  var box=document.getElementById("sup_history"); if(!box) return;
  try{
    var d=await api("/api/account/messages"); var rows=d.messages||[];
    if(!rows.length){ box.className=""; box.innerHTML='<p class="muted">Noch keine Nachrichten.</p>'; return; }
    box.className="";
    box.innerHTML=rows.map(function(r){ var mine=r.sender==="user"; return '<div style="border:1px solid var(--border-color);border-radius:8px;padding:10px;margin-bottom:8px;background:'+(mine?"#1a1a22":"#13281e")+'"><div class="muted" style="font-size:12px">'+(mine?"Du":"🛠️ Support")+' · '+new Date(r.created_at).toLocaleString("de-DE")+'</div><div style="white-space:pre-wrap;margin-top:4px">'+esc(r.message)+'</div></div>'; }).join("");
  }catch(e){ box.className="alert-error"; box.textContent=e.message; }
}
async function loadAdmin(){
  var box=document.getElementById("adminbox"); if(!box) return;
  try{
    var d=await api("/api/admin");
    var dbnote=d.central_db?'<p class="alert-ok">Zentrale DB (VOUCHERS_DB) verbunden ✓</p>':'<p class="alert-error">⚠️ VOUCHERS_DB (schwarzdichter-zentrale-db) ist NICHT gebunden – Gutscheine/Preise laufen gerade über die lokale DB.</p>';
    var cost='<h3>💰 Kosten-Dashboard (letzte 24 h)</h3><table class="tbl"><tr><th>Anbieter</th><th>Modell</th><th>Aktion</th><th>Aufrufe</th><th>Ist $</th><th>Ist-Tokens</th><th>Einnahmen</th><th>Marge</th><th>%</th></tr>'+(d.cost24||[]).map(function(r){return '<tr><td>'+esc(r.provider)+'</td><td>'+esc(r.model_name)+'</td><td>'+esc(r.action)+'</td><td>'+r.calls+'</td><td style="color:#4ade80">'+(r.hasCost?"$"+r.usd.toFixed(4):"—")+'</td><td style="color:#fbbf24">'+(r.hasCost?r.costTokens:"—")+'</td><td style="color:#f87171">'+r.income+'</td><td style="color:'+(r.margin==null?"#777":r.margin>=0?"#4ade80":"#f87171")+'">'+(r.margin==null?"—":(r.margin>=0?"+":"")+r.margin)+'</td><td style="color:'+(r.pct==null?"#777":r.pct>=50?"#4ade80":"#fbbf24")+'">'+(r.pct==null?"—":r.pct+"%")+'</td></tr>';}).join("")+'</table>';
    if(!(d.cost24||[]).length) cost='<h3>💰 Kosten-Dashboard (letzte 24 h)</h3><p class="muted">Noch keine KI-Aufrufe protokolliert.</p>';
    var econ='<h3 style="margin-top:22px">☁️ Speicher-/R2-Kalkulation & Marge</h3><p class="muted">Bilder über Venice, Grok, Runware und Fal.ai – je nach Anbieter-Schalter.</p><table class="tbl"><tr><th>Paket</th><th>GB</th><th>R2-Kosten/Jahr $</th><th>Ist-Tokens</th><th>Verkauf</th><th>Marge</th><th>%</th></tr>'+(d.storageEcon||[]).map(function(s){return '<tr><td>'+esc(s.label)+'</td><td>'+s.gb+'</td><td style="color:#4ade80">$'+s.costUsd+'</td><td style="color:#fbbf24">'+s.costTokens+'</td><td>'+s.tokens+'</td><td style="color:'+(s.margin>=0?"#4ade80":"#f87171")+'">'+(s.margin>=0?"+":"")+s.margin+'</td><td style="color:'+(s.pct>=50?"#4ade80":"#fbbf24")+'">'+(s.pct>=0?"+":"")+s.pct+'%</td></tr>';}).join("")+'</table>';
    var venice='<h3 style="margin-top:22px">🔎 Venice Live-Preise</h3><button class="ghost sm" type="button" id="vprices">Aktuelle Venice-Preise abrufen</button><div id="vbox" class="muted" style="margin-top:8px"></div>';
    var prices='<h3 style="margin-top:22px">⚙️ Zentrale Tokenpreise & Pausen (central_model_prices)</h3><p class="muted">Preise unter dem Margen-Floor (≥50 %) werden abgelehnt.</p><table class="tbl"><tr><th>Art</th><th>Modell</th><th>Anbieter</th><th>Preis</th><th>Min</th><th>Aktiv</th><th></th></tr>'+(d.central||[]).map(function(m){return '<tr data-mk="'+m.kind+'|'+m.id+'"><td>'+m.kind+'</td><td>'+esc(m.name)+(m.uncensored?" 🔓":"")+'</td><td>'+esc(m.provider)+'</td><td><input type="number" value="'+m.tokens+'" data-pk-cost style="width:80px;margin:0;padding:6px"/></td><td class="muted">'+m.floor+'</td><td style="text-align:center"><input type="checkbox" '+(m.active?"checked":"")+' data-pk-active/></td><td><button class="ghost sm" type="button" data-pk-save="'+m.kind+'|'+m.id+'">Speichern</button></td></tr>';}).join("")+'</table>';
    var wallets='<h3 style="margin-top:22px">👥 Nutzer ('+(d.wallets||[]).length+') · '+d.bookCount+' Manuskripte</h3><table class="tbl"><tr><th>E-Mail</th><th>Tokens</th><th>Rolle</th><th>+/-</th></tr>'+(d.wallets||[]).map(function(w){return '<tr><td>'+esc(w.user_email)+'</td><td>'+w.token_balance+'</td><td>'+esc(w.role)+'</td><td><input type="number" value="0" data-adj="'+esc(w.user_email)+'" style="width:70px;margin:0;padding:6px"/><button class="ghost sm" type="button" data-adjgo="'+esc(w.user_email)+'">OK</button></td></tr>';}).join("")+'</table>';
    var providers='<h3 style="margin-top:22px">🔌 Anbieter-Schalter (Bild & Text)</h3><p class="muted">Pausiert alle Modelle eines Anbieters auf einmal. Einzelne Modelle schaltest du unten unter „Zentrale Tokenpreise & Pausen".</p><div style="display:grid;gap:8px;grid-template-columns:repeat(auto-fit,minmax(200px,1fr))">'+(d.providers||[]).map(function(pv){return '<div style="display:flex;justify-content:space-between;align-items:center;background:#121216;border:1px solid var(--border-color);border-radius:8px;padding:10px 12px"><span><b>'+esc(pv.provider)+'</b><br><span class="muted" style="font-size:12px">'+(pv.active?'🟢 Aktiv':'🔴 Pausiert')+'</span></span><button class="ghost sm" type="button" data-prov="'+esc(pv.provider)+'" data-provnext="'+(pv.active?0:1)+'">'+(pv.active?'Pausieren':'Aktivieren')+'</button></div>';}).join("")+'</div>';
    var support='<h3 style="margin-top:22px">📨 Support-Nachrichten (eingeloggte Nutzer)</h3>'+((d.supportMsgs||[]).length?('<table class="tbl"><tr><th>Von</th><th>Absender</th><th>Nachricht</th><th>Zeit</th><th>Antwort</th></tr>'+(d.supportMsgs||[]).map(function(r){return '<tr><td>'+esc(r.user_email)+'</td><td>'+(r.sender==="user"?"Kunde":"Admin")+'</td><td style="max-width:320px;white-space:pre-wrap">'+esc(r.message)+'</td><td class="muted">'+new Date(r.created_at).toLocaleString("de-DE")+'</td><td>'+(r.sender==="user"?'<button class="ghost sm" type="button" data-reply="'+esc(r.user_email)+'">Antworten</button>':'')+'</td></tr>';}).join("")+'</table>'):'<p class="muted">Keine Support-Nachrichten.</p>');
    var feedback='<h3 style="margin-top:22px">💬 Gäste-Feedback (Footer-Formular)</h3>'+((d.feedbackMsgs||[]).length?('<table class="tbl"><tr><th>Name</th><th>E-Mail</th><th>Nachricht</th><th>Zeit</th><th></th></tr>'+(d.feedbackMsgs||[]).map(function(r){return '<tr><td>'+esc(r.name||"—")+'</td><td>'+esc(r.email||"—")+'</td><td style="max-width:320px;white-space:pre-wrap">'+esc(r.message)+'</td><td class="muted">'+new Date(r.created_at).toLocaleString("de-DE")+'</td><td><button class="ghost sm" type="button" data-fbdel="'+esc(r.id)+'">🗑️</button></td></tr>';}).join("")+'</table>'):'<p class="muted">Kein Feedback.</p>');
    box.innerHTML=dbnote+cost+econ+providers+support+feedback+venice+prices+wallets;
    document.querySelectorAll("[data-reply]").forEach(function(btn){ btn.onclick=async function(){ var target=btn.getAttribute("data-reply"); var msg=prompt("Antwort an "+target+":"); if(!msg) return; try{ await api("/api/admin/reply",{method:"POST",body:JSON.stringify({email:target,message:msg})}); alert("Antwort gesendet."); loadAdmin(); }catch(e){ alert(e.message); } }; });
    document.querySelectorAll("[data-fbdel]").forEach(function(btn){ btn.onclick=async function(){ if(!confirm("Feedback löschen?")) return; try{ await api("/api/admin/feedback-delete",{method:"POST",body:JSON.stringify({id:btn.getAttribute("data-fbdel")})}); loadAdmin(); }catch(e){ alert(e.message); } }; });
    document.querySelectorAll("[data-prov]").forEach(function(btn){ btn.onclick=async function(){ try{ await api("/api/admin/provider-switch",{method:"POST",body:JSON.stringify({provider:btn.getAttribute("data-prov"),active:btn.getAttribute("data-provnext")==="1"})}); loadAdmin(); }catch(e){ alert(e.message); } }; });
    var vb=document.getElementById("vprices"); if(vb) vb.onclick=async function(){ document.getElementById("vbox").textContent="Lädt …"; try{ var v=await api("/api/admin/venice-prices"); document.getElementById("vbox").innerHTML='<table class="tbl"><tr><th>Modell</th><th>Typ</th><th>Preis (roh)</th></tr>'+(v.models||[]).map(function(m){return '<tr><td>'+esc(m.id)+'</td><td>'+esc(m.type)+'</td><td style="font-family:monospace;font-size:11px">'+esc(JSON.stringify(m.pricing||{}))+'</td></tr>';}).join("")+'</table>'; }catch(e){ document.getElementById("vbox").textContent=e.message; } };
    document.querySelectorAll("[data-pk-save]").forEach(function(btn){ btn.onclick=async function(){ var tr=btn.closest("tr"); var mk=btn.getAttribute("data-pk-save").split("|"); var cost=tr.querySelector("[data-pk-cost]").value|0; var active=tr.querySelector("[data-pk-active]").checked; try{ await api("/api/admin/model-price",{method:"POST",body:JSON.stringify({kind:mk[0],id:mk[1],tokenCost:cost,active:active})}); btn.textContent="✓"; setTimeout(function(){btn.textContent="Speichern";},1200); }catch(e){ alert(e.message); } }; });
    document.querySelectorAll("[data-adjgo]").forEach(function(btn){ btn.onclick=async function(){ var em=btn.getAttribute("data-adjgo"); var delta=document.querySelector('[data-adj="'+em.replace(/"/g,'\\\\"')+'"]').value|0; try{ await api("/api/admin/adjust",{method:"POST",body:JSON.stringify({email:em,delta:delta})}); loadAdmin(); }catch(e){ alert(e.message); } }; });
  }catch(e){ box.textContent=e.message; }
}
(async function(){
  try{ var d=await api("/api/me"); SITEKEY=d.turnstileSiteKey||""; TMODELS=d.textModels||[]; IMODELS=d.imageModels||[]; USER=d.user; VIEW=USER?"desk":"guest"; }
  catch(e){ VIEW="guest"; }
  if(SITEKEY && !window.turnstile){ var sc=document.createElement("script"); sc.src="https://challenges.cloudflare.com/turnstile/v0/api.js"; sc.async=true; sc.defer=true; document.head.appendChild(sc); }
  if(USER){ try{ await loadBooks(); }catch(e){ render(); } } else render();
  var fbToggle=document.getElementById("fb-toggle"); var fbBox=document.getElementById("fb-box");
  if(fbToggle&&fbBox) fbToggle.onclick=function(){ fbBox.style.display=fbBox.style.display==="none"?"block":"none"; };
  var fbForm=document.getElementById("fbform");
  if(fbForm) fbForm.addEventListener("submit", async function(e){ e.preventDefault(); var m=document.getElementById("fb-msg"); try{ await api("/api/feedback",{method:"POST",body:JSON.stringify({name:document.getElementById("fb-name").value,email:document.getElementById("fb-email").value,message:document.getElementById("fb-text").value,website:document.getElementById("fb-website").value})}); m.className="alert-ok"; m.textContent="Danke! Deine Nachricht ist angekommen."; document.getElementById("fb-name").value=""; document.getElementById("fb-email").value=""; document.getElementById("fb-text").value=""; }catch(err){ m.className="alert-error"; m.textContent=err.message; } });
})();
</script>
</body>
</html>
`;
