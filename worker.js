/**
 * Schreibblockade — Cloudflare Worker, EINE Datei.
 * Binding: DB (D1)
 * Secrets: VENICE_API_KEY, XAI_API_KEY, DIGISTORE24_IPN_PASSWORD
 * Cloudflare → Worker → Code bearbeiten → alles ersetzen → Speichern und bereitstellen.
 */
const ADMIN = new Set(['machtohnemacht@gmail.com', 'etmfilm@gmail.com']);
const PBKDF2_ITERATIONS = 100000;
const te = new TextEncoder();
const DIGISTORE24_TOKEN_PACKAGES = { '732388': 500, '732452': 1200 };
const STORAGE = {
  S: { books: 40, tokens: 200, label: 'Paket S', blurb: 'Ca. 40 Manuskripte à 200 Normseiten. Ein Jahr.' },
  M: { books: 90, tokens: 500, label: 'Paket M', blurb: 'Ca. 90 Manuskripte à 200 Normseiten. Ein Jahr.' },
  L: { books: 180, tokens: 1100, label: 'Paket L', blurb: 'Ca. 180 Manuskripte à 200 Normseiten. Ein Jahr.' },
  XL: { books: 360, tokens: 2200, label: 'Paket XL', blurb: 'Ca. 360 Manuskripte à 200 Normseiten. Ein Jahr.' },
};
const IMAGE_MODELS = [
  { id: 'chroma', name: 'CHROMA Bildstark', tokens: 6, provider: 'Venice', model: 'chroma' },
  { id: 'venice-sd35', name: 'Venedig SD 35', tokens: 6, provider: 'Venice', model: 'venice-sd35' },
  { id: 'muse-image', name: 'Muse Image', tokens: 7, provider: 'Venice', model: 'muse-image' },
  { id: 'wan-27', name: 'WAN 27', tokens: 8, provider: 'Venice', model: 'wan-2-7-text-to-image' },
  { id: 'ideogram-v4', name: 'Ideogram V4', tokens: 9, provider: 'Venice', model: 'ideogram-v4' },
  { id: 'wan-27-pro', name: 'WAN 27 PRO', tokens: 10, provider: 'Venice', model: 'wan-2-7-pro-text-to-image' },
  { id: 'grok-imagine', name: 'Grok Imagine', tokens: 9, provider: 'xAI', model: 'grok-imagine-image' },
];
const WRITE_TIERS = {
  standard: { tokensPerPage: 1, model: 'venice-uncensored-1-2', adultModel: 'venice-uncensored-1-2' },
  premium: { tokensPerPage: 2, model: 'grok-4-3', adultModel: 'grok-4-3' },
  beste: { tokensPerPage: 3, model: 'grok-4-6', adultModel: 'grok-4-6' },
};

