const { Pool } = require('pg');

// RenderのPostgresは外部/内部どちらの接続文字列でもSSLが必要になることが多いので、
// 本番(production)ではSSLを有効にする。ローカル開発では無効。
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

module.exports = pool;
