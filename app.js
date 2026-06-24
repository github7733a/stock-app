"use strict";
/* ============================================================
   股票資產管理 app.js
   - IndexedDB: stocks + transactions
   - 股價：透過 /api/prices（Cloudflare Pages Function）伺服器端代抓
   - 主畫面手風琴式展開明細，不開新頁面
   ============================================================ */

/* ── IndexedDB ─────────────────────────────────────────────── */

let db;
const dbReady = new Promise((resolve, reject) => {
  const req = indexedDB.open("stockAppDB", 1);

  req.onupgradeneeded = e => {
    const d = e.target.result;
    if (!d.objectStoreNames.contains("stocks")) {
      d.createObjectStore("stocks", { keyPath: "id", autoIncrement: true });
    }
    if (!d.objectStoreNames.contains("transactions")) {
      const ts = d.createObjectStore("transactions",
        { keyPath: "id", autoIncrement: true });
      ts.createIndex("stockId", "stockId", { unique: false });
    }
  };

  req.onsuccess = e => { db = e.target.result; resolve(); };
  req.onerror   = e => reject(e.target.error);
});

const idb = {
  get: (store, key) => new Promise((res, rej) => {
    const r = db.transaction(store).objectStore(store).get(key);
    r.onsuccess = () => res(r.result);
    r.onerror   = () => rej(r.error);
  }),
  all: store => new Promise((res, rej) => {
    const r = db.transaction(store).objectStore(store).getAll();
    r.onsuccess = () => res(r.result);
    r.onerror   = () => rej(r.error);
  }),
  put: (store, rec) => new Promise((res, rej) => {
    const r = db.transaction(store, "readwrite").objectStore(store).put(rec);
    r.onsuccess = () => res(r.result);
    r.onerror   = () => rej(r.error);
  }),
  add: (store, rec) => new Promise((res, rej) => {
    const r = db.transaction(store, "readwrite").objectStore(store).add(rec);
    r.onsuccess = () => res(r.result);
    r.onerror   = () => rej(r.error);
  }),
  del: (store, key) => new Promise((res, rej) => {
    const r = db.transaction(store, "readwrite").objectStore(store).delete(key);
    r.onsuccess = () => res();
    r.onerror   = () => rej(r.error);
  }),
  byIndex: (store, idx, val) => new Promise((res, rej) => {
    const r = db.transaction(store).objectStore(store).index(idx).getAll(val);
    r.onsuccess = () => res(r.result);
    r.onerror   = () => rej(r.error);
  }),
  delByIndex: (store, idx, val) => new Promise((res, rej) => {
    const tx = db.transaction(store, "readwrite");
    const r  = tx.objectStore(store).index(idx)
                 .openCursor(IDBKeyRange.only(val));
    r.onsuccess = e => {
      const c = e.target.result;
      if (c) { c.delete(); c.continue(); }
    };
    tx.oncomplete = () => res();
    tx.onerror    = () => rej(tx.error);
  })
};

/* ── 格式化 ─────────────────────────────────────────────────── */

const $ = id => document.getElementById(id);