export default {
  async fetch(request, env) {
    try {
      if (!env.DB) return new Response('D1 Binding "DB" fehlt.', { status: 500 });
      await ensureSchema(env.DB);
      const url = new URL(request.url);
      if (url.pathname === '/ipn/digistore24') return handleDigistore(request, env, url);
      if (url.pathname.startsWith('/api/')) return handleApi(request, env, url);
      if (url.pathname === '/manifest.json') {
        return new Response(JSON.stringify({
          name: 'Schreibblockade',
          short_name: 'Schreibblockade',
          start_url: '/',
          display: 'standalone',
          background_color: '#121216',
          theme_color: '#121216',
          lang: 'de',
          icons: [{ src: '/icon.svg', sizes: '512x512', type: 'image/svg+xml', purpose: 'any' }],
        }), { headers: { 'content-type': 'application/manifest+json' } });
      }
      if (url.pathname === '/icon.svg') {
        return new Response(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="80" fill="#121216"/><text x="256" y="300" text-anchor="middle" font-size="220">&#128128;</text></svg>`, { headers: { 'content-type': 'image/svg+xml' } });
      }
      if (url.pathname === '/sw.js') {
        return new Response(`self.addEventListener('install',e=>self.skipWaiting());self.addEventListener('activate',e=>e.waitUntil(clients.claim()));`, { headers: { 'content-type': 'text/javascript', 'cache-control': 'no-store' } });
      }
      if (request.method === 'GET') {
        return new Response(APP_HTML, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
      }
      return json({ error: 'Nicht gefunden.' }, 404);
    } catch (e) {
      return json({ error: e.message || 'Serverfehler' }, 500);
    }
  },
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}
function cleanEmail(x) { return String(x || '').trim().toLowerCase(); }
function originOk(request, url) {
  const o = request.headers.get('Origin');
  const r = request.headers.get('Referer');
  if (o) return o === url.origin;
  if (r) return r.startsWith(url.origin + '/') || r === url.origin;
  return false;
}
function constantTimeEqual(a, b) {
  a = String(a || ''); b = String(b || '');
  if (a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
function arrayBufferToHex(buffer) {
  return Array.from(new Uint8Array(buffer), b => b.toString(16).padStart(2, '0')).join('');
}
async function passwordHash(p, s, iterations) {
  const key = await crypto.subtle.importKey('raw', te.encode(p), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: te.encode(s), iterations: iterations || PBKDF2_ITERATIONS, hash: 'SHA-256' }, key, 256);
  return arrayBufferToBase64(bits);
}
async function sha(v) {
  return arrayBufferToBase64(await crypto.subtle.digest('SHA-256', te.encode(v)));
}
function cookieToken(request) {
  const m = (request.headers.get('Cookie') || '').match(/(?:^|;\s*)sb_sid=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : '';
}
function sessionCookie(raw, maxAge) {
  return `sb_sid=${encodeURIComponent(raw)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

async function ensureSchema(db) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS user_tokens (
      user_email TEXT PRIMARY KEY, token_balance INTEGER NOT NULL DEFAULT 0, role TEXT DEFAULT 'user',
      password_hash TEXT, password_salt TEXT, password_iterations INTEGER DEFAULT 100000,
      failed_login_attempts INTEGER DEFAULT 0, locked_until INTEGER, created_at TEXT)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_email TEXT NOT NULL, expires_at INTEGER NOT NULL)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS gt_token_ledger (
      id TEXT PRIMARY KEY, user_email TEXT NOT NULL, action_type TEXT NOT NULL, description TEXT NOT NULL,
      token_amount INTEGER NOT NULL, created_at TEXT NOT NULL)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS gt_digistore24_token_orders (
      order_key TEXT PRIMARY KEY, order_id TEXT NOT NULL, buyer_email TEXT NOT NULL, product_id TEXT NOT NULL,
      tokens INTEGER NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, processed_at TEXT, note TEXT)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS tk_books_v2 (
      id TEXT PRIMARY KEY, user_email TEXT NOT NULL, title TEXT NOT NULL, chapters TEXT NOT NULL,
      is_public INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
      dedication_from TEXT, dedication_to TEXT, is_adult_content INTEGER NOT NULL DEFAULT 0,
      quotes_style TEXT DEFAULT 'french', view_mode TEXT DEFAULT 'manuscript', trim_format TEXT DEFAULT 'taschenbuch',
      author_name TEXT DEFAULT '', blurb TEXT DEFAULT '', imprint TEXT DEFAULT '', updated_at TEXT)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS gt_ai_gallery_support (
      user_email TEXT PRIMARY KEY, active_since TEXT NOT NULL, expires_at TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1, plan_key TEXT NOT NULL DEFAULT 's')`),
  ]);
  const alters = [
    "ALTER TABLE tk_books_v2 ADD COLUMN quotes_style TEXT DEFAULT 'french'",
    "ALTER TABLE tk_books_v2 ADD COLUMN view_mode TEXT DEFAULT 'manuscript'",
    "ALTER TABLE tk_books_v2 ADD COLUMN trim_format TEXT DEFAULT 'taschenbuch'",
    "ALTER TABLE tk_books_v2 ADD COLUMN author_name TEXT DEFAULT ''",
    "ALTER TABLE tk_books_v2 ADD COLUMN blurb TEXT DEFAULT ''",
    "ALTER TABLE tk_books_v2 ADD COLUMN imprint TEXT DEFAULT ''",
    "ALTER TABLE tk_books_v2 ADD COLUMN updated_at TEXT",
    "ALTER TABLE tk_books_v2 ADD COLUMN is_adult_content INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE tk_books_v2 ADD COLUMN dedication_from TEXT",
    "ALTER TABLE tk_books_v2 ADD COLUMN dedication_to TEXT",
    "ALTER TABLE gt_ai_gallery_support ADD COLUMN plan_key TEXT NOT NULL DEFAULT 's'",
  ];
  for (const sql of alters) { try { await db.prepare(sql).run(); } catch (e) {} }
}

async function currentUser(request, db) {
  const raw = cookieToken(request);
  if (!raw) return null;
  const row = await db.prepare('SELECT s.user_email, s.expires_at, u.token_balance, u.role FROM sessions s JOIN user_tokens u ON u.user_email=s.user_email WHERE s.token_hash=?').bind(await sha(raw)).first();
  if (!row || row.expires_at < Date.now()) return null;
  const pack = await db.prepare('SELECT plan_key, expires_at, is_active FROM gt_ai_gallery_support WHERE user_email=?').bind(row.user_email).first();
  const packLive = !!(pack && pack.is_active === 1 && pack.expires_at > new Date().toISOString());
  return {
    email: row.user_email,
    tokens: row.token_balance | 0,
    role: ADMIN.has(row.user_email) ? 'admin' : (row.role || 'user'),
    plan: packLive ? String(pack.plan_key || 's').toUpperCase() : 'none',
    planUntil: packLive ? pack.expires_at : null,
  };
}
async function requireUser(request, env, url) {
  if (request.method === 'POST' && !originOk(request, url) && request.method !== 'GET') {
    throw Object.assign(new Error('Herkunft abgelehnt.'), { status: 403 });
  }
  if ((request.method === 'POST' || request.method === 'PUT' || request.method === 'DELETE') && !originOk(request, url)) {
    throw Object.assign(new Error('Herkunft abgelehnt.'), { status: 403 });
  }
  const u = await currentUser(request, env.DB);
  if (!u) throw Object.assign(new Error('Bitte anmelden.'), { status: 401 });
  return u;
}
async function logTx(db, email, type, desc, amount) {
  await db.prepare('INSERT INTO gt_token_ledger (id,user_email,action_type,description,token_amount,created_at) VALUES (?,?,?,?,?,?)')
    .bind(crypto.randomUUID(), email, type, desc, amount, new Date().toISOString()).run();
}
async function debit(db, user, cost, type, desc) {
  if (cost <= 0) return user.tokens;
  const row = await db.prepare('SELECT token_balance FROM user_tokens WHERE user_email=?').bind(user.email).first();
  const bal = row?.token_balance | 0;
  if (bal < cost) throw Object.assign(new Error(`Nicht genug Tokens (${cost} nötig, ${bal} vorhanden).`), { status: 402 });
  await db.prepare('UPDATE user_tokens SET token_balance = token_balance - ? WHERE user_email=? AND token_balance >= ?').bind(cost, user.email, cost).run();
  await logTx(db, user.email, type, desc, -cost);
  user.tokens = bal - cost;
  return user.tokens;
}
function bookExpiry(user) {
  if (user.plan !== 'none' && user.planUntil) return user.planUntil;
  return new Date(Date.now() + 7 * 86400000).toISOString();
}
function bookAlive(book, user) {
  if (user.plan !== 'none') return true;
  return String(book.expires_at || '') > new Date().toISOString();
}
async function applyPendingDigistore(db, email) {
  const pending = (await db.prepare("SELECT * FROM gt_digistore24_token_orders WHERE buyer_email=? AND status='waiting_for_account'").bind(email).all())?.results || [];
  for (const o of pending) {
    const now = new Date().toISOString();
    await db.batch([
      db.prepare('UPDATE user_tokens SET token_balance = token_balance + ? WHERE user_email=?').bind(o.tokens, email),
      db.prepare("UPDATE gt_digistore24_token_orders SET status='credited', processed_at=? WHERE order_key=?").bind(now, o.order_key),
      db.prepare('INSERT INTO gt_token_ledger (id,user_email,action_type,description,token_amount,created_at) VALUES (?,?,?,?,?,?)')
        .bind(crypto.randomUUID(), email, 'DIGISTORE24', `Digistore24 ${o.order_id}: +${o.tokens} Tokens`, o.tokens, now),
    ]);
  }
}

async function handleApi(request, env, url) {
  const db = env.DB;
  const path = url.pathname;
  try {
    if (path === '/api/me' && request.method === 'GET') return json({ user: await currentUser(request, db) });
    if (path === '/api/register' && request.method === 'POST') {
      if (!originOk(request, url)) return json({ error: 'Herkunft abgelehnt.' }, 403);
      const p = await request.json();
      const email = cleanEmail(p.email);
      const password = String(p.password || '');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: 'Ungültige E-Mail.' }, 400);
      if (password.length < 8) return json({ error: 'Passwort mindestens 8 Zeichen.' }, 400);
      const exists = await db.prepare('SELECT user_email FROM user_tokens WHERE user_email=?').bind(email).first();
      if (exists) return json({ error: 'Diese E-Mail ist schon registriert.' }, 409);
      const salt = crypto.randomUUID();
      const hash = await passwordHash(password, salt, PBKDF2_ITERATIONS);
      const role = ADMIN.has(email) ? 'admin' : 'user';
      await db.prepare('INSERT INTO user_tokens (user_email,token_balance,role,password_hash,password_salt,password_iterations,created_at) VALUES (?,?,?,?,?,?,?)')
        .bind(email, ADMIN.has(email) ? 500 : 15, role, hash, salt, PBKDF2_ITERATIONS, new Date().toISOString()).run();
      await applyPendingDigistore(db, email);
      return setSession(db, email);
    }
    if (path === '/api/login' && request.method === 'POST') {
      if (!originOk(request, url)) return json({ error: 'Herkunft abgelehnt.' }, 403);
      const p = await request.json();
      const email = cleanEmail(p.email);
      const password = String(p.password || '');
      const row = await db.prepare('SELECT * FROM user_tokens WHERE user_email=?').bind(email).first();
      if (row?.locked_until && row.locked_until > Date.now()) return json({ error: 'Konto kurz gesperrt.' }, 423);
      const ok = !!(row && row.password_hash && row.password_salt && constantTimeEqual(await passwordHash(password, row.password_salt, row.password_iterations || 100000), row.password_hash));
      if (!ok) {
        if (row) {
          const fails = (row.failed_login_attempts | 0) + 1;
          await db.prepare('UPDATE user_tokens SET failed_login_attempts=?, locked_until=? WHERE user_email=?')
            .bind(fails, fails >= 8 ? Date.now() + 15 * 60 * 1000 : null, email).run();
        }
        return json({ error: 'E-Mail oder Passwort falsch.' }, 401);
      }
      await db.prepare('UPDATE user_tokens SET failed_login_attempts=0, locked_until=NULL WHERE user_email=?').bind(email).run();
      if (ADMIN.has(email)) await db.prepare("UPDATE user_tokens SET role='admin' WHERE user_email=?").bind(email).run();
      await applyPendingDigistore(db, email);
      return setSession(db, email);
    }
    if (path === '/api/logout' && request.method === 'POST') {
      const raw = cookieToken(request);
      if (raw) await db.prepare('DELETE FROM sessions WHERE token_hash=?').bind(await sha(raw)).run();
      return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json', 'set-cookie': sessionCookie('deleted', 0) } });
    }

    const user = await requireUser(request, env, url);

    if (path === '/api/books' && request.method === 'GET') {
      const rows = (await db.prepare('SELECT id,title,is_adult_content,created_at,expires_at,updated_at,chapters FROM tk_books_v2 WHERE user_email=? ORDER BY COALESCE(updated_at,created_at) DESC').bind(user.email).all())?.results || [];
      const books = [];
      for (const b of rows) {
        if (!bookAlive(b, user)) continue;
        let pages = []; try { pages = JSON.parse(b.chapters || '[]'); } catch (e) { pages = []; }
        const chars = pages.reduce((n, pg) => n + String(pg.body || '').length, 0);
        books.push({ id: b.id, title: b.title, isAdult: !!b.is_adult_content, pages: pages.length, chars, expiresAt: user.plan === 'none' ? b.expires_at : null });
      }
      return json({ books, user });
    }
    if (path === '/api/books' && request.method === 'POST') {
      const p = await request.json();
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      const chapters = JSON.stringify([{ id: crypto.randomUUID(), body: '', imageUrl: '', imagePrompt: '' }]);
      await db.prepare('INSERT INTO tk_books_v2 (id,user_email,title,chapters,is_public,created_at,expires_at,is_adult_content,updated_at) VALUES (?,?,?,?,0,?,?,?,?)')
        .bind(id, user.email, String(p.title || 'Ohne Titel').slice(0, 180), chapters, now, bookExpiry(user), p.isAdult ? 1 : 0, now).run();
      return json({ id });
    }
    const bookGet = path.match(/^\/api\/books\/([0-9a-f-]{36})$/i);
    if (bookGet && request.method === 'GET') {
      const b = await db.prepare('SELECT * FROM tk_books_v2 WHERE id=? AND user_email=?').bind(bookGet[1], user.email).first();
      if (!b || !bookAlive(b, user)) return json({ error: 'Manuskript nicht gefunden.' }, 404);
      return json({ book: serializeBook(b), user });
    }
    if (bookGet && request.method === 'PUT') {
      const b = await db.prepare('SELECT id FROM tk_books_v2 WHERE id=? AND user_email=?').bind(bookGet[1], user.email).first();
      if (!b) return json({ error: 'Manuskript nicht gefunden.' }, 404);
      const p = await request.json();
      const pages = Array.isArray(p.pages) ? p.pages : [];
      const clean = pages.slice(0, 800).map(pg => ({
        id: String(pg.id || crypto.randomUUID()),
        body: String(pg.body || '').slice(0, 8000),
        imageUrl: String(pg.imageUrl || '').slice(0, 180000),
        imagePrompt: String(pg.imagePrompt || '').slice(0, 2000),
      }));
      if (!clean.length) clean.push({ id: crypto.randomUUID(), body: '', imageUrl: '', imagePrompt: '' });
      const now = new Date().toISOString();
      await db.prepare(`UPDATE tk_books_v2 SET title=?, chapters=?, dedication_from=?, dedication_to=?, is_adult_content=?,
        quotes_style=?, view_mode=?, trim_format=?, author_name=?, blurb=?, imprint=?, expires_at=?, updated_at=?
        WHERE id=? AND user_email=?`)
        .bind(
          String(p.title || 'Ohne Titel').slice(0, 180), JSON.stringify(clean),
          String(p.dedicationFrom || '').slice(0, 180), String(p.dedicationTo || '').slice(0, 180),
          p.isAdult ? 1 : 0,
          ['french', 'german', 'english'].includes(p.quotesStyle) ? p.quotesStyle : 'french',
          p.viewMode === 'book' ? 'book' : 'manuscript',
          ['taschenbuch', 'hardcover', 'a5'].includes(p.trimFormat) ? p.trimFormat : 'taschenbuch',
          String(p.authorName || '').slice(0, 180), String(p.blurb || '').slice(0, 4000), String(p.imprint || '').slice(0, 2000),
          bookExpiry(user), now, bookGet[1], user.email,
        ).run();
      return json({ ok: true, user, savedAt: now });
    }
    if (bookGet && request.method === 'DELETE') {
      await db.prepare('DELETE FROM tk_books_v2 WHERE id=? AND user_email=?').bind(bookGet[1], user.email).run();
      return json({ ok: true });
    }
    if (path === '/api/ledger' && request.method === 'GET') {
      const rows = (await db.prepare('SELECT action_type,description,token_amount,created_at FROM gt_token_ledger WHERE user_email=? ORDER BY created_at DESC LIMIT 80').bind(user.email).all())?.results || [];
      return json({ rows, user });
    }
    if (path === '/api/storage' && request.method === 'POST') {
      const p = await request.json();
      const tier = String(p.tier || '').toUpperCase();
      const plan = STORAGE[tier];
      if (!plan) return json({ error: 'Unbekanntes Paket.' }, 400);
      await debit(db, user, plan.tokens, 'STORAGE', `${plan.label} für ein Jahr`);
      const now = new Date().toISOString();
      const until = new Date(Date.now() + 365 * 86400000).toISOString();
      await db.prepare(`INSERT INTO gt_ai_gallery_support (user_email,active_since,expires_at,is_active,plan_key)
        VALUES (?,?,?,1,?) ON CONFLICT(user_email) DO UPDATE SET active_since=excluded.active_since, expires_at=excluded.expires_at, is_active=1, plan_key=excluded.plan_key`)
        .bind(user.email, now, until, tier.toLowerCase()).run();
      await db.prepare('UPDATE tk_books_v2 SET expires_at=? WHERE user_email=?').bind(until, user.email).run();
      user.plan = tier; user.planUntil = until;
      return json({ ok: true, user });
    }
    if (path === '/api/spell' && request.method === 'POST') {
      const text = String((await request.json()).text || '').slice(0, 15000);
      await debit(db, user, 1, 'SPELL', 'Rechtschreibprüfung');
      const res = await fetch('https://api.languagetool.org/v2/check', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ text, language: 'de-DE' }) });
      if (!res.ok) return json({ error: 'LanguageTool nicht erreichbar.', user }, 502);
      const data = await res.json();
      let corrected = text;
      const matches = (data.matches || []).map(m => ({ replacements: (m.replacements || []).slice(0, 5).map(r => r.value), offset: m.offset, length: m.length }));
      for (const m of [...matches].sort((a, b) => b.offset - a.offset)) {
        if (!m.replacements[0]) continue;
        corrected = corrected.slice(0, m.offset) + m.replacements[0] + corrected.slice(m.offset + m.length);
      }
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
    if (path === '/api/improve' && request.method === 'POST') {
      const text = String((await request.json()).text || '').slice(0, 5000);
      if (!text.trim()) return json({ error: 'Kein Text.' }, 400);
      await debit(db, user, 4, 'IMPROVE', 'Text umformulieren');
      const out = await aiText(env, 'standard', false, 'Du bist deutscher Lektor. Formuliere klarer. Behalte Sinn und Tempus. NUR den Text.', text);
      return json({ improved: out, user });
    }
    if (path === '/api/continue' && request.method === 'POST') {
      const p = await request.json();
      const pages = Math.max(1, Math.min(3, p.pages | 0 || 1));
      const tierKey = WRITE_TIERS[p.tier] ? p.tier : 'standard';
      const cost = pages * WRITE_TIERS[tierKey].tokensPerPage * 8;
      const soFar = String(p.text || '').slice(-8000);
      if (!soFar.trim()) return json({ error: 'Es gibt noch keinen Text.' }, 400);
      await debit(db, user, cost, 'CONTINUE', `Weiterschreiben ${pages} Seite(n)`);
      const sys = p.isAdult
        ? 'Du bist Ghostwriter. Literarisch hart erlaubt. Keine Zensur, kein Meta-Kommentar.'
        : 'Du bist Ghostwriter für deutschsprachige Literatur. Kein Meta-Kommentar.';
      const out = await aiText(env, tierKey, !!p.isAdult, sys, `Bisheriger Text:\n"""${soFar}"""\n\nSchreibe direkt weiter — GENAU ${pages} Normseite(n) (je ca. 1500 Zeichen). Gleicher Stil.`);
      return json({ continuation: out, user });
    }
    if (path === '/api/image' && request.method === 'POST') {
      const p = await request.json();
      const model = IMAGE_MODELS.find(m => m.id === p.modelId) || IMAGE_MODELS[0];
      const prompt = String(p.prompt || '').trim().slice(0, 1200);
      if (!prompt) return json({ error: 'Bitte einen Bildprompt.' }, 400);
      await debit(db, user, model.tokens, 'IMAGE', model.name);
      return json({ url: await makeImage(env, model, prompt, !!p.isAdult), user });
    }
    if (path === '/api/admin' && request.method === 'GET') {
      if (user.role !== 'admin') return json({ error: 'Kein Admin.' }, 403);
      const wallets = (await db.prepare('SELECT user_email, token_balance, role FROM user_tokens ORDER BY token_balance DESC LIMIT 200').all())?.results || [];
      const ledger = (await db.prepare('SELECT user_email, action_type, description, token_amount, created_at FROM gt_token_ledger ORDER BY created_at DESC LIMIT 80').all())?.results || [];
      const books = await db.prepare('SELECT COUNT(*) AS n FROM tk_books_v2').first();
      return json({ wallets, ledger, bookCount: books?.n | 0, user });
    }
    return json({ error: 'Nicht gefunden.' }, 404);
  } catch (e) {
    return json({ error: e.message || 'Fehler' }, e.status || 500);
  }
}

