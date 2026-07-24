const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db');
const { requireAdminLogin } = require('../auth');
const { buildMatrixWorkbook, addBillingSummarySheet, buildDateList, sendWorkbook } = require('../excelExport');
const { sendJsonBackup, sendCsvBackup } = require('../backupExport');

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

// 指定した日にちの時点で有効な単価を、昇順の履歴配列から探す
function priceAt(history, date) {
  let applicable = { breakfast_price: 0, dinner_price: 0 };
  for (const h of history) {
    if (h.effective_from <= date) {
      applicable = h;
    } else {
      break;
    }
  }
  return applicable;
}

// 指定した日付範囲について、ホームごとの利用者一覧・報告データ・単価履歴をまとめる
async function buildHomesDataForRange(startDate, endDate) {
  const { rows: homes } = await pool.query('SELECT id, name FROM homes ORDER BY name ASC');
  const homesData = [];

  for (const home of homes) {
    const { rows: users } = await pool.query(
      `SELECT hu.id, hu.name FROM home_users hu
       WHERE hu.home_id = $1
         AND (hu.active = TRUE OR EXISTS (
           SELECT 1 FROM reports r WHERE r.home_user_id = hu.id AND r.report_date BETWEEN $2 AND $3
         ))
       ORDER BY hu.name ASC`,
      [home.id, startDate, endDate]
    );

    if (users.length === 0) continue; // 利用者が1人もいないホームはシートを作らない

    const userIds = users.map((u) => u.id);

    const { rows: reports } = await pool.query(
      `SELECT * FROM reports
       WHERE home_id = $1 AND report_date BETWEEN $2 AND $3 AND home_user_id IS NOT NULL`,
      [home.id, startDate, endDate]
    );

    const { rows: priceRows } = await pool.query(
      `SELECT * FROM user_price_history
       WHERE home_user_id = ANY($1) AND effective_from <= $2
       ORDER BY home_user_id ASC, effective_from ASC`,
      [userIds, endDate]
    );

    const priceHistoryByUser = {};
    priceRows.forEach((p) => {
      const key = p.home_user_id;
      if (!priceHistoryByUser[key]) priceHistoryByUser[key] = [];
      priceHistoryByUser[key].push({
        effective_from: p.effective_from.toISOString().slice(0, 10),
        breakfast_price: Number(p.breakfast_price),
        dinner_price: Number(p.dinner_price),
      });
    });

    users.forEach((u) => {
      u.priceHistory = priceHistoryByUser[u.id] || [];
    });

    const reportsByUserAndDate = {};
    reports.forEach((r) => {
      const dateKey = r.report_date.toISOString().slice(0, 10);
      if (!reportsByUserAndDate[r.home_user_id]) reportsByUserAndDate[r.home_user_id] = {};
      reportsByUserAndDate[r.home_user_id][dateKey] = r;
    });

    homesData.push({ homeName: home.name, users, reportsByUserAndDate });
  }

  return homesData;
}

// 指定した1日分をExcel出力（縦軸=日付・横軸=利用者、シート=ホーム別）
router.get('/admin/export/daily', requireAdminLogin, async (req, res) => {
  const { date } = req.query;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).send('日付を正しく指定してください（例: 2026-07-23）');
  }

  const homesData = await buildHomesDataForRange(date, date);
  const workbook = await buildMatrixWorkbook(homesData, [date], date);
  addBillingSummarySheet(workbook, homesData, [date], date);
  await sendWorkbook(res, workbook, `report_${date}.xlsx`);
});

// 指定した1か月分をExcel出力（縦軸=日付・横軸=利用者、シート=ホーム別）
router.get('/admin/export/monthly', requireAdminLogin, async (req, res) => {
  const { month } = req.query; // "YYYY-MM" 形式を想定
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).send('月を正しく指定してください（例: 2026-07）');
  }

  const [year, mon] = month.split('-').map(Number);
  const firstDay = `${month}-01`;
  const lastDayNum = new Date(year, mon, 0).getDate(); // その月の末日
  const lastDay = `${month}-${String(lastDayNum).padStart(2, '0')}`;

  const homesData = await buildHomesDataForRange(firstDay, lastDay);
  const dateList = buildDateList(firstDay, lastDay);
  const workbook = await buildMatrixWorkbook(homesData, dateList, month);
  addBillingSummarySheet(workbook, homesData, dateList, month);
  await sendWorkbook(res, workbook, `report_${month}.xlsx`);
});

// 全データのバックアップ（JSON・復旧用の完全なダンプ）
router.get('/admin/backup/json', requireAdminLogin, async (req, res) => {
  const { rows: homes } = await pool.query('SELECT * FROM homes ORDER BY id ASC');
  const { rows: homeUsers } = await pool.query('SELECT * FROM home_users ORDER BY id ASC');
  const { rows: priceHistory } = await pool.query('SELECT * FROM user_price_history ORDER BY id ASC');
  const { rows: reports } = await pool.query('SELECT * FROM reports ORDER BY id ASC');

  await sendJsonBackup(res, { homes, homeUsers, priceHistory, reports });
});

// 全期間の報告データをCSVで出力（表計算ソフトで開きやすい簡易バックアップ）
router.get('/admin/backup/csv', requireAdminLogin, async (req, res) => {
  const { rows: reports } = await pool.query(
    `SELECT r.report_date, h.name AS home_name, r.user_name, r.reporter_name,
            r.dinner, r.lodging, r.breakfast, r.created_at
     FROM reports r
     JOIN homes h ON h.id = r.home_id
     ORDER BY r.report_date ASC, h.name ASC, r.user_name ASC`
  );
  await sendCsvBackup(res, reports);
});

