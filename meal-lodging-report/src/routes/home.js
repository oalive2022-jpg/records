const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db');
const { requireHomeLogin } = require('../auth');

const router = express.Router();

// ログイン画面表示
router.get('/login', async (req, res) => {
  const { rows: homes } = await pool.query('SELECT id, name FROM homes ORDER BY name ASC');
  res.render('login', { homes, error: null });
});

// ログイン処理
router.post('/login', async (req, res) => {
  const { home_id, password } = req.body;
  const { rows } = await pool.query('SELECT * FROM homes WHERE id = $1', [home_id]);
  const home = rows[0];

  if (!home) {
    const { rows: homes } = await pool.query('SELECT id, name FROM homes ORDER BY name ASC');
    return res.render('login', { homes, error: 'ホームを選択してください' });
  }

  const ok = await bcrypt.compare(password || '', home.password_hash);
  if (!ok) {
    const { rows: homes } = await pool.query('SELECT id, name FROM homes ORDER BY name ASC');
    return res.render('login', { homes, error: 'パスワードが違います' });
  }

  req.session.homeId = home.id;
  req.session.homeName = home.name;
  res.redirect('/report');
});

router.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// 報告フォーム＋自ホームの最近の報告一覧
router.get('/report', requireHomeLogin, async (req, res) => {
  const reportDate = req.query.report_date || new Date().toISOString().slice(0, 10);
  const reporterName = req.query.reporter_name || '';

  const { rows: users } = await pool.query(
    `SELECT * FROM home_users WHERE home_id = $1 AND active = TRUE ORDER BY name ASC`,
    [req.session.homeId]
  );

  const { rows: todaysReports } = await pool.query(
    `SELECT * FROM reports WHERE home_id = $1 AND report_date = $2`,
    [req.session.homeId, reportDate]
  );
  const reportsByUser = {};
  todaysReports.forEach((r) => {
    if (r.home_user_id) reportsByUser[r.home_user_id] = r;
  });

  const { rows: reports } = await pool.query(
    `SELECT * FROM reports WHERE home_id = $1 ORDER BY report_date DESC, created_at DESC LIMIT 100`,
    [req.session.homeId]
  );

  const unreportedUsers = users.filter((u) => !reportsByUser[u.id]).map((u) => u.name);

  res.render('report_form', {
    homeName: req.session.homeName,
    users,
    reportsByUser,
    reports,
    reportDate,
    reporterName,
    unreportedUsers,
    error: users.length === 0 ? '利用者がまだ登録されていません。管理者に利用者登録を依頼してください。' : null,
  });
});

// 報告登録（同じ利用者・同じ日ならば上書き更新）
router.post('/report', requireHomeLogin, async (req, res) => {
  const { report_date, reporter_name, home_user_id, dinner, lodging, breakfast } = req.body;

  if (!report_date || !reporter_name || !home_user_id) {
    return res.redirect(
      `/report?report_date=${encodeURIComponent(report_date || '')}&reporter_name=${encodeURIComponent(reporter_name || '')}`
    );
  }

  const { rows: userRows } = await pool.query(
    'SELECT name FROM home_users WHERE id = $1 AND home_id = $2',
    [home_user_id, req.session.homeId]
  );
  if (!userRows[0]) {
    return res.redirect('/report');
  }
  const userName = userRows[0].name;

  await pool.query(
    `INSERT INTO reports (home_id, home_user_id, report_date, user_name, reporter_name, dinner, lodging, breakfast)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (home_id, home_user_id, report_date) WHERE home_user_id IS NOT NULL
     DO UPDATE SET
       user_name = EXCLUDED.user_name,
       reporter_name = EXCLUDED.reporter_name,
       dinner = EXCLUDED.dinner,
       lodging = EXCLUDED.lodging,
       breakfast = EXCLUDED.breakfast`,
    [
      req.session.homeId,
      home_user_id,
      report_date,
      userName,
      reporter_name,
      dinner === 'on',
      lodging === 'on',
      breakfast === 'on',
    ]
  );

  res.redirect(
    `/report?report_date=${encodeURIComponent(report_date)}&reporter_name=${encodeURIComponent(reporter_name)}&tab=${home_user_id}`
  );
});

// 自ホーム内の報告削除（入力ミス訂正用）
router.post('/report/:id/delete', requireHomeLogin, async (req, res) => {
  await pool.query('DELETE FROM reports WHERE id = $1 AND home_id = $2', [
    req.params.id,
    req.session.homeId,
  ]);
  res.redirect('/report');
});

module.exports = router;
