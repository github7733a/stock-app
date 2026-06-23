/* ============================================================
   股票資產管理 — app.js
   IndexedDB v1（全新）
   stocks: { id, code, name, qty, totalCost, price, priceAt }
   transactions: { id, stockId, type:'init'|'buy'|'sell',
                   qty, amount, avgCostBefore, timestamp }

   股價來源：
   - TWSE openapi (上市) — https://openapi.twse.com.tw
   - TPEx openapi  (上櫃) — https://www.tpex.org.tw
   兩者都有 Access-Control-Allow-Origin: * 可直接從瀏覽器抓
   ============================================================ */

"use strict";

/* ── IndexedDB ────────────────────────────────────────────── */

let db;
const DB_NAME = "stockAppDB";
const DB_VER  = 1;

const dbReady = new Promise((resolve, reject) => {
  const req = indexedDB.open(DB_NAME, DB_VER);

  req.onupgradeneeded = e => {
    const d = e.target.result;
    if (!d.objectStoreNames.contains("stocks")) {
      d.createObjectStore("stocks", { keyPath: "id", autoIncrement: true });
    }
    if (!d.objectStoreNames.contains("transactions")) {
      const ts = d.createObjectStore("transactions", { keyPath: "id", autoIncrement: true });
      ts.createIndex("stockId", "stockId", { unique: false });
    }
  };

  req.onsuccess = e => { db = e.target.result; resolve(db); };
  req.onerror   = e => reject(e.target.error);
});

function dbGet(store, key) {
  return new Promise((res, rej) => {
    const tx = db.transaction(store, "readonly");
    const r = tx.objectStore(store).get(key);
    r.onsuccess = () => res(r.result);
    r.onerror   = () => rej(r.error);
  });
}

function dbGetAll(store) {
  return new Promise((res, rej) => {
    const tx = db.transaction(store, "readonly");
    const r = tx.objectStore(store).getAll();
    r.onsuccess = () => res(r.result);
    r.onerror   = () => rej(r.error);
  });
}

function dbPut(store, record) {
  return new Promise((res, rej) => {
    const tx = db.transaction(store, "readwrite");
    const r = tx.objectStore(store).put(record);
    r.onsuccess = () => res(r.result);
    r.onerror   = () => rej(r.error);
  });
}

function dbAdd(store, record) {
  return new Promise((res, rej) => {
    const tx = db.transaction(store, "readwrite");
    const r = tx.objectStore(store).add(record);
    r.onsuccess = () => res(r.result);
    r.onerror   = () => rej(r.error);
  });
}

function dbDelete(store, key) {
  return new Promise((res, rej) => {
    const tx = db.transaction(store, "readwrite");
    const r = tx.objectStore(store).delete(key);
    r.onsuccess = () => res();
    r.onerror   = () => rej(r.error);
  });
}

function dbGetByIndex(store, index, value) {
  return new Promise((res, rej) => {
    const tx = db.transaction(store, "readonly");
    const r = tx.objectStore(store).index(index).getAll(value);
    r.onsuccess = () => res(r.result);
    r.onerror   = () => rej(r.error);
  });
}

function dbDeleteByIndex(store, index, value) {
  return new Promise((res, rej) => {
    const tx = db.transaction(store, "readwrite");
    const objStore = tx.objectStore(store);
    const r = objStore.index(index).openCursor(IDBKeyRange.only(value));
    r.onsuccess = e => {
      const cursor = e.target.result;
      if (cursor) { cursor.delete(); cursor.continue(); }
    };
    tx.oncomplete = () => res();
    tx.onerror    = () => rej(tx.error);
  });
}

/* ── 格式化工具 ─────────────────────────────────────────────── */

const $ = id => document.getElementById(id);

function fmtMoney(n) {
  const v = Number(n) || 0;
  if (Math.abs(v) >= 10000) {
    return (v / 10000).toFixed(1) + " 萬";
  }
  return v.toLocaleString("zh-TW", { maximumFractionDigits: 0 });
}

function fmtMoneyFull(n) {
  const v = Number(n) || 0;
  const sign = v < 0 ? "-" : "";
  return sign + "NT$ " + Math.round(Math.abs(v)).toLocaleString("zh-TW");
}

function fmtRate(r) {
  const v = Number(r);
  if (!isFinite(v)) return "—";
  const sign = v > 0 ? "+" : "";
  return sign + v.toFixed(2) + "%";
}