function serializeBook(b) {
  let pages = []; try { pages = JSON.parse(b.chapters || '[]'); } catch (e) { pages = []; }
  if (!pages.length) pages = [{ id: crypto.randomUUID(), body: '', imageUrl: '', imagePrompt: '' }];
  return {
    id: b.id, title: b.title, dedicationFrom: b.dedication_from || '', dedicationTo: b.dedication_to || '',
    isAdult: !!b.is_adult_content, quotesStyle: b.quotes_style || 'french', viewMode: b.view_mode || 'manuscript',
    trimFormat: b.trim_format || 'taschenbuch', authorName: b.author_name || '', blurb: b.blurb || '', imprint: b.imprint || '',
    pages,
  };
}

async function setSession(db, email) {
  const raw = crypto.randomUUID() + crypto.randomUUID();
  const exp = Date.now() + 30 * 86400000;
  await db.prepare('INSERT INTO sessions (token_hash,user_email,expires_at) VALUES (?,?,?)').bind(await sha(raw), email, exp).run();
  const user = await db.prepare('SELECT token_balance, role FROM user_tokens WHERE user_email=?').bind(email).first();
  return new Response(JSON.stringify({
    ok: true,
    user: { email, tokens: user?.token_balance | 0, role: ADMIN.has(email) ? 'admin' : (user?.role || 'user'), plan: 'none', planUntil: null },
  }), { headers: { 'content-type': 'application/json', 'set-cookie': sessionCookie(raw, 30 * 86400) } });
}

