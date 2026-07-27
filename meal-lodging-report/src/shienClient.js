// 支援記録ノート（別システム）の読み取り専用APIを呼び出す共通処理
// 認証は X-API-Key ヘッダー。設定は環境変数 SHIEN_API_BASE_URL / SHIEN_API_KEY を使う。

function getConfig() {
  const baseUrl = process.env.SHIEN_API_BASE_URL;
  const apiKey = process.env.SHIEN_API_KEY;
  if (!baseUrl || !apiKey) {
    throw new Error(
      '支援記録ノートとの連携設定（SHIEN_API_BASE_URL・SHIEN_API_KEY）がまだ環境変数に設定されていません。'
    );
  }
  return { baseUrl: baseUrl.replace(/\/$/, ''), apiKey };
}

async function shienFetch(pathname) {
  const { baseUrl, apiKey } = getConfig();
  const res = await fetch(`${baseUrl}${pathname}`, {
    headers: { 'X-API-Key': apiKey },
  });
  if (!res.ok) {
    let message = `支援記録ノートへの接続に失敗しました（HTTP ${res.status}）`;
    try {
      const body = await res.json();
      if (body && body.error) message = body.error;
    } catch (e) {
      // JSON以外のエラー応答は無視してデフォルトメッセージを使う
    }
    throw new Error(message);
  }
  return res.json();
}

async function fetchShienHomes() {
  const data = await shienFetch('/api/external/v1/homes');
  return data.homes;
}

async function fetchShienResidents(shienHomeId) {
  const data = await shienFetch(`/api/external/v1/homes/${shienHomeId}/residents`);
  return data.residents;
}

async function fetchShienRecords(residentId, type) {
  const data = await shienFetch(`/api/external/v1/residents/${residentId}/records/${type}`);
  return data.records;
}

/**
 * 食事記録(meal)・宿泊記録(stay)から、日付ごとの 夕食/宿泊/朝食 フラグを組み立てる。
 * 「その日の記録が無い＝その日は無かった」という前提で判定するが、
 * 未来日（today以降）はデータが無くて当然なので比較対象から除外する。
 */
function buildShienDailyData(mealRecords, stayRecords, dateList) {
  const todayStr = new Date().toISOString().slice(0, 10);
  const dailyData = {};

  const dateSet = new Set(dateList);

  mealRecords.forEach((r) => {
    if (!r.date || !dateSet.has(r.date)) return;
    const mealType = ((r.data || {}).mealType || '').toString();
    if (!dailyData[r.date]) dailyData[r.date] = { breakfast: false, dinner: false, lodging: false };
    if (mealType.includes('朝')) dailyData[r.date].breakfast = true;
    if (mealType.includes('夕')) dailyData[r.date].dinner = true;
  });

  stayRecords.forEach((r) => {
    if (!r.date || !dateSet.has(r.date)) return;
    if (!dailyData[r.date]) dailyData[r.date] = { breakfast: false, dinner: false, lodging: false };
    dailyData[r.date].lodging = !!(r.data || {}).stayed;
  });

  // 記録が1件も無い日で、かつ今日より前の日は「無かった」として明示的にfalseを埋める
  // （未来日はデータ自体が無くて当然なので何もしない＝比較対象から除外される）
  dateList.forEach((date) => {
    if (date > todayStr) return;
    if (!dailyData[date]) {
      dailyData[date] = { breakfast: false, dinner: false, lodging: false };
    }
  });

  return dailyData;
}

module.exports = { fetchShienHomes, fetchShienResidents, fetchShienRecords, buildShienDailyData };