function fmtDate(ts) {
  return new Date(ts).toLocaleString("zh-TW", {
    year: "numeric", month: "numeric", day: "numeric",
    hour: "numeric", minute: "2-digit"
  });
}

function plClass(n) {
  const v = Number(n);
  if (v > 0) return "pos";
  if (v < 0) return "neg";
  return "";
}

/* ── 股價抓取 ───────────────────────────────────────────────── */

let priceMap = {};  // code -> price

function normalizeQuote(item) {
  if (!item || typeof item !== "object") return null;
  const keys = Object.keys(item);
  const codeKey  = keys.find(k => /code/i.test(k) || k.includes("代號") || k.includes("代碼"));
  const nameKey  = keys.find(k => /name/i.test(k) || k.includes("名稱"));
  const closeKey = keys.find(k => /^closingprice$/i.test(k) || /close/i.test(k) || k.includes("收盤"));
  if (!codeKey || !closeKey) return null;
  const code  = String(item[codeKey]).trim();
  const name  = nameKey ? String(item[nameKey]).trim() : code;
  const price = parseFloat(String(item[closeKey]).replace(/,/g, ""));
  if (!code || !/^\w{1,10}$/.test(code) || isNaN(price) || price <= 0) return null;
  return { code, name, price };
}

async function fetchPrices() {
  setStatus("股價更新中…");
  const sources = [
    "https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL",
    "https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes"
  ];
  const map = {};
  await Promise.allSettled(sources.map(async url => {
    try {
      const res = await fetch(url, { cache: "no-cache" });
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data)) {
        data.forEach(item => {
          const q = normalizeQuote(item);
          if (q && !map[q.code]) map[q.code] = q;
        });
      }
    } catch (err) {
      console.warn("股價抓取失敗:", url, err.message);
    }
  }));
  return map;
}

async function refreshPricesAndRender() {
  priceMap = await fetchPrices();
  const total = Object.keys(priceMap).length;

  if (total === 0) {
    setStatus("⚠️ 股價抓取失敗（非交易時段可能無資料）");
  } else {
    setStatus(`股價已更新 ${new Date().toLocaleString("zh-TW", { hour: "numeric", minute: "2-digit" })}（收盤價，非即時）— 共 ${total} 檔`);
  }

  // 把最新股價寫回資料庫
  const stocks = await dbGetAll("stocks");
  await Promise.all(stocks.map(async s => {
    if (s.code && priceMap[s.code]) {
      s.price   = priceMap[s.code].price;
      s.priceAt = Date.now();
      await dbPut("stocks", s);
    }
  }));

  await renderMain();

  // 如果詳情頁開著，也同步更新
  if (!$("detailView").classList.contains("hidden") && currentStockId != null) {
    const s = await dbGet("stocks", currentStockId);
    if (s) renderDetailHeader(s);
  }
}

function setStatus(text) {
  $("priceStatusBar").textContent = text;
}

/* ── 自動完成 ───────────────────────────────────────────────── */

let suggestPriceList = [];  // [{ code, name, price }] derived from priceMap on demand

$("asCode").addEventListener("input", () => {
  const q = $("asCode").value.trim();
  if (!q) { hideSuggest(); return; }

  const src = suggestPriceList.length ? suggestPriceList : Object.values(priceMap);
  const matches = src
    .filter(p => p.code.startsWith(q) || (p.name && p.name.includes(q)))
    .slice(0, 8);

  if (!matches.length) { hideSuggest(); return; }

  $("asSuggest").innerHTML = matches.map(m =>
    `<div class="suggest-item" data-code="${m.code}" data-name="${m.name}" data-price="${m.price}">
       <span>${m.code} ${m.name}</span>
       <span class="suggest-price">${m.price}</span>
     </div>`
  ).join("");
  $("asSuggest").style.display = "block";
});

$("asSuggest").addEventListener("click", e => {
  const item = e.target.closest(".suggest-item");
  if (!item) return;
  $("asCode").value  = item.dataset.code;
  $("asName").value  = item.dataset.name;
  hideSuggest();
});

document.addEventListener("click", e => {
  if (!e.target.closest(".autocomplete-wrap")) hideSuggest();
});

function hideSuggest() {
  $("asSuggest").style.display = "none";
}

/* ── 主畫面渲染 ─────────────────────────────────────────────── */

