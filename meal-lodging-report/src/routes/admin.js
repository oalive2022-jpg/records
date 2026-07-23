const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db');
const { requireAdminLogin } = require('../auth');
const { buildReportWorkbook, sendWorkbook } = require('../excelExport');

const router = express.Router();

router.get('/admin/login', (req, res) => {
  res.render('admin_login', { error: null });
});

router.post('/admin/login', (req, res) => {
  const { password } = req.body;
  if (password && password === process.env.ADMIN_PASSWORD) {
    req.session.isAdmin = true;
    return res.redirect('/admin');
  }
  res.render('admin_login', { error: 'パスワードが違います' });
});

router.get('/admin/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/admin/login'));
});

// 全ホーム横断ダッシュボード（ホーム・日付で絞り込み可能）
router.get('/admin', requireAdminLogin, async (req, res) => {
  const { home_id, date_from, date_to } = req.query;

  const conditions = [];
  const params = [];

  if (home_id) {
    params.push(home_id);
    conditions.push(`r.home_id = $${params.length}`);
  }
  if (date_from) {
    params.push(date_from);
    conditions.push(`r.report_date >= $${params.length}`);
  }
  if (date_to) {
    params.push(date_to);
    conditions.push(`r.report_date <= $${params.length}`);
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const { rows: reports } = await pool.query(
    `SELECT r.*, h.name AS home_name
     FROM reports r
     JOIN homes h ON h.id = r.home_id
     ${whereClause}
     ORDER BY r.report_date DESC, h.name ASC, r.created_at DESC
     LIMIT 500`,
    params
  );

  const { rows: homes } = await pool.query('SELECT id, name FROM homes ORDER BY name ASC');

  res.render('admin_dashboard', {
    reports,
    homes,
    filters: { home_id: home_id || '', date_from: date_from || '', date_to: date_to || '' },
    message: null,
  });
});

// ホーム新規追加
router.post('/admin/homes', requireAdminLogin, async (req, res) => {
  const { name, password } = req.body;
  if (!name || !password) return res.redirect('/admin/homes/manage');

  const hash = await bcrypt.hash(password, 10);
  try {
    await pool.query('INSERT INTO homes (name, password_hash) VALUES ($1, $2)', [name, hash]);
  } catch (err) {
    // 名前重複などのエラーは簡易的に無視してリダイレクト（必要ならメッセージ表示に拡張可）
  }
  res.redirect('/admin/homes/manage');
});

// ホーム管理画面（追加・パスワードリセット・削除）
router.get('/admin/homes/manage', requireAdminLogin, async (req, res) => {
  const { rows: homes } = await pool.query(
    'SELECT id, name, created_at FROM homes ORDER BY name ASC'
  );
  res.render('admin_homes', { homes, message: null });
});

// パスワードリセット
router.post('/admin/homes/:id/reset-password', requireAdminLogin, async (req, res) => {
  const { password } = req.body;
  if (password) {
    const hash = await bcrypt.hash(password, 10);
    await pool.query('UPDATE homes SET password_hash = $1 WHERE id = $2', [hash, req.params.id]);
  }
  res.redirect('/admin/homes/manage');
});

// 指定した1日分をExcel出力
router.get('/admin/export/daily', requireAdminLogin, async (req, res) => {
  const { date } = req.query;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).send('日付を正しく指定してください（例: 2026-07-23）');
  }

  const { rows } = await pool.query(
    `SELECT r.*, h.name AS home_name
     FROM reports r
     JOIN homes h ON h.id = r.home_id
     WHERE r.report_date = $1
     ORDER BY h.name ASC, r.user_name ASC`,
    [date]
  );

  const workbook = await buildReportWorkbook(rows, `${date} 報告`);
  await sendWorkbook(res, workbook, `report_${date}.xlsx`);
});

// 指定した1か月分をExcel出力
router.get('/admin/export/monthly', requireAdminLogin, async (req, res) => {
  const { month } = req.query; // "YYYY-MM" 形式を想定
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).send('月を正しく指定してください（例: 2026-07）');
  }

  const { rows } = await pool.query(
    `SELECT r.*, h.name AS home_name
     FROM reports r
     JOIN homes h ON h.id = r.home_id
     WHERE to_char(r.report_date, 'YYYY-MM') = $1
     ORDER BY h.name ASC, r.report_date ASC, r.user_name ASC`,
    [month]
  );

  const workbook = await buildReportWorkbook(rows, `${month} 月次報告`);
  await sendWorkbook(res, workbook, `report_${month}.xlsx`);
});

// ホーム削除
router.post('/admin/homes/:id/delete', requireAdminLogin, async (req, res) => {
  await pool.query('DELETE FROM homes WHERE id = $1', [req.params.id]);
  res.redirect('/admin/homes/manage');
});

// ホームごとの利用者一覧・管理画面
router.get('/admin/homes/:id/users', requireAdminLogin, async (req, res) => {
  const { rows: homeRows } = await pool.query('SELECT * FROM homes WHERE id = $1', [req.params.id]);
  const home = homeRows[0];
  if (!home) return res.redirect('/admin/homes/manage');

  const { rows: users } = await pool.query(
    'SELECT * FROM home_users WHERE home_id = $1 ORDER BY name ASC',
    [req.params.id]
  );

  res.render('admin_home_users', { home, users });
});

// 利用者を新規追加
router.post('/admin/homes/:id/users', requireAdminLogin, async (req, res) => {
  const { name } = req.body;
  if (name && name.trim()) {
    await pool.query('INSERT INTO home_users (home_id, name) VALUES ($1, $2)', [
      req.params.id,
      name.trim(),
    ]);
  }
  res.redirect(`/admin/homes/${req.params.id}/users`);
});

// 利用者の有効/無効を切り替え（削除せずに一時的に報告対象から外したい場合用）
router.post('/admin/homes/:id/users/:userId/toggle', requireAdminLogin, async (req, res) => {
  await pool.query('UPDATE home_users SET active = NOT active WHERE id = $1 AND home_id = $2', [
    req.params.userId,
    req.params.id,
  ]);
  res.redirect(`/admin/homes/${req.params.id}/users`);
});

// 利用者を削除
router.post('/admin/homes/:id/users/:userId/delete', requireAdminLogin, async (req, res) => {
  await pool.query('DELETE FROM home_users WHERE id = $1 AND home_id = $2', [
    req.params.userId,
    req.params.id,
  ]);
  res.redirect(`/admin/homes/${req.params.id}/users`);
});

module.exports = router;
