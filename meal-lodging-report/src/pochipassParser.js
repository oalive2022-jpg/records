const ExcelJS = require('exceljs');

/**
 * ポチパスの「共同生活援助サービス提供実績記録票」xlsxを解析する。
 *
 * 想定フォーマット（サンプルファイルに基づく）:
 *  - 3行目 D列: "2026年07月" のような年月
 *  - 4行目 AA列(27列目): "伊藤剛士 様" のような利用者名
 *  - 12行目以降: B列=日付, E列=曜日, H列=支援実績("サービス有"等), BH列(60列目)=備考
 *    備考欄に「朝食：◯◯円」の文字列があればその日は朝食あり、無ければ朝食なし（夕食も同様）
 *  - "合計" という行が出てきたらデータ終端
 */
async function parsePochipassExcel(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) {
    throw new Error('シートが見つかりませんでした。ファイル形式をご確認ください。');
  }

  // 年月を探す（3行目付近を想定するが、念のため上部10行をスキャン）
  let year = null;
  let month = null;
  for (let r = 1; r <= 10 && !year; r += 1) {
    for (let c = 1; c <= sheet.columnCount; c += 1) {
      const v = sheet.getCell(r, c).value;
      if (typeof v === 'string') {
        const m = v.match(/(\d{4})年(\d{1,2})月/);
        if (m) {
          year = Number(m[1]);
          month = Number(m[2]);
          break;
        }
      }
    }
  }
  if (!year || !month) {
    throw new Error('年月の情報が見つかりませんでした。ポチパスの実績記録票の形式か確認してください。');
  }

  // 利用者名を探す（「様」を含むセルを上部10行からスキャン）
  let userName = null;
  for (let r = 1; r <= 10 && !userName; r += 1) {
    for (let c = 1; c <= sheet.columnCount; c += 1) {
      const v = sheet.getCell(r, c).value;
      if (typeof v === 'string' && v.includes('様')) {
        userName = v.replace(/様/g, '').trim();
        break;
      }
    }
  }
  if (!userName) {
    throw new Error('利用者名が見つかりませんでした。ポチパスの実績記録票の形式か確認してください。');
  }

  // 日別データを解析（B列=日付, E列=曜日, H列=支援実績, BH列=備考）
  const dailyData = {};
  const monthStr = String(month).padStart(2, '0');

  for (let r = 1; r <= sheet.rowCount; r += 1) {
    const dateCell = sheet.getCell(r, 2).value;
    if (dateCell === null || dateCell === undefined || dateCell === '') continue;
    if (String(dateCell).includes('合計')) break; // 合計行に到達したら終了

    const dayNum = parseInt(String(dateCell), 10);
    if (Number.isNaN(dayNum) || dayNum < 1 || dayNum > 31) continue;

    const service = sheet.getCell(r, 8).value;
    if (service === null || service === undefined || service === '') continue; // その日はまだデータが無い（未来日など）

    const remarksRaw = sheet.getCell(r, 60).value;
    const remarks = remarksRaw ? String(remarksRaw) : '';

    const dateStr = `${year}-${monthStr}-${String(dayNum).padStart(2, '0')}`;
    dailyData[dateStr] = {
      lodging: String(service).includes('サービス有'),
      breakfast: remarks.includes('朝食：'),
      dinner: remarks.includes('夕食：'),
    };
  }

  return { userName, year, month, dailyData };
}

module.exports = { parsePochipassExcel };