async function renderMain() {
  const stocks = await dbGetAll("stocks");

  let totalValue = 0, totalCostSum = 0;
  let rows = "";

  if (!stocks.length) {
    rows = '<div class="empty-tip">尚未新增任何股票<br>點右上角「＋」新增</div>';
  } else {
    stocks.forEach(s => {
      const cv   = s.qty * s.price;
      const pl   = cv - s.totalCost;
      const pCls = plClass(pl);
      const sign = pl > 0 ? "+" : "";
      totalValue   += cv;
      totalCostSum += s.totalCost;
      rows += `
        <div class="stock-row" onclick="openDetail(${s.id})">
          <div class="stock-name">
            <span class="s-name">${s.name || s.code}</span>
            <span class="s-code">${s.code}</span>
          </div>
          <span class="col-r">${s.qty}</span>
          <span class="col-r ${pCls}">${sign}${fmtMoney(pl)}</span>
        </div>`;
    });
  }

  $("stockRows").innerHTML = rows;

  const totalPL   = totalValue - totalCostSum;
  const totalRate = totalCostSum > 0 ? (totalPL / totalCostSum) * 100 : NaN;
  const plCls     = plClass(totalPL);

  $("totalPL").textContent    = (totalPL >= 0 ? "+" : "") + fmtMoney(totalPL);
  $("totalPL").className      = "val " + plCls;
  $("totalRate").textContent  = fmtRate(totalRate);
  $("totalRate").className    = "val " + plCls;
  $("totalValue").textContent = fmtMoney(totalValue);
  $("totalCost").textContent  = fmtMoney(totalCostSum);
}

/* ── 新增股票 ───────────────────────────────────────────────── */

function openAddStock() {
  $("asCode").value = "";
  $("asName").value = "";
  $("asQty").value  = "";
  $("asCost").value = "";
  hideSuggest();
  openModal("addStockModal");
}

async function submitAddStock() {
  const code = $("asCode").value.trim().toUpperCase();
  const name = $("asName").value.trim() || code;
  const qty  = Number($("asQty").value);
  const cost = Number($("asCost").value);

  if (!code || !qty || qty <= 0 || !cost || cost <= 0) {
    alert("請完整填寫：代號、股數（> 0）、付出成本（> 0）");
    return;
  }

  // 取得最新股價（如果已抓到）
  const price = priceMap[code] ? priceMap[code].price : cost / qty;

  const stockId = await dbAdd("stocks", {
    code, name, qty,
    totalCost: cost,
    price,
    priceAt: Date.now()
  });

  await dbAdd("transactions", {
    stockId,
    type: "init",
    qty,
    amount: cost,
    avgCostBefore: 0,
    timestamp: Date.now()
  });

  closeModal("addStockModal");
  await renderMain();
}

/* ── 詳情頁 ─────────────────────────────────────────────────── */

let currentStockId = null;
let currentTradeType = null;

async function openDetail(id) {
  currentStockId = id;
  const s = await dbGet("stocks", id);
  if (!s) return;
  renderDetailHeader(s);
  await renderTxList(id);
  $("mainView").classList.add("hidden");
  $("detailView").classList.remove("hidden");
}

function renderDetailHeader(s) {
  const cv   = s.qty * s.price;
  const pl   = cv - s.totalCost;
  const avg  = s.qty > 0 ? s.totalCost / s.qty : 0;
  const rate = s.totalCost > 0 ? (pl / s.totalCost) * 100 : NaN;

  $("detailTitle").textContent = `${s.name}（${s.code}）`;
  $("mAvgCost").textContent    = fmtMoneyFull(avg);
  $("mCurrentValue").textContent = fmtMoneyFull(cv);
  $("mPrice").textContent      = fmtMoneyFull(s.price);
  $("mPL").textContent         = (pl >= 0 ? "+" : "") + fmtMoneyFull(pl);
  $("mPL").className           = "metric-val " + plClass(pl);
  $("mTotalCost").textContent  = fmtMoneyFull(s.totalCost);
  $("mRate").textContent       = fmtRate(rate);
  $("mRate").className         = "metric-val " + plClass(pl);
}

async function renderTxList(stockId) {
  const txs = await dbGetByIndex("transactions", "stockId", stockId);
  txs.sort((a, b) => b.timestamp - a.timestamp);

  const typeLabel = { init: "初次建立", buy: "買入", sell: "賣出" };
  const html = txs.map(t => {
    const sign   = t.type === "sell" ? "-" : "+";
    const color  = t.type === "sell" ? "neg" : "pos";
    return `<div class="tx-row">
      <div class="tx-top">
        <span class="tx-type ${color}">${typeLabel[t.type] || t.type}</span>
        <span class="tx-qty">${sign}${t.qty} 股</span>
        <span class="tx-amount">${fmtMoneyFull(t.amount)}</span>
      </div>
      <div class="tx-date">${fmtDate(t.timestamp)}</div>
    </div>`;
  }).join("") || '<div class="empty-tip">尚無交易紀錄</div>';

  $("txList").innerHTML = html;
}

