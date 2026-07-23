const ExcelJS = require('exceljs');

// 報告データの配列からExcelワークブックを作成する共通関数
async function buildReportWorkbook(rows, sheetTitle) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = '食事宿泊報告ツール';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet(sheetTitle, {
    views: [{ state: 'frozen', ySplit: 1 }], // 見出し行を固定
  });

  sheet.columns = [
    { header: '日付', key: 'date', width: 12 },
    { header: 'ホーム', key: 'home', width: 18 },
    { header: '利用者名', key: 'user', width: 16 },
    { header: '報告者', key: 'reporter', width: 14 },
    { header: '夕食', key: 'dinner', width: 8 },
    { header: '宿泊', key: 'lodging', width: 8 },
    { header: '朝食', key: 'breakfast', width: 8 },
  ];

  // 見出し行の装飾
  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true };
  headerRow.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE0EDE5' } };
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FFB9C4BE' } } };
  });

  rows.forEach((r) => {
    const row = sheet.addRow({
      date: r.report_date.toISOString().slice(0, 10),
      home: r.home_name,
      user: r.user_name,
      reporter: r.reporter_name,
      dinner: r.dinner ? '〇' : '×',
      lodging: r.lodging ? '〇' : '×',
      breakfast: r.breakfast ? '〇' : '×',
    });
    ['dinner', 'lodging', 'breakfast'].forEach((key) => {
      const cell = row.getCell(key);
      cell.alignment = { horizontal: 'center' };
      const isOk = cell.value === '〇';
      cell.font = { color: { argb: isOk ? 'FF1E7A34' : 'FFC0392B' }, bold: true };
    });
  });

  sheet.autoFilter = { from: 'A1', to: 'G1' };

  return workbook;
}

// レスポンスにxlsxとして書き出す共通処理
async function sendWorkbook(res, workbook, filename) {
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  );
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  await workbook.xlsx.write(res);
  res.end();
}

module.exports = { buildReportWorkbook, sendWorkbook };