async function aiText(env, tierKey, isAdult, system, content) {
  const tier = WRITE_TIERS[tierKey] || WRITE_TIERS.standard;
  const model = isAdult ? tier.adultModel : tier.model;
  if (env.VENICE_API_KEY) {
    const res = await fetch('https://api.venice.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + env.VENICE_API_KEY },
      body: JSON.stringify({ model, messages: [{ role: 'system', content: system }, { role: 'user', content }], temperature: 0.95 }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((typeof j.error === 'string' ? j.error : j.error?.message) || 'Venice-Fehler');
    const out = j.choices?.[0]?.message?.content?.trim();
    if (!out) throw new Error('Die KI hat keinen Text zurückgegeben.');
    return out;
  }
  if (!env.XAI_API_KEY) throw Object.assign(new Error('Weder VENICE_API_KEY noch XAI_API_KEY gesetzt.'), { status: 503 });
  const res = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + env.XAI_API_KEY },
    body: JSON.stringify({ model: 'grok-4-1-fast', temperature: 0.95, messages: [{ role: 'system', content: system }, { role: 'user', content }] }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error?.message || 'Grok-Fehler');
  const out = j.choices?.[0]?.message?.content?.trim();
  if (!out) throw new Error('Die KI hat keinen Text zurückgegeben.');
  return out;
}

async function makeImage(env, model, prompt, isAdult) {
  const p = (isAdult ? 'Literary cinematic illustration, tasteful. ' : 'Literary cinematic illustration. ') + prompt;
  if (model.provider === 'Venice') {
    if (!env.VENICE_API_KEY) throw Object.assign(new Error('VENICE_API_KEY fehlt.'), { status: 503 });
    const res = await fetch('https://api.venice.ai/api/v1/image/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + env.VENICE_API_KEY },
      body: JSON.stringify({ model: model.model, prompt: p, format: 'png', return_binary: false, aspect_ratio: '2:3' }),
    });
    const type = (res.headers.get('content-type') || '').toLowerCase();
    if (res.ok && type.startsWith('image/')) return 'data:' + type.split(';')[0] + ';base64,' + arrayBufferToBase64(await res.arrayBuffer());
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error?.message || j.error || 'Bildfehler');
    const b64 = j.images?.[0];
    if (!b64) throw new Error('Kein Bild.');
    return 'data:image/png;base64,' + b64;
  }
  if (!env.XAI_API_KEY) throw Object.assign(new Error('XAI_API_KEY fehlt.'), { status: 503 });
  const res = await fetch('https://api.x.ai/v1/images/generations', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + env.XAI_API_KEY },
    body: JSON.stringify({ model: 'grok-imagine-image', prompt: p, n: 1, response_format: 'url' }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error?.message || 'Bildfehler');
  const u = j.data?.[0]?.url;
  if (!u) throw new Error('Kein Bild.');
  return u;
}

async function handleDigistore(request, env, url) {
  const db = env.DB;
  const passphrase = String(env.DIGISTORE24_IPN_PASSWORD || '');
  if (!passphrase) return new Response('Digistore24 nicht konfiguriert.', { status: 503 });
  const params = Object.fromEntries(url.searchParams.entries());
  if (request.method === 'POST') {
    const type = request.headers.get('content-type') || '';
    if (type.includes('application/x-www-form-urlencoded') || type.includes('multipart/form-data')) {
      const form = await request.formData();
      for (const [k, v] of form.entries()) params[k] = String(v);
    }
  }
  if (params.event === 'connection_test') return new Response('OK', { status: 200 });
  const keys = Object.keys(params).filter(k => k.toLowerCase() !== 'sha_sign' && k.toLowerCase() !== '__sha_sign__').sort();
  let value = '';
  for (const key of keys) {
    const parameter = params[key];
    if (parameter === '' || parameter === false || parameter == null) continue;
    value += `${key}=${parameter}${passphrase}`;
  }
  const expected = arrayBufferToHex(await crypto.subtle.digest('SHA-512', te.encode(value))).toUpperCase();
  const received = params.sha_sign || params.__sha_sign__;
  const urlSecretValid = constantTimeEqual(url.searchParams.get('key'), passphrase);
  const signatureValid = received && constantTimeEqual(String(received).toUpperCase(), expected);
  if (!signatureValid && !urlSecretValid) return new Response('Ungültige Signatur.', { status: 403 });
  const productId = String(params.product_id || '').trim();
  const tokenAmount = DIGISTORE24_TOKEN_PACKAGES[productId];
  if (!tokenAmount) return new Response('Unbekanntes Produkt.', { status: 400 });
  const orderId = String(params.order_id || '').trim();
  const orderKey = String(params.order_item_id || orderId).trim();
  const buyerEmail = cleanEmail(params.buyer_email || params.email || '');
  if (!orderId || !orderKey || !buyerEmail) return new Response('Unvollständige Daten.', { status: 400 });
  const inserted = await db.prepare(`INSERT OR IGNORE INTO gt_digistore24_token_orders
    (order_key,order_id,buyer_email,product_id,tokens,status,created_at) VALUES (?,?,?,?,?,'received',?)`)
    .bind(orderKey, orderId, buyerEmail, productId, tokenAmount, new Date().toISOString()).run();
  if (!inserted.meta.changes) return new Response('Bereits verarbeitet.', { status: 200 });
  const account = await db.prepare('SELECT user_email FROM user_tokens WHERE user_email=?').bind(buyerEmail).first();
  if (!account && /@test-ds24\.com$/i.test(buyerEmail)) {
    await db.prepare("UPDATE gt_digistore24_token_orders SET status='test_order', processed_at=? WHERE order_key=?").bind(new Date().toISOString(), orderKey).run();
    return new Response('OK', { status: 200 });
  }
  if (!account) {
    await db.prepare("UPDATE gt_digistore24_token_orders SET status='waiting_for_account', note=? WHERE order_key=?").bind('Kein Konto mit dieser E-Mail.', orderKey).run();
    return new Response('Käufer nicht registriert.', { status: 422 });
  }
  await db.batch([
    db.prepare('UPDATE user_tokens SET token_balance = token_balance + ? WHERE user_email=?').bind(tokenAmount, buyerEmail),
    db.prepare("UPDATE gt_digistore24_token_orders SET status='credited', processed_at=? WHERE order_key=?").bind(new Date().toISOString(), orderKey),
    db.prepare('INSERT INTO gt_token_ledger (id,user_email,action_type,description,token_amount,created_at) VALUES (?,?,?,?,?,?)')
      .bind(crypto.randomUUID(), buyerEmail, 'DIGISTORE24', `Digistore24 ${orderId}: +${tokenAmount} Tokens`, tokenAmount, new Date().toISOString()),
  ]);
  return new Response('OK', { status: 200 });
}