// ── 格式化函式 ──────────────────────────────────────────────
// fmtPrice : 單價 / 均價 / 市價 → 兩位小數，無 NT$
// fmtAmount: 計算金額 (成本/現值) → 整數，無 NT$
// fmtPL    : 損益 → 整數，無 NT$，正數不顯示 +
// fmtQty   : 股數 → 千分位整數（顯示用）
// parseQty : 把可能含逗號的輸入解析成數字
function fmtPrice(n) {
  const v = Number(n) || 0;
  return v.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function fmtAmount(n) {
  const v = Number(n) || 0;
  return Math.round(Math.abs(v)).toLocaleString("zh-TW");
}

function fmtPL(n) {
  const v = Number(n) || 0;
  return Math.round(v).toLocaleString("zh-TW");   // 負數自帶 -，正數不加 +
}

function fmtQty(n) {
  return Number(n).toLocaleString("zh-TW");
}

function parseQty(str) {
  return Number(String(str).replace(/,/g, "")) || 0;
}

// 幫任何 qty input 加上離焦千分位格式化
function bindQtyFormat(inputEl) {
  if (!inputEl || inputEl.dataset.qtyBound) return;
  inputEl.dataset.qtyBound = "1";
  inputEl.addEventListener("blur", () => {
    const v = parseQty(inputEl.value);
    if (v > 0) inputEl.value = v.toLocaleString("zh-TW");
  });
  inputEl.addEventListener("focus", () => {
    // 聚焦時去掉逗號，方便編輯
    inputEl.value = String(parseQty(inputEl.value) || "");
  });
}

function fmtRate(r) {
  const v = Number(r);
  if (!isFinite(v)) return "—";
  return (v >= 0 ? "+" : "") + v.toFixed(2) + "%";
}

function fmtDate(ts) {
  return new Date(ts).toLocaleString("zh-TW", {
    year: "numeric", month: "numeric", day: "numeric",
    hour: "numeric", minute: "2-digit"
  });
}

function pc(n) {                              // CSS class for red/green
  return Number(n) > 0 ? "pos" : Number(n) < 0 ? "neg" : "";
}

/* ── 股價抓取 ───────────────────────────────────────────────── */

let priceMap = {};   // code -> { code, name, price }

function normalizeQuote(item) {
  if (!item || typeof item !== "object") return null;
  const keys = Object.keys(item);

  // 找代號欄位（TWSE: "Code", TPEx: "SecuritiesCompanyCode" 等）
  const codeKey = keys.find(k =>
    k === "Code" || /code/i.test(k) || k.includes("代號") || k.includes("代碼"));

  // 找名稱欄位（TWSE: "Name", TPEx: "CompanyName" 等）
  const nameKey = keys.find(k =>
    k === "Name" || k === "StockName" || /name/i.test(k) || k.includes("名稱"));

  // 找收盤價欄位（TWSE: "ClosingPrice", TPEx: "Close" 等）
  const closeKey = keys.find(k =>
    k === "ClosingPrice" || k === "Close" ||
    /^closingprice$/i.test(k) || /close/i.test(k) || k.includes("收盤"));

  if (!codeKey || !closeKey) return null;

  const code  = String(item[codeKey]).trim();
  const name  = nameKey ? String(item[nameKey]).trim() : code;
  const price = parseFloat(String(item[closeKey]).replace(/,/g, ""));

  if (!code || !/^\w{1,10}$/.test(code) || isNaN(price) || price <= 0) return null;
  return { code, name, price };
}

async function fetchPrices() {
  setStatus("股價更新中…");

  // 每次都直接打 /api/prices，不做前端快取
  // Cloudflare Function 有 Cache-Control: max-age=1800，CDN 幫擋流量
  const map = {};
  try {
    const res = await fetch("/api/prices", { cache: "no-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data)) throw new Error("非陣列回傳");
    data.forEach(item => {
      const q = normalizeQuote(item);
      if (q && !map[q.code]) map[q.code] = q;
    });
    console.log(`/api/prices: 抓到 ${Object.keys(map).length} 筆`);
  } catch (err) {
    console.warn("/api/prices 失敗:", err.message);
    setStatus("⚠️ 股價抓取失敗，請確認網路或稍後重試");
    return {};
  }

  const total = Object.keys(map).length;
  if (total === 0) {
    setStatus("⚠️ 今日尚無交易資料（假日或尚未開盤）");
    return {};
  }

  setStatus(
    `股價已更新 ${new Date().toLocaleTimeString("zh-TW",
      { hour: "numeric", minute: "2-digit" })}（收盤價，非即時）— 共 ${total} 檔`
  );
  return map;
}

function setStatus(text) {
  $("priceStatusText").textContent = text;
}

async function doRefresh() {
  priceMap = await fetchPrices();
  await updateAllPricesInDB();
  await renderMain();
}

async function updateAllPricesInDB() {
  const stocks = await idb.all("stocks");
  await Promise.all(stocks.map(async s => {
    if (s.code && priceMap[s.code]) {
      s.price   = priceMap[s.code].price;
      s.priceAt = Date.now();
      await idb.put("stocks", s);
    }
  }));
}

/* ── 主畫面渲染 ─────────────────────────────────────────────── */

let expandedId = null;   // 目前展開的股票 id

async function renderMain() {
  const stocks = await idb.all("stocks");

  let totalValue = 0, totalCostSum = 0;
  let html = "";

  if (!stocks.length) {
    html = '<div class="empty-tip">尚未新增任何股票<br>點右上角「＋」新增</div>';
    $("summaryBlock").style.display = "none";
  } else {
    stocks.forEach(s => {
      const cv   = s.qty * s.price;
      const pl   = cv - s.totalCost;
      totalValue   += cv;
      totalCostSum += s.totalCost;

      const isOpen = expandedId === s.id;
      html += `
        <div class="stock-item" id="item-${s.id}">
          <div class="stock-row" onclick="toggleDetail(${s.id})">
            <div class="stock-name-col">
              <span class="s-name">${s.name || s.code}</span>
              <span class="s-code">${s.code}</span>
            </div>
            <span class="col-r">${fmtQty(s.qty)}</span>
            <span class="col-r ${pc(pl)}">${fmtPL(pl)}</span>
            <span class="col-chev ${isOpen ? "open" : ""}">›</span>
          </div>
          <div class="detail-panel ${isOpen ? "" : "hidden"}" id="panel-${s.id}">
            ${buildDetailHTML(s)}
          </div>
        </div>`;
    });

    $("summaryBlock").style.display = "";
    const pl   = totalValue - totalCostSum;
    const rate = totalCostSum > 0 ? (pl / totalCostSum) * 100 : NaN;
    const cls  = pc(pl);
    $("totalPL").textContent    = fmtPL(pl);
    $("totalPL").className      = "sum-val " + cls;
    $("totalRate").textContent  = fmtRate(rate);
    $("totalRate").className    = "sum-val " + cls;
    $("totalValue").textContent = fmtAmount(totalValue);
    $("totalCost").textContent  = fmtAmount(totalCostSum);
  }

  $("stockRows").innerHTML = html;

  // 如果有展開的，補入交易紀錄
  if (expandedId != null) {
    await loadTxIntoPanel(expandedId);
  }
}

function buildDetailHTML(s) {
  const cv   = s.qty * s.price;
  const pl   = cv - s.totalCost;
  const avg  = s.qty > 0 ? s.totalCost / s.qty : 0;
  const rate = s.totalCost > 0 ? (pl / s.totalCost) * 100 : NaN;
  const cls  = pc(pl);

  return `
    <div class="metrics-grid">
      <div class="metric">
        <div class="m-label">成交均價</div>
        <div class="m-val">${fmtPrice(avg)}</div>
      </div>
      <div class="metric">
        <div class="m-label">現值</div>
        <div class="m-val">${fmtAmount(cv)}</div>
      </div>
      <div class="metric">
        <div class="m-label">市價</div>
        <div class="m-val">${fmtPrice(s.price)}</div>
      </div>
      <div class="metric">
        <div class="m-label">預估損益</div>
        <div class="m-val ${cls}">${fmtPL(pl)}</div>
      </div>
      <div class="metric">
        <div class="m-label">付出成本</div>
        <div class="m-val">${fmtAmount(s.totalCost)}</div>
      </div>
      <div class="metric">
        <div class="m-label">報酬率</div>
        <div class="m-val ${cls}">${fmtRate(rate)}</div>
      </div>
    </div>
    <div class="detail-actions">
      <button class="buy-btn"  onclick="openTrade('buy',${s.id})">買入</button>
      <button class="sell-btn" onclick="openTrade('sell',${s.id})">賣出</button>
      <button class="del-btn"  onclick="deleteStock(${s.id})">刪除</button>
    </div>
    <div class="tx-section">
      <div class="tx-title">交易紀錄</div>
      <div id="tx-${s.id}"><span class="loading-tip">載入中…</span></div>
    </div>`;
}

async function loadTxIntoPanel(stockId) {
  const el = $("tx-" + stockId);
  if (!el) return;

  const txs = await idb.byIndex("transactions", "stockId", stockId);
  txs.sort((a, b) => b.timestamp - a.timestamp);

  const typeLabel = { init: "初次建立", buy: "買入", sell: "賣出" };
  el.innerHTML = txs.map(t => {
    const isSell = t.type === "sell";
    const qSign  = isSell ? "−" : "+";
    const qCls   = isSell ? "neg" : "pos";
    return `<div class="tx-row" id="txrow-${t.id}">
      <div class="tx-main">
        <span class="tx-type ${qCls}">${typeLabel[t.type] || t.type}</span>
        <span class="tx-qty ${qCls}">${qSign}${t.qty} 股</span>
        <span class="tx-amt">${fmtAmount(t.amount)}</span>
        <span class="tx-actions">
          <button class="tx-edit-btn" onclick="editTx(${t.id},${stockId})">修改</button>
          <button class="tx-del-btn"  onclick="deleteTx(${t.id},${stockId})">刪除</button>
        </span>
      </div>
      <div class="tx-date">${fmtDate(t.timestamp)}</div>
    </div>`;
  }).join("") || '<div class="empty-tip">尚無交易紀錄</div>';
}

/* ── 交易紀錄 修改 / 刪除 ────────────────────────────────────── */

async function deleteTx(txId, stockId) {
  if (!confirm("確定刪除這筆交易紀錄？")) return;

  // 拿回這筆 tx 以便反推對股票的影響
  const tx = await idb.get("transactions", txId);
  if (!tx) return;

  const s = await idb.get("stocks", stockId);
  if (!s) { await idb.del("transactions", txId); return; }

  // 反向還原：刪除一筆 buy → 減少成本和股數；刪除一筆 sell → 恢復成本和股數
  if (tx.type === "buy") {
    s.qty       -= tx.qty;
    s.totalCost -= tx.amount;
  } else if (tx.type === "sell") {
    s.qty       += tx.qty;
    s.totalCost += tx.amount;  // amount 在賣出時就是 sellQty * avgCostAtTime
  } else if (tx.type === "init") {
    s.qty       -= tx.qty;
    s.totalCost -= tx.amount;
  }

  await idb.del("transactions", txId);

  if (s.qty <= 0) {
    await idb.del("stocks", stockId);
    expandedId = null;
  } else {
    await idb.put("stocks", s);
  }
  await renderMain();
}

let editTxState = null;   // { txId, stockId, type }

async function editTx(txId, stockId) {
  const tx = await idb.get("transactions", txId);
  if (!tx) return;
  editTxState = { txId, stockId, type: tx.type };

  const typeLabel = { init: "初次建立", buy: "買入", sell: "賣出" };
  $("editTxTitle").textContent = "修改紀錄 — " + (typeLabel[tx.type] || tx.type);
  $("etQty").value  = fmtQty(tx.qty);
  $("etAmt").value  = Math.round(tx.amount);

  const isSell = tx.type === "sell";
  $("etHint").textContent = isSell
    ? "賣出金額 = 賣出股數 × 當時平均成本（用於還原成本）"
    : "花費金額（含手續費）";

  openModal("editTxModal");
}

async function submitEditTx() {
  if (!editTxState) return;
  const { txId, stockId } = editTxState;

  const newQty = parseQty($("etQty").value);
  const newAmt = Number($("etAmt").value);
  if (!newQty || newQty <= 0)  { alert("請輸入正確股數"); return; }
  if (isNaN(newAmt) || newAmt < 0) { alert("請輸入正確金額"); return; }

  const tx = await idb.get("transactions", txId);
  const s  = await idb.get("stocks", stockId);
  if (!tx || !s) return;

  // 反向還原舊的影響
  if (tx.type === "buy" || tx.type === "init") {
    s.qty       -= tx.qty;
    s.totalCost -= tx.amount;
  } else if (tx.type === "sell") {
    s.qty       += tx.qty;
    s.totalCost += tx.amount;
  }

  // 套用新值
  if (tx.type === "buy" || tx.type === "init") {
    s.qty       += newQty;
    s.totalCost += newAmt;
  } else if (tx.type === "sell") {
    s.qty       -= newQty;
    s.totalCost -= newAmt;
  }

  tx.qty    = newQty;
  tx.amount = newAmt;

  closeModal("editTxModal");
  editTxState = null;

  if (s.qty <= 0) {
    await idb.del("stocks", stockId);
    await idb.del("transactions", txId);
    expandedId = null;
    await renderMain();
    return;
  }

  await idb.put("stocks", s);
  await idb.put("transactions", tx);

  const panel = $("panel-" + stockId);
  if (panel && !panel.classList.contains("hidden")) {
    const fresh = await idb.get("stocks", stockId);
    if (fresh) { panel.innerHTML = buildDetailHTML(fresh); await loadTxIntoPanel(stockId); }
  }
  await renderMain();
}

/* ── 手風琴展開 ─────────────────────────────────────────────── */

async function toggleDetail(id) {
  const panel = $("panel-" + id);
  const chev  = panel ? panel.closest(".stock-item").querySelector(".col-chev") : null;

  if (expandedId === id) {
    // 折疊
    panel.classList.add("hidden");
    if (chev) chev.classList.remove("open");
    expandedId = null;
    return;
  }

  // 折疊上一個
  if (expandedId != null) {
    const prev = $("panel-" + expandedId);
    if (prev) prev.classList.add("hidden");
    const prevItem = $("item-" + expandedId);
    if (prevItem) prevItem.querySelector(".col-chev")?.classList.remove("open");
  }

  expandedId = id;
  if (chev) chev.classList.add("open");

  // 補入最新內容
  const s = await idb.get("stocks", id);
  if (!s) return;
  panel.innerHTML = buildDetailHTML(s);
  panel.classList.remove("hidden");
  await loadTxIntoPanel(id);
}

/* ── 新增股票 ───────────────────────────────────────────────── */

function openAddStock() {
  ["asCode","asName","asQty","asCost"].forEach(id => $(id).value = "");
  $("asSuggest").style.display = "none";
  openModal("addModal");
}

async function submitAddStock() {
  const code = $("asCode").value.trim().toUpperCase();
  const name = $("asName").value.trim() || code;
  const qty  = parseQty($("asQty").value);
  const cost = Number($("asCost").value);

  if (!code)              { alert("請輸入股票代號"); return; }
  if (!qty || qty <= 0)   { alert("請輸入正確股數"); return; }
  if (!cost || cost <= 0) { alert("請輸入付出成本"); return; }

  const price = priceMap[code]?.price ?? (cost / qty);

  const stockId = await idb.add("stocks", {
    code, name, qty,
    totalCost: cost,
    price,
    priceAt: Date.now()
  });

  await idb.add("transactions", {
    stockId,
    type: "init",
    qty,
    amount: cost,
    timestamp: Date.now()
  });

  closeModal("addModal");
  await renderMain();
}

/* ── 自動完成 ───────────────────────────────────────────────── */

$("asCode").addEventListener("input", () => {
  const q = $("asCode").value.trim();
  if (!q || !Object.keys(priceMap).length) {
    $("asSuggest").style.display = "none"; return;
  }
  const list = Object.values(priceMap);
  const matches = list
    .filter(p => p.code.startsWith(q) || (p.name && p.name.includes(q)))
    .slice(0, 8);

  if (!matches.length) { $("asSuggest").style.display = "none"; return; }

  $("asSuggest").innerHTML = matches.map(m =>
    `<div class="suggest-item"
         data-code="${m.code}" data-name="${m.name}" data-price="${m.price}">
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
  $("asSuggest").style.display = "none";
});

document.addEventListener("click", e => {
  if (!e.target.closest(".autocomplete-wrap"))
    $("asSuggest").style.display = "none";
});

/* ── 買入 / 賣出 ─────────────────────────────────────────────── */

let tradeStockId = null;
let tradeType    = null;

async function openTrade(type, stockId) {
  tradeStockId = stockId;
  tradeType    = type;
  $("tradeTitle").textContent = type === "buy" ? "買入" : "賣出";

  if (type === "buy") {
    $("tradeFields").innerHTML = `
      <input id="tQty" type="text" inputmode="decimal" placeholder="買入股數">
      <input id="tAmt" type="number" inputmode="decimal" placeholder="花費金額（含手續費，元）">`;
  } else {
    const s   = await idb.get("stocks", stockId);
    const avg = s && s.qty > 0 ? (s.totalCost / s.qty).toFixed(2) : 0;
    $("tradeFields").innerHTML = `
      <input id="tQty" type="text" inputmode="decimal" placeholder="賣出股數">
      <p class="trade-hint">目前均價 ${avg}，賣後成本等比例減少</p>`;
  }
  openModal("tradeModal");
  setTimeout(() => bindQtyFormat($("tQty")), 0);
}

async function submitTrade() {
  const qty = parseQty($("tQty")?.value ?? "");
  if (!qty || qty <= 0) { alert("請輸入正確股數"); return; }

  const s = await idb.get("stocks", tradeStockId);
  if (!s) return;

  if (tradeType === "buy") {
    const amt = Number($("tAmt")?.value);
    if (!amt || amt <= 0) { alert("請輸入花費金額"); return; }
    s.qty       += qty;
    s.totalCost += amt;
    await idb.put("stocks", s);
    await idb.add("transactions", {
      stockId: s.id, type: "buy", qty, amount: amt, timestamp: Date.now()
    });

  } else {
    if (qty > s.qty) { alert(`持有 ${s.qty} 股，無法賣出 ${qty} 股`); return; }
    const avg      = s.totalCost / s.qty;
    const costCut  = qty * avg;
    s.qty       -= qty;
    s.totalCost -= costCut;

    await idb.add("transactions", {
      stockId: s.id, type: "sell", qty, amount: costCut, timestamp: Date.now()
    });

    if (s.qty <= 0) {
      await idb.del("stocks", s.id);
      closeModal("tradeModal");
      if (expandedId === s.id) expandedId = null;
      await renderMain();
      return;
    }
    await idb.put("stocks", s);
  }

  closeModal("tradeModal");
  // 重新渲染展開的面板
  const panel = $("panel-" + s.id);
  if (panel && !panel.classList.contains("hidden")) {
    const fresh = await idb.get("stocks", s.id);
    if (fresh) {
      panel.innerHTML = buildDetailHTML(fresh);
      await loadTxIntoPanel(s.id);
    }
  }
  await renderMain();
}

/* ── 刪除 ───────────────────────────────────────────────────── */

async function deleteStock(id) {
  const s = await idb.get("stocks", id);
  if (!s) return;
  if (!confirm(`確定刪除「${s.name}」？紀錄一併刪除。`)) return;
  await idb.del("stocks", id);
  await idb.delByIndex("transactions", "stockId", id);
  if (expandedId === id) expandedId = null;
  await renderMain();
}

/* ── Modal 通用 ─────────────────────────────────────────────── */

function openModal(id)  { $(id).classList.remove("hidden"); }
function closeModal(id) { $(id).classList.add("hidden"); }

document.querySelectorAll(".modal-overlay").forEach(el =>
  el.addEventListener("click", e => { if (e.target === el) el.classList.add("hidden"); })
);

/* ── Service Worker ─────────────────────────────────────────── */

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js")
    .catch(e => console.warn("SW 注册失败", e));
}

/* ── 啟動 ───────────────────────────────────────────────────── */

(async () => {
  await dbReady;
  bindQtyFormat($("asQty"));   // 股數輸入框千分位格式化
  bindQtyFormat($("etQty"));
  await renderMain();           // 先用舊資料呈現，不讓畫面空白
  priceMap = await fetchPrices();
  await updateAllPricesInDB();
  await renderMain();           // 用最新股價重渲染
})();