// ホーム削除
router.post('/admin/homes/:id/delete', requireAdminLogin, async (req, res) => {
  await pool.query('DELETE FROM homes WHERE id = $1', [req.params.id]);
  res.redirect('/admin/homes/manage');
});

// ホームごとの利用者一覧・管理画面（現在有効な単価も表示）
router.get('/admin/homes/:id/users', requireAdminLogin, async (req, res) => {
  const { rows: homeRows } = await pool.query('SELECT * FROM homes WHERE id = $1', [req.params.id]);
  const home = homeRows[0];
  if (!home) return res.redirect('/admin/homes/manage');

  const { rows: users } = await pool.query(
    `SELECT hu.*,
       (SELECT breakfast_price FROM user_price_history uph
        WHERE uph.home_user_id = hu.id AND uph.effective_from <= CURRENT_DATE
        ORDER BY uph.effective_from DESC LIMIT 1) AS current_breakfast_price,
       (SELECT dinner_price FROM user_price_history uph
        WHERE uph.home_user_id = hu.id AND uph.effective_from <= CURRENT_DATE
        ORDER BY uph.effective_from DESC LIMIT 1) AS current_dinner_price
     FROM home_users hu
     WHERE hu.home_id = $1
     ORDER BY hu.name ASC`,
    [req.params.id]
  );

  res.render('admin_home_users', { home, users });
});

// 利用者を新規追加（登録日から有効な単価履歴も同時に作成）
router.post('/admin/homes/:id/users', requireAdminLogin, async (req, res) => {
  const { name, breakfast_price, dinner_price } = req.body;
  if (name && name.trim()) {
    const bPrice = Number(breakfast_price) || 0;
    const dPrice = Number(dinner_price) || 0;
    const { rows } = await pool.query(
      `INSERT INTO home_users (home_id, name, breakfast_price, dinner_price)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [req.params.id, name.trim(), bPrice, dPrice]
    );
    const newUserId = rows[0].id;
    await pool.query(
      `INSERT INTO user_price_history (home_user_id, breakfast_price, dinner_price, effective_from)
       VALUES ($1, $2, $3, CURRENT_DATE)`,
      [newUserId, bPrice, dPrice]
    );
  }
  res.redirect(`/admin/homes/${req.params.id}/users`);
});

// 利用者の名前を更新
router.post('/admin/homes/:id/users/:userId/update', requireAdminLogin, async (req, res) => {
  const { name } = req.body;
  if (name && name.trim()) {
    await pool.query('UPDATE home_users SET name = $1 WHERE id = $2 AND home_id = $3', [
      name.trim(),
      req.params.userId,
      req.params.id,
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

// 選択した複数の利用者へ、単価改定をまとめて反映（この後も個別ページから上書き編集できる）
router.post('/admin/homes/:id/users/bulk-price-history', requireAdminLogin, async (req, res) => {
  const { user_ids, effective_from, breakfast_price, dinner_price } = req.body;

  const idsArray = Array.isArray(user_ids) ? user_ids : user_ids ? [user_ids] : [];

  if (idsArray.length > 0 && effective_from) {
    const bPrice = Number(breakfast_price) || 0;
    const dPrice = Number(dinner_price) || 0;

    for (const userId of idsArray) {
      // 対象ホームに属する利用者であることを確認してから反映（他ホームのIDが紛れ込んでも無視される）
      await pool.query(
        `INSERT INTO user_price_history (home_user_id, breakfast_price, dinner_price, effective_from)
         SELECT id, $2, $3, $4 FROM home_users WHERE id = $1 AND home_id = $5
         ON CONFLICT (home_user_id, effective_from)
         DO UPDATE SET breakfast_price = EXCLUDED.breakfast_price, dinner_price = EXCLUDED.dinner_price`,
        [userId, bPrice, dPrice, effective_from, req.params.id]
      );
    }
  }

  res.redirect(`/admin/homes/${req.params.id}/users`);
});

// 単価改定履歴の管理画面
router.get('/admin/homes/:id/users/:userId/price-history', requireAdminLogin, async (req, res) => {
  const { rows: userRows } = await pool.query(
    'SELECT * FROM home_users WHERE id = $1 AND home_id = $2',
    [req.params.userId, req.params.id]
  );
  const user = userRows[0];
  if (!user) return res.redirect(`/admin/homes/${req.params.id}/users`);

  const { rows: history } = await pool.query(
    `SELECT * FROM user_price_history WHERE home_user_id = $1 ORDER BY effective_from DESC`,
    [req.params.userId]
  );

  res.render('admin_price_history', { homeId: req.params.id, user, history });
});

// 単価改定を登録（同じ適用開始日であれば上書き更新）
router.post('/admin/homes/:id/users/:userId/price-history', requireAdminLogin, async (req, res) => {
  const { effective_from, breakfast_price, dinner_price } = req.body;
  if (effective_from) {
    await pool.query(
      `INSERT INTO user_price_history (home_user_id, breakfast_price, dinner_price, effective_from)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (home_user_id, effective_from)
       DO UPDATE SET breakfast_price = EXCLUDED.breakfast_price, dinner_price = EXCLUDED.dinner_price`,
      [req.params.userId, Number(breakfast_price) || 0, Number(dinner_price) || 0, effective_from]
    );
  }
  res.redirect(`/admin/homes/${req.params.id}/users/${req.params.userId}/price-history`);
});

// 単価改定履歴を1件削除
router.post(
  '/admin/homes/:id/users/:userId/price-history/:historyId/delete',
  requireAdminLogin,
  async (req, res) => {
    await pool.query('DELETE FROM user_price_history WHERE id = $1 AND home_user_id = $2', [
      req.params.historyId,
      req.params.userId,
    ]);
    res.redirect(`/admin/homes/${req.params.id}/users/${req.params.userId}/price-history`);
  }
);

module.exports = router;