const APP_HTML = `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"/>
<meta name="theme-color" content="#121216"/>
<meta name="apple-mobile-web-app-capable" content="yes"/>
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"/>
<meta name="apple-mobile-web-app-title" content="Schreibblockade"/>
<link rel="manifest" href="/manifest.json"/>
<link rel="icon" href="/icon.svg"/>
<title>Schreibblockade</title>
<style>
:root{color-scheme:dark;--red:#ff4b4f;--bg-main:#121216;--bg-sidebar:#18181f;--bg-box:#18181f;--bg-textarea:#1a1a22;--border-color:#2a2a35;--accent-red:#ff4b4f;--text-main:#e0e0e0;--text-muted:#9999a2}
*{box-sizing:border-box}
body{margin:0;background:var(--bg-main);color:var(--text-main);font:16px/1.5 Arial,sans-serif;min-height:100vh}
.app-container{display:flex;min-height:100vh}
.sidebar{width:340px;background:var(--bg-sidebar);border-right:1px solid var(--border-color);padding:25px;display:flex;flex-direction:column;justify-content:space-between;position:sticky;top:0;height:100vh;overflow-y:auto;flex-shrink:0}
.main{flex:1;padding:40px 60px;min-width:0}
.logo-sq{width:100%;aspect-ratio:1/1;background:#121216;border-radius:8px;border:1px solid var(--border-color);overflow:hidden;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:16px}
.logo-sq .sk{font-size:72px;line-height:1}
.logo-sq strong{color:#fff;letter-spacing:2px;font-size:15px;margin-top:12px}
.logo-sq span{color:#ff4b4f;font-size:12px;margin-top:6px}
.box{background:var(--bg-box);padding:28px;border-radius:10px;border:1px solid var(--border-color);margin-bottom:24px}
label{display:block;margin:10px 0 6px;font-weight:bold}
input[type=email],input[type=password],input[type=text],select,textarea{width:100%;background:var(--bg-textarea);color:#fff;border:1px solid var(--border-color);padding:12px;border-radius:6px;font:inherit;margin-bottom:12px}
button{background:var(--accent-red);color:#fff;border:none;padding:12px 18px;border-radius:6px;font-weight:bold;cursor:pointer;width:100%}
button:hover{background:#e03e3e}
button.ghost{background:transparent;border:1px solid var(--border-color);color:var(--text-main)}
button.sm{width:auto;padding:10px 14px}
h1{font-size:28px;margin:0 0 8px;color:#fff;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
h2{font-size:22px;margin:0 0 15px;color:#fff}
h3{font-size:16px;color:#fff;margin:15px 0 8px}
.tabs{display:flex;gap:20px;margin:30px 0 28px;border-bottom:1px solid var(--border-color);padding-bottom:15px;flex-wrap:wrap}
.tab-link{color:var(--text-muted);text-decoration:none;font-size:16px;font-weight:500;padding:4px 2px;background:none;border:none;width:auto;font-weight:500}
.tab-link.active{color:var(--text-main);border-bottom:2px solid var(--accent-red);padding-bottom:13px;border-radius:0;background:none}
.alert-error{background:#3f1515;color:#f87171;padding:12px 16px;border-radius:8px;margin-bottom:16px;border:1px solid #5c2020}
.alert-ok{background:#13381e;color:#4ade80;padding:12px 16px;border-radius:8px;margin-bottom:16px}
.muted{color:var(--text-muted);font-size:14px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px}
.card{background:var(--bg-box);border:1px solid var(--border-color);border-radius:10px;padding:18px;color:inherit;text-decoration:none;display:block;min-height:140px}
.card strong{display:block;color:var(--text-main);font-size:17px;margin:8px 0}
.more{display:block;color:#ff6670;margin-top:12px;font-weight:bold;font-size:13px}
.beta{font-size:12px;background:#2a1215;color:#ff4b4b;border:1px solid #ff4b4b;padding:2px 8px;border-radius:4px;font-weight:600;letter-spacing:1px}
.skull{width:40px;height:40px;background:#18181f;border-radius:8px;border:1px solid var(--border-color);display:inline-flex;align-items:center;justify-content:center;font-size:24px}
.toprow{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:15px}
.homebtn{width:auto;background:#18181f;border:1px solid var(--border-color);padding:8px 14px}
.sheet{background:#f6f0e4;color:#1a1612;box-shadow:0 18px 50px #0008;margin:8px auto;padding:24px 28px;width:min(100%,calc(60ch + 4rem));border-radius:2px}
.sheet textarea{background:transparent;color:#1a1612;border:0;resize:none;outline:none;font-family:"Courier New",monospace;font-size:12pt;line-height:1.5;width:60ch;max-width:100%;min-height:38em;margin:0;padding:0}
.bookview{font-family:Georgia,"Times New Roman",serif;font-size:12.5pt;line-height:1.55;text-align:justify;hyphens:auto;color:#1a1612}
.pages{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0}
.pages button{width:auto;min-width:40px;background:#1a1a22}
.pages button.on{background:#f6f0e4;color:#121216}
.ed{display:grid;gap:16px}
@media(min-width:1100px){.ed{grid-template-columns:1fr 280px}}
.tools{background:var(--bg-box);border:1px solid var(--border-color);border-radius:10px;padding:16px}
.footer-bar{margin-top:80px;border-top:1px solid var(--border-color);padding-top:20px;display:flex;justify-content:space-between;flex-wrap:wrap;gap:12px;color:var(--text-muted);font-size:13px}
.pwa{display:none;background:#18181f;border:1px solid var(--border-color);border-radius:10px;padding:12px 16px;margin-bottom:18px}
@media(max-width:900px){
  .app-container{flex-direction:column}
  .sidebar{position:static;width:100%;height:auto}
  .main{padding:20px}
  .sheet{width:100%;padding:16px}
  .sheet textarea{width:100%;min-height:24em}
  .pwa{display:block}
}
img.illu{width:100%;border-radius:8px;margin-top:8px}
</style>
</head>
<body>
<div class="app-container">
  <aside class="sidebar" id="sidebar"></aside>
  <div class="main">
    <div class="toprow">
      <div>
        <h1><span class="skull">💀</span> Schreibblockade <span class="beta">BETA</span></h1>
        <p class="muted" style="margin:6px 0 0">Dein Schreibprogramm gegen die Blockade — Normseite, Lektorat, KI-Weiterschreiben, Bilder. Auf dem Handy diktieren.</p>
      </div>
      <button class="homebtn sm" type="button" id="gohome">⌂ Startseite</button>
    </div>
    <div class="pwa">Aufs Handy: im Browser-Menü <b>Zum Home-Bildschirm</b> legen. Dann ist es eine App — ohne Play Store. Diktieren geht über das Mikrofon.</div>
    <nav class="tabs" id="tabs"></nav>
    <div id="content"></div>
    <footer class="footer-bar">
      <div>© 2026 Schwarzdichter App Familie</div>
      <div><a href="https://mein.online-impressum.de/hajodanckesongwriter/" target="_blank" style="color:var(--accent-red);text-decoration:none">Impressum</a></div>
    </footer>
  </div>
</div>
<script>
if("serviceWorker" in navigator){navigator.serviceWorker.register("/sw.js").catch(function(){});}
const MAX=1500,LINES=30,CPL=60;
const STORAGE={S:{label:"Paket S",tokens:200,blurb:"Ca. 40 Manuskripte a 200 Normseiten. Ein Jahr."},M:{label:"Paket M",tokens:500,blurb:"Ca. 90 Manuskripte a 200 Normseiten. Ein Jahr."},L:{label:"Paket L",tokens:1100,blurb:"Ca. 180 Manuskripte a 200 Normseiten. Ein Jahr."},XL:{label:"Paket XL",tokens:2200,blurb:"Ca. 360 Manuskripte a 200 Normseiten. Ein Jahr."}};
const MODELS=[{id:"chroma",name:"CHROMA Bildstark",tokens:6},{id:"venice-sd35",name:"Venedig SD 35",tokens:6},{id:"muse-image",name:"Muse Image",tokens:7},{id:"wan-27",name:"WAN 27",tokens:8},{id:"ideogram-v4",name:"Ideogram V4",tokens:9},{id:"wan-27-pro",name:"WAN 27 PRO",tokens:10},{id:"grok-imagine",name:"Grok Imagine",tokens:9}];
const WORLD=[["✍️","Schwarzdichter","Songtexte aus Idee, Stichworten, Sätzen oder aus einem Bild erschaffen.","https://schwarzdichter.com/?tab=directory"],["🖼️","Bildertonne","KI-Bilder erzeugen, bearbeiten, hochskalieren und verschlüsselt speichern.","https://bildertonne.etmfilm.workers.dev/?tab=tab_community"],["📖","Schreibblockade","Eigene Bücher schreiben: Normseite, Lektorat, KI-Weiterschreiben, Bilder.","/"],["🪶","Federflausen","Kindergeschichten bis 12 Jahre aus Ideen, Fotos oder Würfelideen.","https://federflausen.schwarzdichter.com/?tab=tab_community"],["🧠","Gedankensammler","Gedanken aufschreiben und geschützt verwahren.","https://gedankensammler.schwarzdichter.com"],["🔐","Gedankentresor","Inhalt in ein verschlüsseltes Schließfach legen.","https://gedankentresor.schwarzdichter.com"]];
let USER=null,VIEW="guest",BOOKS=[],BOOK=null,ACTIVE=0,SAVE=null,WORK=null,MSG="",OK="",MIC=null;

function visualLines(text){const out=[];String(text||"").replace(/\\r/g,"").split("\\n").forEach(function(p){if(!p.length){out.push("");return;}var rest=p;while(rest.length>CPL){var slice=rest.slice(0,CPL),sp=slice.lastIndexOf(" "),cut=sp>24?sp:CPL;out.push(rest.slice(0,cut).trimEnd());rest=rest.slice(cut).trimStart();}out.push(rest);});return out;}
function fits(t){return t.length<=MAX&&visualLines(t).length<=LINES;}
function splitAt(text){if(fits(text))return{kept:text,overflow:""};var lo=0,hi=text.length;while(lo<hi){var mid=Math.ceil((lo+hi)/2);if(fits(text.slice(0,mid)))lo=mid;else hi=mid-1;}var cut=lo;var sp=Math.max(text.lastIndexOf(" ",cut),text.lastIndexOf("\\n",cut));if(sp>cut-48&&sp>0)cut=sp+1;return{kept:text.slice(0,cut).replace(/\\s+$/g,""),overflow:text.slice(cut).replace(/^\\s+/g,"")};}
function paginate(pages,start){var next=pages.slice(),i=start;while(i<next.length){var r=splitAt(next[i]||"");next[i]=r.kept;if(!r.overflow)break;if(i+1>=next.length)next.push("");next[i+1]=r.overflow+(next[i+1]?(next[i+1].charAt(0)==="\\n"?"":" ")+next[i+1]:"");i++;}if(!next.length)next.push("");return next;}
function applyQuotes(text,style){var pairs={french:["«","»"],german:["„","“"],english:["“","”"]};var pc=pairs[style]||pairs.french;var out="",open=true,i,ch;for(i=0;i<text.length;i++){ch=text.charAt(i);if("«»„“”\\"".indexOf(ch)>=0){if(ch==="«"||ch==="„"||ch==="“"||ch==='"'){out+=open?pc[0]:pc[1];open=!open;}else out+=ch;}else out+=ch;}return out;}
function esc(s){return String(s||"").replace(/[&<>"']/g,function(c){return {"&":"&"+"amp;","<":"&"+"lt;",">":"&"+"gt;",'"':"&"+"quot;","'":"&#39;"}[c];});}
async function api(path,opt){var r=await fetch(path,Object.assign({credentials:"same-origin",headers:{"content-type":"application/json"}},opt||{}));var d=await r.json().catch(function(){return {};});if(d.user)USER=d.user;if(!r.ok)throw new Error(d.error||("HTTP "+r.status));return d;}

function logoHtml(){return '<div class="logo-sq"><div class="sk">💀</div><strong>SCHREIBBLOCKADE</strong><span>Aus Schmerz wird Kunst</span></div>';}
function sidebarHtml(){
  var inner;
  if(!USER){
    inner='<h3>🔐 Anmeldung</h3>'+(MSG?'<div class="alert-error">'+esc(MSG)+'</div>':'')+(OK?'<div class="alert-ok">'+esc(OK)+'</div>':'')+
      '<form id="auth"><label>E-Mail</label><input name="email" type="email" required autocomplete="username"/><label>Passwort</label><input name="password" type="password" required minlength="8" autocomplete="current-password"/><button type="submit" name="mode" value="login">Anmelden</button><button class="ghost" type="submit" name="mode" value="register" style="margin-top:8px">Registrieren (15 Token gratis)</button></form>';
  } else {
    inner='<h3>🔐 Account</h3><p style="margin:0 0 6px">'+esc(USER.email)+'</p><p id="tk_sidebar_tokens" style="font-size:18px;font-weight:bold;color:#4ade80;margin:0 0 12px">'+(USER.tokens|0)+' Tokens</p><p class="muted">'+(USER.plan==="none"?"Ohne Speicherpaket · 7 Tage":("Paket "+USER.plan))+'</p><button class="ghost" id="logout" type="button">Abmelden</button>';
  }
  return logoHtml()+'<div style="margin-top:15px">'+inner+'</div><div class="sidebar-bottom" style="margin-top:20px;border-top:1px solid var(--border-color);padding-top:15px"><h3>🎟️ Gutscheine einlösen</h3><p class="muted">Gutscheine und Digistore24-Käufe werden dem Konto mit derselben E-Mail gutgeschrieben.</p></div>';
}
function tabsHtml(){
  var items=[["guest","Startseite"]];
  if(USER){
    items=[["desk","✍️ Manuskripte"],["edit","📖 Schreiben"],["shop","🎟️ Tokens"],["konto","Mein Konto"]];
    if(USER.role==="admin") items.push(["admin","Admin"]);
  }
  return items.map(function(it){return '<button type="button" class="tab-link'+(VIEW===it[0]?" active":"")+'" data-go="'+it[0]+'">'+it[1]+'</button>';}).join("");
}
function guestPage(){
  var feats=[
    ["📄","Offizielle Normseite","1.500 Zeichen, 30 Zeilen, Courier, DIN-A4. Volle Seite → neue Seite. Unbegrenzt."],
    ["📝","Lektorat live","LanguageTool korrigiert. Synonyme per Klick. Umformulieren wie ein Lektor."],
    ["🤖","KI schreibt weiter","Wenn die Blockade kommt: 1, 2 oder 3 Normseiten im eigenen Stil. Adult gleichberechtigt."],
    ["🎤","Diktieren am Handy","App auf den Home-Bildschirm. Mikrofon an, Text landet auf der Seite. Danach Rechtschreibung und Synonyme."],
    ["🖼️","Bilder zur Seite","Bildmodelle nur aufklappen wenn du willst. CHROMA, Venice, Grok Imagine."],
    ["☁️","Nichts geht verloren","Autosave nach jedem Satz. Ohne Paket 7 Tage, mit S/M/L/XL ein Jahr."]
  ];
  var feat=feats.map(function(f){return '<div class="card"><div style="font-size:28px">'+f[0]+'</div><strong>'+f[1]+'</strong><span class="muted">'+f[2]+'</span></div>';}).join("");
  var world=WORLD.map(function(w){return '<a class="card" href="'+w[3]+'"><div style="font-size:28px">'+w[0]+'</div><strong>'+w[1]+'</strong><span class="muted">'+w[2]+'</span><span class="more">Mehr erfahren →</span></a>';}).join("");
  return '<div class="box" style="text-align:center"><h2>Das kannst du hier erschaffen — sobald du dabei bist</h2><p class="muted" style="max-width:640px;margin:0 auto 22px">Du bist noch nicht angemeldet. Registriere dich links kostenlos — eine Minute, 15 Start-Tokens.</p><div class="grid" style="text-align:left">'+feat+'</div></div><section class="box"><h2 style="text-align:center">Entdecke die Schwarzdichter-Welt</h2><p class="muted" style="text-align:center;max-width:760px;margin:12px auto 24px">Sechs eigenständige Kreativräume. Jeder Bereich bleibt bei sich, hier aber direkt erreichbar.</p><div class="grid">'+world+'</div></section>';
}
function deskPage(){
  var list=BOOKS.map(function(b){return '<div class="card" style="min-height:0"><a href="#" data-open="'+b.id+'" style="color:inherit;text-decoration:none"><strong>'+(esc(b.title)||"Ohne Titel")+'</strong>'+(b.isAdult?' <span class="muted">ADULT</span>':'')+'<div class="muted">'+b.pages+' Normseiten · '+Number(b.chars).toLocaleString("de-DE")+' Zeichen'+(b.expiresAt?' · bis '+new Date(b.expiresAt).toLocaleDateString("de-DE"):' · im Jahrespaket')+'</div></a><button class="ghost sm" data-del="'+b.id+'" style="margin-top:10px">Löschen</button></div>';}).join("")||'<div class="muted">Noch nichts auf dem Schreibtisch.</div>';
  return '<div class="box"><div class="toprow"><div><h2>Manuskripte</h2><p class="muted">Aufschlagen oder neu beginnen.</p></div><div style="display:flex;gap:8px"><button class="sm" id="new" type="button">Neues Manuskript</button><button class="ghost sm" id="newa" type="button">Adult</button></div></div><div class="grid" style="margin-top:18px">'+list+'</div></div>';
}
function kontoPage(){
  return '<div class="box"><h2>Mein Konto</h2><p class="muted">'+esc(USER.email)+'</p><div class="grid"><div class="card" style="min-height:0"><div class="muted">Guthaben</div><h2>'+(USER.tokens|0)+'</h2></div><div class="card" style="min-height:0"><div class="muted">Speicher</div><h2>'+(USER.plan==="none"?"Ohne Paket":("Paket "+USER.plan))+'</h2><div class="muted">'+(USER.planUntil?("bis "+new Date(USER.planUntil).toLocaleDateString("de-DE")):"7 Tage ohne Paket")+'</div></div></div><div id="ledger" class="muted" style="margin-top:18px">Lädt …</div></div>';
}
function shopPage(){
  var packs=Object.keys(STORAGE).map(function(k){return '<button class="ghost" style="text-align:left;display:flex;justify-content:space-between;align-items:center" data-pack="'+k+'"><span><b>'+STORAGE[k].label+'</b><div class="muted">'+STORAGE[k].blurb+'</div></span><span>'+STORAGE[k].tokens+' Tokens / Jahr</span></button>';}).join("");
  return '<div class="box"><h2>Tokens und Speicher</h2><p class="muted">Digistore24 schreibt Tokens automatisch gut (732388 = 500, 732452 = 1.200), wenn die Käufer-E-Mail dein Konto ist. Speicher gilt ein Jahr.</p><div style="display:grid;gap:10px;margin-top:16px">'+packs+'</div></div>';
}
function adminPage(){return '<div class="box"><h2>Admin</h2><p class="muted">Nur für dich sichtbar. Gäste und normale Konten sehen diesen Reiter nicht.</p><div id="adminbox" class="muted">Lädt …</div></div>';}
function editorPage(){
  if(!BOOK) return '<div class="box">Lädt …</div>';
  var page=BOOK.pages[ACTIVE]||BOOK.pages[0];
  var body=page.body||"";
  var chars=body.length,lines=visualLines(body).length;
  var pageBtns=BOOK.pages.map(function(_,i){return '<button type="button" class="'+(i===ACTIVE?"on":"")+'" data-pg="'+i+'">'+(i+1)+'</button>';}).join("");
  var modelOpts=MODELS.map(function(m){return '<option value="'+m.id+'">'+m.name+' · '+m.tokens+' T</option>';}).join("");
  var isBook=BOOK.viewMode==="book";
  var paper=isBook
    ? ('<div class="sheet bookview" lang="de"><h2 style="text-align:center;color:#1a1612">'+esc(BOOK.title||"Ohne Titel")+'</h2>'+esc(applyQuotes(body,BOOK.quotesStyle)).replace(/\\n/g,"<br/>")+'<p class="muted" style="text-align:center;margin-top:24px">'+(ACTIVE+1)+'</p></div>')
    : ('<div class="sheet"><textarea id="body" maxlength="8000" placeholder="Fang einfach an zu schreiben …">'+esc(body)+'</textarea><div class="muted" style="display:flex;justify-content:space-between"><span id="stat">'+chars+' / 1500 · '+lines+' / 30 Zeilen</span><span>Seite '+(ACTIVE+1)+'</span></div></div>');
  return '<div class="ed"><div><div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center"><input id="title" value="'+esc(BOOK.title)+'" placeholder="Buchtitel" style="flex:1;margin:0"/><button class="ghost sm" type="button" id="modeM">Normseite</button><button class="ghost sm" type="button" id="modeB">Buchsatz</button></div><div class="pages">'+pageBtns+'<button class="ghost sm" type="button" id="addp">Neue Seite</button></div>'+paper+'</div><aside class="tools"><p class="muted" id="savestate">Autosave</p>'+(WORK?'<p class="muted">'+esc(WORK)+'</p>':'')+(MSG?'<div class="alert-error">'+esc(MSG)+'</div>':'')+
    '<div style="display:flex;gap:8px;flex-wrap:wrap"><button class="sm" type="button" data-act="spell">Korrigieren</button><button class="ghost sm" type="button" data-act="syn">Synonyme</button><button class="ghost sm" type="button" data-act="imp">Umformulieren</button></div>'+
    '<p class="muted" style="margin-top:14px">Diktieren (Handy-Mikrofon)</p><button class="ghost" type="button" id="mic">🎤 Diktieren</button>'+
    '<p class="muted" style="margin-top:14px">KI schreibt weiter · 8 Tokens je Normseite</p><div style="display:flex;gap:8px"><button class="sm" type="button" data-act="c1">1 Seite</button><button class="ghost sm" type="button" data-act="c2">2</button><button class="ghost sm" type="button" data-act="c3">3</button></div><div id="synbox"></div>'+
    '<details style="margin-top:14px"><summary class="muted">Bild zur Seite</summary><select id="imodel">'+modelOpts+'</select><textarea id="iprompt" rows="3" placeholder="Prompt oder leer = Seitentext">'+esc(page.imagePrompt||"")+'</textarea><button class="ghost" type="button" data-act="img">Generieren</button>'+(page.imageUrl?'<img class="illu" src="'+page.imageUrl+'"/>':'')+'</details>'+
    '<p class="muted" style="margin-top:14px">Verlag</p><select id="quotes"><option value="french">Französisch « »</option><option value="german">Deutsch „ “</option><option value="english">Englisch “ ”</option></select><label class="muted"><input type="checkbox" id="adult" '+(BOOK.isAdult?"checked":"")+'/> Adult-Manuskript</label><button class="ghost" type="button" data-act="quotes">Anführungszeichen setzen</button></aside></div>';
}

function render(){
  if(!USER && VIEW!=="guest") VIEW="guest";
  document.getElementById("sidebar").innerHTML=sidebarHtml();
  document.getElementById("tabs").innerHTML=tabsHtml();
  var el=document.getElementById("content");
  if(!USER||VIEW==="guest") el.innerHTML=guestPage();
  else if(VIEW==="desk") el.innerHTML=deskPage();
  else if(VIEW==="konto") el.innerHTML=kontoPage();
  else if(VIEW==="shop") el.innerHTML=shopPage();
  else if(VIEW==="admin") el.innerHTML=(USER.role==="admin"?adminPage():guestPage());
  else if(VIEW==="edit") el.innerHTML=editorPage();
  bind();
}
function bind(){
  document.querySelectorAll("[data-go]").forEach(function(a){a.onclick=function(){go(a.getAttribute("data-go"));};});
  var gh=document.getElementById("gohome"); if(gh) gh.onclick=function(){VIEW=USER?"desk":"guest"; MSG=""; render();};
  var lo=document.getElementById("logout"); if(lo) lo.onclick=async function(){await api("/api/logout",{method:"POST",body:"{}"}); USER=null; VIEW="guest"; render();};
  var f=document.getElementById("auth");
  if(f) f.addEventListener("submit", async function(e){
    e.preventDefault(); MSG=""; OK="";
    var mode=(e.submitter && e.submitter.value==="register")?"register":"login";
    try{
      var fd=new FormData(f);
      await api("/api/"+mode,{method:"POST",body:JSON.stringify({email:fd.get("email"),password:fd.get("password")})});
      VIEW="desk"; await loadBooks();
    }catch(err){MSG=err.message; render();}
  });
  var n=document.getElementById("new"); if(n) n.onclick=function(){createBook(false);};
  var na=document.getElementById("newa"); if(na) na.onclick=function(){createBook(true);};
  document.querySelectorAll("[data-open]").forEach(function(a){a.onclick=function(e){e.preventDefault(); openBook(a.getAttribute("data-open"));};});
  document.querySelectorAll("[data-del]").forEach(function(a){a.onclick=async function(){if(!confirm("Wirklich löschen?"))return; await api("/api/books/"+a.getAttribute("data-del"),{method:"DELETE"}); await loadBooks();};});
  document.querySelectorAll("[data-pack]").forEach(function(a){a.onclick=async function(){try{await api("/api/storage",{method:"POST",body:JSON.stringify({tier:a.getAttribute("data-pack")})}); go("konto");}catch(err){alert(err.message);}};});
  var title=document.getElementById("title"); if(title) title.oninput=function(){BOOK.title=title.value; scheduleSave();};
  var body=document.getElementById("body");
  if(body){body.oninput=function(){
    BOOK.pages[ACTIVE].body=body.value;
    var next=paginate(BOOK.pages.map(function(p){return p.body||"";}),ACTIVE);
    var overflow=!fits(body.value);
    BOOK.pages=next.map(function(t,i){return {id:(BOOK.pages[i]&&BOOK.pages[i].id)||crypto.randomUUID(),body:t,imageUrl:(BOOK.pages[i]&&BOOK.pages[i].imageUrl)||"",imagePrompt:(BOOK.pages[i]&&BOOK.pages[i].imagePrompt)||""};});
    scheduleSave();
    var st=document.getElementById("stat"); if(st) st.textContent=body.value.length+" / 1500 · "+visualLines(body.value).length+" / 30 Zeilen";
    if(overflow){ ACTIVE=Math.min(ACTIVE+1, BOOK.pages.length-1); render(); var b2=document.getElementById("body"); if(b2){b2.focus(); var n=b2.value.length; b2.selectionStart=b2.selectionEnd=n;} }
  };}
  document.querySelectorAll("[data-pg]").forEach(function(b){b.onclick=function(){ACTIVE=+b.getAttribute("data-pg"); render();};});
  var addp=document.getElementById("addp"); if(addp) addp.onclick=function(){BOOK.pages.push({id:crypto.randomUUID(),body:"",imageUrl:"",imagePrompt:""}); ACTIVE=BOOK.pages.length-1; scheduleSave(); render();};
  var modeM=document.getElementById("modeM"); if(modeM) modeM.onclick=function(){BOOK.viewMode="manuscript"; render();};
  var modeB=document.getElementById("modeB"); if(modeB) modeB.onclick=function(){BOOK.viewMode="book"; render();};
  var quotes=document.getElementById("quotes"); if(quotes){quotes.value=BOOK.quotesStyle||"french"; quotes.onchange=function(){BOOK.quotesStyle=quotes.value; scheduleSave();};}
  var adult=document.getElementById("adult"); if(adult) adult.onchange=function(){BOOK.isAdult=adult.checked; scheduleSave();};
  var ip=document.getElementById("iprompt"); if(ip) ip.oninput=function(){BOOK.pages[ACTIVE].imagePrompt=ip.value;};
  document.querySelectorAll("[data-act]").forEach(function(b){b.onclick=function(){act(b.getAttribute("data-act"));};});
  var mic=document.getElementById("mic"); if(mic) mic.onclick=toggleMic;
  if(VIEW==="konto") loadLedger();
  if(VIEW==="admin" && USER && USER.role==="admin") loadAdmin();
}
async function go(v){
  if(!USER){ VIEW="guest"; render(); return; }
  if(v==="admin" && USER.role!=="admin"){ VIEW="desk"; render(); return; }
  VIEW=v; MSG="";
  if(v==="desk") await loadBooks();
  if(v==="edit" && !BOOK){ await loadBooks(); if(BOOKS[0]) await openBook(BOOKS[0].id); else await createBook(false); return; }
  render();
}
async function loadBooks(){ var d=await api("/api/books"); BOOKS=d.books||[]; render(); }
async function createBook(adult){ var d=await api("/api/books",{method:"POST",body:JSON.stringify({title:adult?"Adult-Manuskript":"Ohne Titel",isAdult:adult})}); await openBook(d.id); }
async function openBook(id){ var d=await api("/api/books/"+id); BOOK=d.book; ACTIVE=0; VIEW="edit"; render(); }
function scheduleSave(){ var st=document.getElementById("savestate"); if(st) st.textContent="Speichert …"; clearTimeout(SAVE); SAVE=setTimeout(persist,400); try{ localStorage.setItem("sb:"+BOOK.id, JSON.stringify(BOOK)); }catch(e){} }
async function persist(){ if(!BOOK) return; try{ await api("/api/books/"+BOOK.id,{method:"PUT",body:JSON.stringify(BOOK)}); var st=document.getElementById("savestate"); if(st) st.textContent="Gespeichert"; var t=document.getElementById("tk_sidebar_tokens"); if(t && USER) t.textContent=(USER.tokens|0)+" Tokens"; }catch(e){ var st=document.getElementById("savestate"); if(st) st.textContent=e.message; } }
function toggleMic(){
  var Rec=window.SpeechRecognition||window.webkitSpeechRecognition;
  if(!Rec){ alert("Diktieren geht in Chrome oder Safari auf dem Handy."); return; }
  if(MIC){ MIC.stop(); MIC=null; document.getElementById("mic").textContent="🎤 Diktieren"; return; }
  MIC=new Rec(); MIC.lang="de-DE"; MIC.continuous=true; MIC.interimResults=false;
  MIC.onresult=function(ev){
    var i, t="";
    for(i=ev.resultIndex;i<ev.results.length;i++) if(ev.results[i].isFinal) t+=ev.results[i][0].transcript;
    if(!t || !BOOK) return;
    var page=BOOK.pages[ACTIVE];
    page.body=((page.body||"")+" "+t).replace(/\\s+/g," ").trim();
    var next=paginate(BOOK.pages.map(function(p){return p.body||"";}), ACTIVE);
    BOOK.pages=next.map(function(tx,i){return {id:(BOOK.pages[i]&&BOOK.pages[i].id)||crypto.randomUUID(),body:tx,imageUrl:(BOOK.pages[i]&&BOOK.pages[i].imageUrl)||"",imagePrompt:(BOOK.pages[i]&&BOOK.pages[i].imagePrompt)||""};});
    scheduleSave(); render();
  };
  MIC.onend=function(){ MIC=null; var b=document.getElementById("mic"); if(b) b.textContent="🎤 Diktieren"; };
  MIC.start();
  document.getElementById("mic").textContent="● Aufnahme läuft — tippen zum Stoppen";
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
    else if(kind==="imp"){ WORK="Wird umformuliert …"; render(); var d=await api("/api/improve",{method:"POST",body:JSON.stringify({text:page.body||""})}); page.body=d.improved; WORK=null; scheduleSave(); render(); }
    else if(kind==="c1"||kind==="c2"||kind==="c3"){
      var n=+kind.charAt(1); WORK="KI schreibt weiter …"; render();
      var d=await api("/api/continue",{method:"POST",body:JSON.stringify({text:page.body||"",pages:n,isAdult:!!BOOK.isAdult,tier:"standard"})});
      var texts=BOOK.pages.map(function(p){return p.body||"";}); texts[ACTIVE]=(texts[ACTIVE]||"").replace(/\\s+$/,"")+"\\n\\n"+d.continuation;
      var next=paginate(texts, ACTIVE);
      BOOK.pages=next.map(function(tx,i){return {id:(BOOK.pages[i]&&BOOK.pages[i].id)||crypto.randomUUID(),body:tx,imageUrl:(BOOK.pages[i]&&BOOK.pages[i].imageUrl)||"",imagePrompt:(BOOK.pages[i]&&BOOK.pages[i].imagePrompt)||""};});
      WORK=null; scheduleSave(); render();
    }
    else if(kind==="img"){
      var model=document.getElementById("imodel").value;
      var prompt=(document.getElementById("iprompt").value||page.body||"").slice(0,1200);
      WORK="Bild entsteht …"; render();
      var d=await api("/api/image",{method:"POST",body:JSON.stringify({prompt:prompt,modelId:model,isAdult:!!BOOK.isAdult})});
      BOOK.pages[ACTIVE].imageUrl=d.url; BOOK.pages[ACTIVE].imagePrompt=prompt; WORK=null; scheduleSave(); render();
    }
    else if(kind==="quotes"){ BOOK.pages=BOOK.pages.map(function(p){return Object.assign({},p,{body:applyQuotes(p.body||"", BOOK.quotesStyle||"french")});}); scheduleSave(); render(); }
  }catch(e){ WORK=null; MSG=e.message; render(); }
}
async function loadLedger(){
  try{ var d=await api("/api/ledger"); document.getElementById("ledger").innerHTML=(d.rows||[]).map(function(r){return '<div style="display:flex;justify-content:space-between;border-bottom:1px solid var(--border-color);padding:8px 0"><span>'+esc(r.description)+'<div class="muted">'+esc(r.action_type)+' · '+new Date(r.created_at).toLocaleString("de-DE")+'</div></span><b>'+(r.token_amount>0?"+":"")+r.token_amount+'</b></div>';}).join("")||"Noch keine Buchungen."; }catch(e){}
}
async function loadAdmin(){
  try{ var d=await api("/api/admin"); document.getElementById("adminbox").innerHTML="<p>"+d.bookCount+" Manuskripte</p>"+(d.wallets||[]).map(function(w){return '<div style="display:flex;justify-content:space-between"><span>'+esc(w.user_email)+'</span><span>'+w.token_balance+' T · '+esc(w.role)+'</span></div>';}).join(""); }catch(e){ document.getElementById("adminbox").textContent=e.message; }
}
(async function(){
  try{ var d=await api("/api/me"); USER=d.user; VIEW=USER?"desk":"guest"; if(USER) await loadBooks(); else render(); }
  catch(e){ VIEW="guest"; render(); }
})();
</script>
</body>
</html>
`;
