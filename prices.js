export async function onRequestGet() {
  const map = new Map();

  // ── 上市：twse.com.tw 官網 API（當天收盤後即更新，openapi 那支是前一天）
  // response=open_data 回傳 CSV，第一行是欄位名，之後每行是一筆資料
  try {
    const res = await fetch(
      "https://www.twse.com.tw/exchangeReport/STOCK_DAY_ALL?response=open_data",
      { headers: { "User-Agent": "Mozilla/5.0" } }
    );
    if (res.ok) {
      const text = await res.text();
      const lines = text.trim().split("\n");
      // 第一行：日期,證券代號,證券名稱,...,收盤價,...
      // 固定欄位順序：0=日期 1=代號 2=名稱 3=成交股數 4=成交金額 5=開盤 6=最高 7=最低 8=收盤
      for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].split(",").map(c => c.replace(/^"|"$/g, "").trim());
        if (cols.length < 9) continue;
        const code  = cols[1];
        const name  = cols[2];
        const close = parseFloat(cols[8]);
        if (!code || isNaN(close) || close <= 0) continue;
        if (!map.has(code)) map.set(code, { Code: code, Name: name, ClosingPrice: String(close) });
      }
    }
  } catch (e) {
    console.error("TWSE CSV 抓取失敗:", e.message);
  }

  // ── 上櫃：TPEx OpenAPI（JSON，有當天或最近一個交易日資料）
  try {
    const res = await fetch(
      "https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes",
      { headers: { "User-Agent": "Mozilla/5.0" } }
    );
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data)) {
        data.forEach(item => {
          const code  = String(item.SecuritiesCompanyCode || item.Code || "").trim();
          const name  = String(item.CompanyName || item.Name || "").trim();
          const close = parseFloat(String(item.Close || item.ClosingPrice || "").replace(/,/g, ""));
          if (!code || isNaN(close) || close <= 0) return;
          if (!map.has(code)) map.set(code, { Code: code, Name: name, ClosingPrice: String(close) });
        });
      }
    }
  } catch (e) {
    console.error("TPEx 抓取失敗:", e.message);
  }

  const merged = Array.from(map.values());

  return new Response(JSON.stringify(merged), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=1800"
    }
  });
}