function closeDetail() {
  currentStockId = null;
  $("detailView").classList.add("hidden");
  $("mainView").classList.remove("hidden");
}

async function deleteCurrentStock() {
  const s = await dbGet("stocks", currentStockId);
  if (!s) return;
  if (!confirm(`確定刪除「${s.name}」？交易紀錄也會一併刪除。`)) return;
  await dbDelete("stocks", currentStockId);
  await dbDeleteByIndex("transactions", "stockId", currentStockId);
  closeDetail();
  await renderMain();
}

/* ── 買入 / 賣出 ─────────────────────────────────────────────── */

function openTrade(type) {
  currentTradeType = type;
  $("tradeModalTitle").textContent = type === "buy" ? "買入" : "賣出";

  if (type === "buy") {
    $("tradeFields").innerHTML = `
      <input id="tradeQty"    type="number" placeholder="買入股數">
      <input id="tradeAmount" type="number" placeholder="花費金額（含手續費，元）">
    `;
  } else {
    $("tradeFields").innerHTML = `
      <input id="tradeQty" type="number" placeholder="賣出股數">
      <p class="modal-hint" id="tradeHint">計算中…</p>
    `;
    // 非同步填入目前均價提示
    dbGet("stocks", currentStockId).then(s => {
      if (!s) return;
      const avg = s.qty > 0 ? (s.totalCost / s.qty).toFixed(2) : 0;
      const hint = $("tradeHint");
      if (hint) hint.textContent = `目前均價 NT$ ${avg}，賣出後成本將等比例減少`;
    });
  }

  openModal("tradeModal");
}

async function submitTrade() {
  const qty = Number($("tradeQty").value);
  if (!qty || qty <= 0) { alert("請輸入正確股數"); return; }

  const s = await dbGet("stocks", currentStockId);
  if (!s) return;

  if (currentTradeType === "buy") {
    const amount = Number($("tradeAmount").value);
    if (!amount || amount <= 0) { alert("請輸入花費金額"); return; }

    s.qty       += qty;
    s.totalCost += amount;
    await dbPut("stocks", s);
    await dbAdd("transactions", {
      stockId: s.id, type: "buy",
      qty, amount,
      avgCostBefore: s.qty > 0 ? s.totalCost / s.qty : 0,
      timestamp: Date.now()
    });

  } else {
    // 賣出
    if (qty > s.qty) { alert(`持有股數只有 ${s.qty} 股，無法賣出 ${qty} 股`); return; }
    const avgCostBefore = s.qty > 0 ? s.totalCost / s.qty : 0;
    const costReduction = qty * avgCostBefore;

    s.qty       -= qty;
    s.totalCost -= costReduction;

    if (s.qty === 0) {
      // 股數歸零：刪除整筆
      await dbDelete("stocks", s.id);
      await dbAdd("transactions", {
        stockId: s.id, type: "sell",
        qty, amount: costReduction,
        avgCostBefore,
        timestamp: Date.now()
      });
      closeModal("tradeModal");
      closeDetail();
      await renderMain();
      return;
    }

    await dbPut("stocks", s);
    await dbAdd("transactions", {
      stockId: s.id, type: "sell",
      qty, amount: costReduction,
      avgCostBefore,
      timestamp: Date.now()
    });
  }

  closeModal("tradeModal");
  renderDetailHeader(s);
  await renderTxList(s.id);
  await renderMain();
}

/* ── Modal 通用 ─────────────────────────────────────────────── */

function openModal(id) {
  $(id).classList.remove("hidden");
}

function closeModal(id) {
  $(id).classList.add("hidden");
}

// 點 overlay 背景關閉
document.querySelectorAll(".modal-overlay").forEach(el => {
  el.addEventListener("click", e => {
    if (e.target === el) el.classList.add("hidden");
  });
});

/* ── 入口 ───────────────────────────────────────────────────── */

(async () => {
  // 注册 Service Worker
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(e => console.warn("SW 注册失败", e));
  }

  await dbReady;
  await renderMain();          // 先用資料庫舊價格渲染，不讓畫面空白
  await refreshPricesAndRender(); // 再抓最新股價更新
})();
