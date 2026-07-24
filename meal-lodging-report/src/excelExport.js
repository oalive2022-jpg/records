const ExcelJS = require('exceljs');

const OK_COLOR = 'FF1E7A34';
const NG_COLOR = 'FFC0392B';
const HEADER_FILL = 'FFE0EDE5';
const BORDER_COLOR = 'FFB9C4BE';

function formatDateJP(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const weekdays = ['日', '月', '火', '水', '木', '金', '土'];
  return `${dateStr}(${weekdays[d.getDay()]})`;
}

// 日付範囲の配列 (YYYY-MM-DD) を作る
function buildDateList(startDate, endDate) {
  const dates = [];
  const cur = new Date(startDate + 'T00:00:00');
  const end = new Date(endDate + 'T00:00:00');
  while (cur <= end) {
    dates.push(cur.toISOString().slice(0, 10));
    cur.setDate(cur.getDate() + 1);
  }
  return dates;
}

/**
 * 縦軸=日付、横軸=利用者（夕食/宿泊/朝食の3列ずつ）、ホームごとにシートを分けたワークブックを作成する。
 *
 * homesData: [
 *   { homeName, users: [{ id, name }], reportsByUserAndDate: { [userId]: { [date]: {dinner,lodging,breakfast,reporter_name} } } }
 * ]
 */
async function buildMatrixWorkbook(homesData, dateList, workbookTitle) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = '食事宿泊報告ツール';
  workbook.created = new Date();

  homesData.forEach(({ homeName, users, reportsByUserAndDate }) => {
    // シート名に使えない文字(: \ / ? * [ ])を除去し、31文字制限に収める
    const safeName = homeName.replace(/[:\\/?*\[\]]/g, '').slice(0, 31) || 'ホーム';
    const sheet = workbook.addWorksheet(safeName, {
      views: [{ state: 'frozen', xSplit: 1, ySplit: 2 }],
    });

    // 列構成: A列=日付、以降は利用者ごとに3列(夕食/宿泊/朝食)
    sheet.getColumn(1).width = 14;
    let colIndex = 2;
    users.forEach((u) => {
      sheet.mergeCells(1, colIndex, 1, colIndex + 2);
      const nameCell = sheet.getCell(1, colIndex);
      nameCell.value = u.name;
      nameCell.alignment = { horizontal: 'center', vertical: 'middle' };
      nameCell.font = { bold: true };
      nameCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } };

      ['夕食', '宿泊', '朝食'].forEach((label, i) => {
        const cell = sheet.getCell(2, colIndex + i);
        cell.value = label;
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
        cell.font = { bold: true, size: 10 };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } };
        sheet.getColumn(colIndex + i).width = 7;
      });

      colIndex += 3;
    });

    sheet.mergeCells(1, 1, 2, 1);
    const dateHeaderCell = sheet.getCell(1, 1);
    dateHeaderCell.value = '日付';
    dateHeaderCell.alignment = { horizontal: 'center', vertical: 'middle' };
    dateHeaderCell.font = { bold: true };
    dateHeaderCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } };

    [1, 2].forEach((r) => {
      sheet.getRow(r).eachCell({ includeEmpty: true }, (cell) => {
        cell.border = { bottom: { style: 'thin', color: { argb: BORDER_COLOR } } };
      });
    });

    // データ行（1日1行）
    dateList.forEach((date, rowOffset) => {
      const rowNum = 3 + rowOffset;
      const dateCell = sheet.getCell(rowNum, 1);
      dateCell.value = formatDateJP(date);
      dateCell.font = { bold: true };

      let c = 2;
      users.forEach((u) => {
        const record = (reportsByUserAndDate[u.id] || {})[date];
        ['dinner', 'lodging', 'breakfast'].forEach((key, i) => {
          const cell = sheet.getCell(rowNum, c + i);
          if (record) {
            const isOk = !!record[key];
            cell.value = isOk ? '〇' : '×';
            cell.font = { bold: true, color: { argb: isOk ? OK_COLOR : NG_COLOR } };
          } else {
            cell.value = '';
          }
          cell.alignment = { horizontal: 'center' };
        });
        c += 3;
      });
    });
  });

  return workbook;
}

async function sendWorkbook(res, workbook, filename) {
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  );
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  await workbook.xlsx.write(res);
  res.end();
}

module.exports = { buildMatrixWorkbook, buildDateList, sendWorkbook };
