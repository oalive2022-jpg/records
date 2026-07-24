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
-- ※これは「現在の参考値」として残すのみで、実際の請求計算は下のuser_price_historyを使う
ALTER TABLE home_users ADD COLUMN IF NOT EXISTS breakfast_price NUMERIC(10,2) NOT NULL DEFAULT 0;
ALTER TABLE home_users ADD COLUMN IF NOT EXISTS dinner_price NUMERIC(10,2) NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_home_users_home ON home_users(home_id);

-- 単価改定履歴（「いつから」その単価が有効かを記録し、月の途中で単価が変わっても
-- 過去分は改定前の単価で正しく計算できるようにする）
CREATE TABLE IF NOT EXISTS user_price_history (
  id SERIAL PRIMARY KEY,
  home_user_id INTEGER NOT NULL REFERENCES home_users(id) ON DELETE CASCADE,
  breakfast_price NUMERIC(10,2) NOT NULL DEFAULT 0,
  dinner_price NUMERIC(10,2) NOT NULL DEFAULT 0,
  effective_from DATE NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_price_history_unique_date
  ON user_price_history(home_user_id, effective_from);
CREATE INDEX IF NOT EXISTS idx_price_history_lookup
  ON user_price_history(home_user_id, effective_from);

-- 既存の利用者で単価履歴が1件も無い場合、現在の単価を「登録日から有効」として初期履歴を作る
INSERT INTO user_price_history (home_user_id, breakfast_price, dinner_price, effective_from)
SELECT hu.id, hu.breakfast_price, hu.dinner_price, hu.created_at::date
FROM home_users hu
WHERE NOT EXISTS (
  SELECT 1 FROM user_price_history uph WHERE uph.home_user_id = hu.id
)
ON CONFLICT (home_user_id, effective_from) DO NOTHING;

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
