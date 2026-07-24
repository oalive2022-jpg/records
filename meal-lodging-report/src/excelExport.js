const ExcelJS = require('exceljs');

const OK_COLOR = 'FF1E7A34';
const NG_COLOR = 'FFC0392B';
const HEADER_FILL = 'FFE0EDE5';
const TOTAL_FILL = 'FFFFF3D6';
const BORDER_COLOR = 'FFB9C4BE';
const YEN_FORMAT = '¥#,##0';

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

// 単価履歴（昇順配列）から、指定日時点で有効な単価を探す
function priceOnDate(history, date) {
  let applicable = { breakfast_price: 0, dinner_price: 0 };
  (history || []).forEach((h) => {
    if (h.effective_from <= date) applicable = h;
  });
  return applicable;
}

// 期間内に単価改定があったかどうか（請求集計シートの表示切り替えに使用）
function priceChangedDuringPeriod(history, dateList) {
  if (!history || history.length === 0) return false;
  const prices = new Set(
    dateList.map((d) => {
      const p = priceOnDate(history, d);
      return `${p.breakfast_price}-${p.dinner_price}`;
    })
  );
  return prices.size > 1;
}

// 1人分・指定期間分の金額集計（回数・小計・合計）を、日ごとの単価履歴を反映して計算する
function calcUserTotals(user, reportsByDate, dateList) {
  let dinnerCount = 0;
  let lodgingCount = 0;
  let breakfastCount = 0;
  let dinnerSubtotal = 0;
  let breakfastSubtotal = 0;

  dateList.forEach((date) => {
    const r = (reportsByDate || {})[date];
    if (!r) return;
    const price = priceOnDate(user.priceHistory, date);
    if (r.dinner) {
      dinnerCount += 1;
      dinnerSubtotal += Number(price.dinner_price) || 0;
    }
    if (r.lodging) lodgingCount += 1;
    if (r.breakfast) {
      breakfastCount += 1;
      breakfastSubtotal += Number(price.breakfast_price) || 0;
    }
  });

  return {
    dinnerCount,
    lodgingCount,
    breakfastCount,
    dinnerSubtotal,
    breakfastSubtotal,
    total: dinnerSubtotal + breakfastSubtotal,
  };
}

/**
 * 縦軸=日付、横軸=利用者（夕食/宿泊/朝食/金額の4列ずつ）、ホームごとにシートを分けたワークブックを作成する。
 *
 * homesData: [
 *   { homeName, users: [{ id, name, priceHistory: [{effective_from,breakfast_price,dinner_price}] }],
 *     reportsByUserAndDate: { [userId]: { [date]: {dinner,lodging,breakfast} } } }
 * ]
 */
async function buildMatrixWorkbook(homesData, dateList, workbookTitle) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = '食事宿泊報告ツール';
  workbook.created = new Date();

  homesData.forEach(({ homeName, users, reportsByUserAndDate }) => {
    const safeName = homeName.replace(/[:\\/?*\[\]]/g, '').slice(0, 31) || 'ホーム';
    const sheet = workbook.addWorksheet(safeName, {
      views: [{ state: 'frozen', xSplit: 1, ySplit: 2 }],
    });

    sheet.getColumn(1).width = 14;
    const subLabels = ['夕食', '宿泊', '朝食', '金額'];
    let colIndex = 2;

    users.forEach((u) => {
      sheet.mergeCells(1, colIndex, 1, colIndex + subLabels.length - 1);
      const nameCell = sheet.getCell(1, colIndex);
      nameCell.value = u.name;
      nameCell.alignment = { horizontal: 'center', vertical: 'middle' };
      nameCell.font = { bold: true };
      nameCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } };

      subLabels.forEach((label, i) => {
        const cell = sheet.getCell(2, colIndex + i);
        cell.value = label;
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
        cell.font = { bold: true, size: 10 };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } };
        sheet.getColumn(colIndex + i).width = label === '金額' ? 10 : 7;
      });

      colIndex += subLabels.length;
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
        const dinnerOk = !!(record && record.dinner);
        const breakfastOk = !!(record && record.breakfast);
        const price = priceOnDate(u.priceHistory, date);

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

        // 金額列（その日の夕食・朝食の合計金額。未報告日は空欄）
        const amountCell = sheet.getCell(rowNum, c + 3);
        if (record) {
          const amount =
            (dinnerOk ? Number(price.dinner_price) || 0 : 0) +
            (breakfastOk ? Number(price.breakfast_price) || 0 : 0);
          amountCell.value = amount;
          amountCell.numFmt = YEN_FORMAT;
        } else {
          amountCell.value = '';
        }
        amountCell.alignment = { horizontal: 'right' };

        c += subLabels.length;
      });
    });

    // 合計行（期間内の回数・金額合計）
    const totalRowNum = 3 + dateList.length;
    const totalLabelCell = sheet.getCell(totalRowNum, 1);
    totalLabelCell.value = '合計';
    totalLabelCell.font = { bold: true };
    totalLabelCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: TOTAL_FILL } };

    let c2 = 2;
    users.forEach((u) => {
      const totals = calcUserTotals(u, reportsByUserAndDate[u.id], dateList);
      const values = [totals.dinnerCount, totals.lodgingCount, totals.breakfastCount, totals.total];
      values.forEach((val, i) => {
        const cell = sheet.getCell(totalRowNum, c2 + i);
        cell.value = val;
        cell.font = { bold: true };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: TOTAL_FILL } };
        cell.alignment = { horizontal: i === 3 ? 'right' : 'center' };
        if (i === 3) cell.numFmt = YEN_FORMAT;
      });
      c2 += subLabels.length;
    });
  });

  return workbook;
}

