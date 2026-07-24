require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('../src/db');

async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  try {
    await pool.query(sql);
    console.log('✅ マイグレーション完了（テーブル作成済み）');
  } catch (err) {
    console.error('❌ マイグレーション失敗:', err);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

migrate();
