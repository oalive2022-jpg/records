const express = require('express');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const pool = require('../db');
const { requireAdminLogin } = require('../auth');
const { buildMatrixWorkbook, addBillingSummarySheet, buildDateList, sendWorkbook } = require('../excelExport');
const { sendJsonBackup, sendCsvBackup } = require('../backupExport');
const { parsePochipassExcel } = require('../pochipassParser');
const { fetchShienHomes, fetchShienResidents, fetchShienRecords, buildShienDailyData } = require('../shienClient');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

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

// ポチパス照合画面（アップロードフォーム）
router.get('/admin/homes/:id/reconcile', requireAdminLogin, async (req, res) => {
  const { rows: homeRows } = await pool.query('SELECT * FROM homes WHERE id = $1', [req.params.id]);
  const home = homeRows[0];
  if (!home) return res.redirect('/admin/homes/manage');

  res.render('admin_reconcile', { home, result: null, error: null });
});

// ポチパスの実績記録票(xlsx)をアップロードして、このサイトの報告データと突き合わせる
router.post(
  '/admin/homes/:id/reconcile',
  requireAdminLogin,
  upload.single('pochipass_file'),
  async (req, res) => {
    const { rows: homeRows } = await pool.query('SELECT * FROM homes WHERE id = $1', [req.params.id]);
    const home = homeRows[0];
    if (!home) return res.redirect('/admin/homes/manage');

    if (!req.file) {
      return res.render('admin_reconcile', { home, result: null, error: 'ファイルを選択してください。' });
    }

    let parsed;
    try {
      parsed = await parsePochipassExcel(req.file.buffer);
    } catch (err) {
      return res.render('admin_reconcile', { home, result: null, error: err.message });
    }

    const { rows: matchedUsers } = await pool.query(
      'SELECT * FROM home_users WHERE home_id = $1 AND name = $2',
      [req.params.id, parsed.userName]
    );

    if (matchedUsers.length === 0) {
      return res.render('admin_reconcile', {
        home,
        result: null,
        error: `「${parsed.userName}」という名前の利用者が、このホームの利用者一覧に見つかりませんでした。名前の表記が完全に一致しているか確認してください。`,
      });
    }

    const user = matchedUsers[0];
    const monthStr = `${parsed.year}-${String(parsed.month).padStart(2, '0')}`;
    const firstDay = `${monthStr}-01`;
    const lastDayNum = new Date(parsed.year, parsed.month, 0).getDate();
    const lastDay = `${monthStr}-${String(lastDayNum).padStart(2, '0')}`;
    const dateList = buildDateList(firstDay, lastDay);

    const { rows: siteReports } = await pool.query(
      `SELECT * FROM reports WHERE home_user_id = $1 AND report_date BETWEEN $2 AND $3`,
      [user.id, firstDay, lastDay]
    );
    const siteByDate = {};
    siteReports.forEach((r) => {
      siteByDate[r.report_date.toISOString().slice(0, 10)] = r;
    });

    const result = buildComparisonResult(parsed.userName, monthStr, dateList, parsed.dailyData, siteByDate);
    res.render('admin_reconcile', { home, result, error: null });
  }
);

// 参照元データ（ポチパスの解析結果 or 支援記録ノートAPIの結果）と、このサイトの報告データを
// 日付ごとに突き合わせて、照合結果画面用のデータ構造を組み立てる共通ロジック
function buildComparisonResult(userName, monthStr, dateList, referenceByDate, siteByDate) {
  const weekdays = ['日', '月', '火', '水', '木', '金', '土'];
  const rows = dateList.map((date) => {
    const ref = referenceByDate[date] || null;
    const site = siteByDate[date] || null;
    const d = new Date(date + 'T00:00:00');

    const fields = ['dinner', 'lodging', 'breakfast'].map((key) => {
      const pochiVal = ref ? !!ref[key] : null;
      const siteVal = site ? !!site[key] : null;
      let status;
      if (ref === null && site === null) status = 'no_data';
      else if (ref === null) status = 'pochi_missing';
      else if (site === null) status = 'site_missing';
      else if (pochiVal === siteVal) status = 'match';
      else status = 'mismatch';
      return { key, pochiVal, siteVal, status };
    });

    const hasIssue = fields.some((f) => f.status === 'mismatch' || f.status === 'site_missing');

    return { date, weekday: weekdays[d.getDay()], fields, hasIssue };
  });

  return {
    userName,
    month: monthStr,
    rows,
    issueCount: rows.filter((r) => r.hasIssue).length,
  };
}

