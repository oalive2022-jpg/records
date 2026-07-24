// JSON全データバックアップ（復旧用。全テーブルをそのままダンプする）
async function sendJsonBackup(res, data) {
  const filename = `backup_${new Date().toISOString().slice(0, 10)}.json`;
  const payload = {
    exported_at: new Date().toISOString(),
    ...data,
  };
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(JSON.stringify(payload, null, 2));
}

// CSVの値エスケープ（カンマ・改行・ダブルクォートを含む場合は "" で囲む）
function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

// 全期間の報告データをCSVで出力（Excelで文字化けしないようUTF-8 BOM付き）
async function sendCsvBackup(res, reports) {
  const filename = `reports_backup_${new Date().toISOString().slice(0, 10)}.csv`;
  const header = ['日付', 'ホーム', '利用者名', '報告者', '夕食', '宿泊', '朝食', '登録日時'];

  const lines = [header.map(csvEscape).join(',')];
  reports.forEach((r) => {
    lines.push(
      [
        r.report_date.toISOString().slice(0, 10),
        r.home_name,
        r.user_name,
        r.reporter_name,
        r.dinner ? '〇' : '×',
        r.lodging ? '〇' : '×',
        r.breakfast ? '〇' : '×',
        r.created_at.toISOString(),
      ]
        .map(csvEscape)
        .join(',')
    );
  });

  const csvBody = '\uFEFF' + lines.join('\r\n'); // BOMを付与しExcelでの文字化けを防ぐ

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csvBody);
}

module.exports = { sendJsonBackup, sendCsvBackup };