/**
 * 「請求集計」シートを追加する（ホーム横断で、利用者ごとの期間内食費を一覧化）。
 * 期間中に単価改定があった利用者は、単価欄に「改定あり」と表示する（小計・合計は正しく日割り計算済み）。
 */
function addBillingSummarySheet(workbook, homesData, dateList, periodLabel) {
  const sheet = workbook.addWorksheet('請求集計', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });

  sheet.columns = [
    { header: 'ホーム', key: 'home', width: 16 },
    { header: '利用者名', key: 'user', width: 16 },
    { header: '夕食回数', key: 'dinnerCount', width: 10 },
    { header: '夕食単価', key: 'dinnerPrice', width: 12 },
    { header: '夕食小計', key: 'dinnerSubtotal', width: 12 },
    { header: '朝食回数', key: 'breakfastCount', width: 10 },
    { header: '朝食単価', key: 'breakfastPrice', width: 12 },
    { header: '朝食小計', key: 'breakfastSubtotal', width: 12 },
    { header: '合計金額', key: 'total', width: 12 },
  ];

  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true };
  headerRow.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } };
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
    cell.border = { bottom: { style: 'thin', color: { argb: BORDER_COLOR } } };
  });

  let grandTotal = 0;

  homesData.forEach(({ homeName, users, reportsByUserAndDate }) => {
    users.forEach((u) => {
      const t = calcUserTotals(u, reportsByUserAndDate[u.id], dateList);
      const changed = priceChangedDuringPeriod(u.priceHistory, dateList);
      const latestPrice = priceOnDate(u.priceHistory, dateList[dateList.length - 1]);
      grandTotal += t.total;

      const row = sheet.addRow({
        home: homeName,
        user: u.name,
        dinnerCount: t.dinnerCount,
        dinnerPrice: changed ? '改定あり' : latestPrice.dinner_price,
        dinnerSubtotal: t.dinnerSubtotal,
        breakfastCount: t.breakfastCount,
        breakfastPrice: changed ? '改定あり' : latestPrice.breakfast_price,
        breakfastSubtotal: t.breakfastSubtotal,
        total: t.total,
      });

      ['dinnerSubtotal', 'breakfastSubtotal', 'total'].forEach((key) => {
        row.getCell(key).numFmt = YEN_FORMAT;
      });
      if (!changed) {
        row.getCell('dinnerPrice').numFmt = YEN_FORMAT;
        row.getCell('breakfastPrice').numFmt = YEN_FORMAT;
      } else {
        row.getCell('dinnerPrice').font = { italic: true, color: { argb: 'FF6B7A72' } };
        row.getCell('breakfastPrice').font = { italic: true, color: { argb: 'FF6B7A72' } };
      }
      row.getCell('total').font = { bold: true };
    });
  });

  sheet.addRow({}); // 空行
  const grandRow = sheet.addRow({ user: `${periodLabel} 合計`, total: grandTotal });
  grandRow.font = { bold: true };
  grandRow.getCell('total').numFmt = YEN_FORMAT;
  grandRow.getCell('total').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: TOTAL_FILL } };

  sheet.autoFilter = { from: 'A1', to: 'I1' };
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

module.exports = { buildMatrixWorkbook, addBillingSummarySheet, buildDateList, sendWorkbook };