// ---------- 支援記録ノート（外部システム）とのID紐付け設定 ----------
router.get('/admin/homes/:id/shien-link', requireAdminLogin, async (req, res) => {
  const { rows: homeRows } = await pool.query('SELECT * FROM homes WHERE id = $1', [req.params.id]);
  const home = homeRows[0];
  if (!home) return res.redirect('/admin/homes/manage');

  const { rows: localUsers } = await pool.query(
    'SELECT * FROM home_users WHERE home_id = $1 ORDER BY name ASC',
    [req.params.id]
  );

  let shienHomes = [];
  let shienResidents = [];
  let error = null;

  try {
    shienHomes = await fetchShienHomes();
    if (home.shien_home_id) {
      shienResidents = await fetchShienResidents(home.shien_home_id);
    }
  } catch (err) {
    error = err.message;
  }

  res.render('admin_shien_link', { home, localUsers, shienHomes, shienResidents, error });
});

// 支援記録ノート側の「どのホームか」を選択
router.post('/admin/homes/:id/shien-link/select-home', requireAdminLogin, async (req, res) => {
  const { shien_home_id } = req.body;
  await pool.query('UPDATE homes SET shien_home_id = $1 WHERE id = $2', [shien_home_id || null, req.params.id]);
  res.redirect(`/admin/homes/${req.params.id}/shien-link`);
});

// 各利用者と、支援記録ノート側の利用者IDとの紐付けを保存
router.post('/admin/homes/:id/shien-link', requireAdminLogin, async (req, res) => {
  const { rows: localUsers } = await pool.query('SELECT id FROM home_users WHERE home_id = $1', [
    req.params.id,
  ]);

  for (const u of localUsers) {
    const residentId = req.body[`resident_id_${u.id}`] || null;
    await pool.query('UPDATE home_users SET shien_resident_id = $1 WHERE id = $2', [residentId, u.id]);
  }

  res.redirect(`/admin/homes/${req.params.id}/shien-link`);
});

// ---------- 支援記録ノートAPIから自動取得して照合 ----------
router.get('/admin/homes/:id/users/:userId/reconcile-auto', requireAdminLogin, async (req, res) => {
  const { rows: homeRows } = await pool.query('SELECT * FROM homes WHERE id = $1', [req.params.id]);
  const home = homeRows[0];
  if (!home) return res.redirect('/admin/homes/manage');

  const { rows: userRows } = await pool.query(
    'SELECT * FROM home_users WHERE id = $1 AND home_id = $2',
    [req.params.userId, req.params.id]
  );
  const user = userRows[0];
  if (!user) return res.redirect(`/admin/homes/${req.params.id}/users`);

  const month = req.query.month || new Date().toISOString().slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(month)) {
    return res.render('admin_reconcile_auto', { home, user, month, result: null, error: '月の指定が正しくありません。' });
  }

  if (!user.shien_resident_id) {
    return res.render('admin_reconcile_auto', {
      home,
      user,
      month,
      result: null,
      error: 'この利用者はまだ支援記録ノート側の利用者と紐付けされていません。「支援記録ノートと紐付け設定」から設定してください。',
    });
  }

  const [year, mon] = month.split('-').map(Number);
  const firstDay = `${month}-01`;
  const lastDayNum = new Date(year, mon, 0).getDate();
  const lastDay = `${month}-${String(lastDayNum).padStart(2, '0')}`;
  const dateList = buildDateList(firstDay, lastDay);

  let result;
  try {
    const [mealRecords, stayRecords] = await Promise.all([
      fetchShienRecords(user.shien_resident_id, 'meal'),
      fetchShienRecords(user.shien_resident_id, 'stay'),
    ]);
    const referenceByDate = buildShienDailyData(mealRecords, stayRecords, dateList);

    const { rows: siteReports } = await pool.query(
      `SELECT * FROM reports WHERE home_user_id = $1 AND report_date BETWEEN $2 AND $3`,
      [user.id, firstDay, lastDay]
    );
    const siteByDate = {};
    siteReports.forEach((r) => {
      siteByDate[r.report_date.toISOString().slice(0, 10)] = r;
    });

    result = buildComparisonResult(user.name, month, dateList, referenceByDate, siteByDate);
  } catch (err) {
    return res.render('admin_reconcile_auto', { home, user, month, result: null, error: err.message });
  }

  res.render('admin_reconcile_auto', { home, user, month, result, error: null });
});

module.exports = router;
