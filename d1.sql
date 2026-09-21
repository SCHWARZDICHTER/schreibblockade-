-- Schreibblockade — Cloudflare D1 (SQLite)
-- In der D1-Konsole ausführen. Der Worker legt dieselben Tabellen
-- auch selbst an (CREATE IF NOT EXISTS). Dieses SQL ist das Backup
-- und für eine bestehende Tintenkiller-Datenbank zum Nachziehen.

CREATE TABLE IF NOT EXISTS user_tokens (
  user_email TEXT PRIMARY KEY,
  token_balance INTEGER NOT NULL DEFAULT 0,
  role TEXT DEFAULT 'user',
  password_hash TEXT,
  password_salt TEXT,
  password_iterations INTEGER DEFAULT 100000,
  failed_login_attempts INTEGER DEFAULT 0,
  locked_until INTEGER,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_email TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS gt_token_ledger (
  id TEXT PRIMARY KEY,
  user_email TEXT NOT NULL,
  action_type TEXT NOT NULL,
  description TEXT NOT NULL,
  token_amount INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS gt_digistore24_token_orders (
  order_key TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  buyer_email TEXT NOT NULL,
  product_id TEXT NOT NULL,
  tokens INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  processed_at TEXT,
  note TEXT
);

CREATE TABLE IF NOT EXISTS tk_books_v2 (
  id TEXT PRIMARY KEY,
  user_email TEXT NOT NULL,
  title TEXT NOT NULL,
  chapters TEXT NOT NULL,
  is_public INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  dedication_from TEXT,
  dedication_to TEXT,
  is_adult_content INTEGER NOT NULL DEFAULT 0,
  quotes_style TEXT DEFAULT 'french',
  view_mode TEXT DEFAULT 'manuscript',
  trim_format TEXT DEFAULT 'taschenbuch',
  author_name TEXT DEFAULT '',
  blurb TEXT DEFAULT '',
  imprint TEXT DEFAULT '',
  updated_at TEXT,
  bleed_mm INTEGER DEFAULT 3,
  page_number_pos TEXT DEFAULT 'bottom-center',
  page_number_visible INTEGER DEFAULT 1,
  custom_width_mm INTEGER,
  custom_height_mm INTEGER
);


CREATE TABLE IF NOT EXISTS gt_ai_gallery_support (
  user_email TEXT PRIMARY KEY,
  active_since TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  plan_key TEXT NOT NULL DEFAULT 's'
);

CREATE INDEX IF NOT EXISTS idx_tk_books_user ON tk_books_v2(user_email);
CREATE INDEX IF NOT EXISTS idx_ledger_user ON gt_token_ledger(user_email, created_at);

-- Falls tk_books_v2 schon existiert: nacheinander ausführen,
-- Fehler "duplicate column name" ignorieren.
-- ALTER TABLE tk_books_v2 ADD COLUMN quotes_style TEXT DEFAULT 'french';
-- ALTER TABLE tk_books_v2 ADD COLUMN view_mode TEXT DEFAULT 'manuscript';
-- ALTER TABLE tk_books_v2 ADD COLUMN trim_format TEXT DEFAULT 'taschenbuch';
-- ALTER TABLE tk_books_v2 ADD COLUMN author_name TEXT DEFAULT '';
-- ALTER TABLE tk_books_v2 ADD COLUMN blurb TEXT DEFAULT '';
-- ALTER TABLE tk_books_v2 ADD COLUMN imprint TEXT DEFAULT '';
-- ALTER TABLE tk_books_v2 ADD COLUMN updated_at TEXT;
-- ALTER TABLE tk_books_v2 ADD COLUMN bleed_mm INTEGER DEFAULT 3;
-- ALTER TABLE tk_books_v2 ADD COLUMN page_number_pos TEXT DEFAULT 'bottom-center';
-- ALTER TABLE tk_books_v2 ADD COLUMN page_number_visible INTEGER DEFAULT 1;
-- ALTER TABLE tk_books_v2 ADD COLUMN custom_width_mm INTEGER;
-- ALTER TABLE tk_books_v2 ADD COLUMN custom_height_mm INTEGER;
-- ALTER TABLE gt_ai_gallery_support ADD COLUMN plan_key TEXT NOT NULL DEFAULT 's';


