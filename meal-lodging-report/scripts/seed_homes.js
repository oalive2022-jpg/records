// 使い方: node scripts/seed_homes.js "ホームA" "設定したいパスワード"
require('dotenv').config();
const bcrypt = require('bcryptjs');
const pool = require('../src/db');

async function main() {
  const [name, password] = process.argv.slice(2);
  if (!name || !password) {
    console.log('使い方: node scripts/seed_homes.js "ホーム名" "パスワード"');
    process.exit(1);
  }
  const hash = await bcrypt.hash(password, 10);
  try {
    await pool.query(
      `INSERT INTO homes (name, password_hash) VALUES ($1, $2)
       ON CONFLICT (name) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
      [name, hash]
    );
    console.log(`✅ ホーム「${name}」を登録（またはパスワードを更新）しました`);
  } catch (err) {
    console.error('❌ 登録失敗:', err);
  } finally {
    await pool.end();
  }
}

main();
