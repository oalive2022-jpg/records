-- ホーム（施設）テーブル
CREATE TABLE IF NOT EXISTS homes (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- ホームごとの利用者マスタ（管理者が事前登録）
CREATE TABLE IF NOT EXISTS home_users (
  id SERIAL PRIMARY KEY,
  home_id INTEGER NOT NULL REFERENCES homes(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- 既存DBに対しても安全に反映されるよう、後から単価列を追加（朝食・夕食で別単価）
ALTER TABLE home_users ADD COLUMN IF NOT EXISTS breakfast_price NUMERIC(10,2) NOT NULL DEFAULT 0;
ALTER TABLE home_users ADD COLUMN IF NOT EXISTS dinner_price NUMERIC(10,2) NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_home_users_home ON home_users(home_id);

-- 食事・宿泊報告テーブル
CREATE TABLE IF NOT EXISTS reports (
  id SERIAL PRIMARY KEY,
  home_id INTEGER NOT NULL REFERENCES homes(id) ON DELETE CASCADE,
  report_date DATE NOT NULL DEFAULT CURRENT_DATE,
  user_name TEXT NOT NULL,
  reporter_name TEXT NOT NULL,
  dinner BOOLEAN NOT NULL,
  lodging BOOLEAN NOT NULL,
  breakfast BOOLEAN NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- 既存DBに対しても安全に反映されるよう、後から列を追加
ALTER TABLE reports ADD COLUMN IF NOT EXISTS home_user_id INTEGER REFERENCES home_users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_reports_home_date ON reports(home_id, report_date);

-- 同じ利用者・同じ日の報告は1件にまとめる（再登録は上書き更新にするため）
CREATE UNIQUE INDEX IF NOT EXISTS idx_reports_unique_daily
  ON reports(home_id, home_user_id, report_date)
  WHERE home_user_id IS NOT NULL;

-- express-sessionのセッション保存用テーブル（connect-pg-simpleが要求する形式）
CREATE TABLE IF NOT EXISTS "session" (
  "sid" varchar NOT NULL COLLATE "default",
  "sess" json NOT NULL,
  "expire" timestamp(6) NOT NULL,
  CONSTRAINT "session_pkey" PRIMARY KEY ("sid") NOT DEFERRABLE INITIALLY IMMEDIATE
)
WITH (OIDS=FALSE);

CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");
