// Cloudflare Pages Function
// 路徑規則：functions/api/prices.js -> 對應網址 /api/prices
// 在伺服器端（Cloudflare 的 edge）呼叫證交所 / 櫃買中心的 API，
// 不受瀏覽器 CORS 限制，再把合併後的原始資料回傳給前端。

export async function onRequestGet() {
  const sources = [
    "https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL", // 上市
    "https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes" // 上櫃
  ];

  const settled = await Promise.allSettled(
    sources.map(url =>
      fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } }).then(r =>
        r.ok ? r.json() : []
      )
    )
  );

  const merged = [];
  settled.forEach(result => {
    if (result.status === "fulfilled" && Array.isArray(result.value)) {
      merged.push(...result.value);
    }
  });

  return new Response(JSON.stringify(merged), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      // 證交所資料每天只會更新一次，這裡快取 30 分鐘減少重複呼叫
      "Cache-Control": "public, max-age=1800"
    }
  });
}
