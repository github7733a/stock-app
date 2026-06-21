/* =========================================================
   股票資產管理 app.js
   功能：
   1. 台股代號/名稱自動完成 + 自動帶入最新收盤價
      （資料來源：證交所 TWSE OpenAPI + 櫃買中心 TPEx OpenAPI，
       皆為「每日收盤後」更新一次，非即時報價。
       實際呼叫是透過 /api/prices 這支 Cloudflare Pages Function
       在伺服器端代抓，避免瀏覽器直接呼叫被 CORS 擋掉）
   2. 依股數自動計算市值 / 損益
   3. 資產總額（現金 + 股票市值），現金可直接在總覽卡片修改
   4. 新增股票表單預設收合，新增成功後自動收起來
   5. 股票清單精簡為「股名 / 股數 / 總損益」，底部顯示總損益與總報酬率
   ========================================================= */

let db;
let priceList = [];          // [{code, name, price}]
let priceListUpdatedAt = null;
let currentCash = 0;
let cashEditing = false;

const request = indexedDB.open("assetDB", 2);

request.onupgradeneeded = function (e) {
  const database = e.target.result;

  if (!database.objectStoreNames.contains("store")) {
    database.createObjectStore("store");
  }

  // 舊版 stocks store 沒有 key，無法正常寫入，重建一個有 id 的版本
  if (database.objectStoreNames.contains("stocks")) {
    database.deleteObjectStore("stocks");
  }
  database.createObjectStore("stocks", { keyPath: "id", autoIncrement: true });
};

request.onsuccess = async function (e) {
  db = e.target.result;
  loadCash();
  await ensurePriceList();
};

request.onerror = function (e) {
  console.error("IndexedDB 開啟失敗", e);
};

/* ===== 共用工具 ===== */

function fmt(n) {
  const num = Number(n) || 0;
  const sign = num < 0 ? "-" : "";
  return sign + "NT$ " + Math.round(Math.abs(num)).toLocaleString("zh-TW");
}

function todayKey() {
  const d = new Date();
  return d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate();
}

function setPriceStatus(text) {
  const el = document.getElementById("priceStatus");
  if (el) el.textContent = text;
}

/* ===== 股價清單（自動完成 + 帶入價格用） ===== */

function normalizeItem(item) {
  if (!item || typeof item !== "object") return null;
  const keys = Object.keys(item);

  const codeKey = keys.find(k => /code/i.test(k)) || keys.find(k => k.includes("代號") || k.includes("代碼"));
  const nameKey = keys.find(k => /name/i.test(k)) || keys.find(k => k.includes("名稱"));
  const closeKey =
    keys.find(k => /^closingprice$/i.test(k)) ||
    keys.find(k => /close/i.test(k)) ||
    keys.find(k => k.includes("收盤"));

  if (!codeKey || !closeKey) return null;

  const code = String(item[codeKey]).trim();
  const name = nameKey ? String(item[nameKey]).trim() : code;
  const price = parseFloat(String(item[closeKey]).replace(/,/g, ""));

  if (!code || !/^[0-9A-Za-z]{1,10}$/.test(code) || isNaN(price)) return null;

  return { code, name, price };
}

async function fetchPriceList() {
  const map = new Map();
  function addAll(arr) {
    arr.forEach(raw => {
      const n = normalizeItem(raw);
      if (n && !map.has(n.code)) map.set(n.code, n);
    });
  }

  // 透過 /api/prices（Cloudflare Pages Function）在伺服器端代抓，
  // 避免瀏覽器直接打證交所/櫃買中心 API 時被 CORS 擋下來。
  try {
    const res = await fetch("/api/prices");
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data)) addAll(data);
    } else {
      console.warn("/api/prices 回應失敗", res.status);
    }
  } catch (err) {
    console.warn("股價代理 API 抓取失敗", err);
  }

  return Array.from(map.values());
}

async function ensurePriceList() {
  const cacheRaw = localStorage.getItem("priceListCache");
  let usedCache = false;

  if (cacheRaw) {
    try {
      const cache = JSON.parse(cacheRaw);
      if (cache.date === todayKey() && Array.isArray(cache.list) && cache.list.length) {
        priceList = cache.list;
        priceListUpdatedAt = cache.fetchedAt;
        usedCache = true;
        setPriceStatus("股價快取於 " + new Date(cache.fetchedAt).toLocaleString("zh-TW"));
      }
    } catch (err) {
      console.warn("讀取股價快取失敗", err);
    }
  }

  if (usedCache) {
    await syncStockPrices();
    loadStocks();
    computeTotalsFromDB();
  } else {
    await refreshPrices(false);
  }
}

async function refreshPrices(manual) {
  setPriceStatus("股價更新中…");
  const list = await fetchPriceList();

  if (list.length) {
    priceList = list;
    const payload = { date: todayKey(), list, fetchedAt: Date.now() };
    try {
      localStorage.setItem("priceListCache", JSON.stringify(payload));
    } catch (err) {
      console.warn("寫入股價快取失敗", err);
    }
    priceListUpdatedAt = payload.fetchedAt;
    setPriceStatus("股價已更新（" + new Date(payload.fetchedAt).toLocaleString("zh-TW") + "，非即時）");
    await syncStockPrices();
  } else {
    setPriceStatus(manual ? "更新失敗，可手動輸入股價" : "暫時無法取得最新股價，可手動輸入");
  }

  loadStocks();
  computeTotalsFromDB();
}

// 用最新 priceList 更新資料庫裡每一筆股票的 currentPrice
function syncStockPrices() {
  return new Promise(resolve => {
    if (!priceList.length) return resolve();
    const tx = db.transaction("stocks", "readwrite");
    const store = tx.objectStore("stocks");
    const req = store.getAll();

    req.onsuccess = () => {
      req.result.forEach(item => {
        const match = priceList.find(p => p.code === item.code);
        if (match) {
          item.currentPrice = match.price;
          item.priceUpdatedAt = priceListUpdatedAt;
          if (!item.name) item.name = match.name;
          store.put(item);
        }
      });
    };
    tx.oncomplete = resolve;
    tx.onerror = resolve;
  });
}

/* ===== 新增股票表單收合 ===== */

function toggleAddForm() {
  const body = document.getElementById("addFormBody");
  const icon = document.getElementById("addToggleIcon");
  const isNowCollapsed = body.classList.toggle("collapsed");
  icon.textContent = isNowCollapsed ? "＋" : "－";
}

function collapseAddForm() {
  const body = document.getElementById("addFormBody");
  const icon = document.getElementById("addToggleIcon");
  body.classList.add("collapsed");
  icon.textContent = "＋";
}

/* ===== 自動完成 UI ===== */

const stockNameInput = document.getElementById("stockName");
const suggestList = document.getElementById("suggestList");

stockNameInput.addEventListener("input", () => {
  const q = stockNameInput.value.trim();
  if (!q) {
    suggestList.innerHTML = "";
    suggestList.style.display = "none";
    return;
  }

  const matches = priceList
    .filter(p => p.code.startsWith(q) || p.name.includes(q))
    .slice(0, 8);

  if (!matches.length) {
    suggestList.innerHTML = "";
    suggestList.style.display = "none";
    return;
  }

  suggestList.innerHTML = matches
    .map(
      m => `<div class="suggest-item" data-code="${m.code}" data-price="${m.price}">
              <span>${m.code} ${m.name}</span>
              <span class="suggest-price">${m.price}</span>
            </div>`
    )
    .join("");
  suggestList.style.display = "block";
});

suggestList.addEventListener("click", e => {
  const item = e.target.closest(".suggest-item");
  if (!item) return;
  stockNameInput.value = item.dataset.code;
  document.getElementById("stockPrice").value = item.dataset.price;
  suggestList.innerHTML = "";
  suggestList.style.display = "none";
  updateEstValue();
});

document.addEventListener("click", e => {
  if (!e.target.closest(".autocomplete-wrap")) {
    suggestList.style.display = "none";
  }
});

/* ===== 預估市值（股數 x 目前股價） ===== */

function updateEstValue() {
  const qty = Number(document.getElementById("stockQty").value) || 0;
  const price = Number(document.getElementById("stockPrice").value) || 0;
  document.getElementById("estValue").textContent = fmt(qty * price);
}

document.getElementById("stockQty").addEventListener("input", updateEstValue);
document.getElementById("stockPrice").addEventListener("input", updateEstValue);

/* ===== 現金（直接在資產總覽卡片修改） ===== */

function loadCash() {
  const tx = db.transaction("store", "readonly");
  const req = tx.objectStore("store").get("cash");
  req.onsuccess = () => {
    currentCash = Number(req.result) || 0;
    document.getElementById("totalCash").textContent = fmt(currentCash);
  };
}

function saveCash(value) {
  const tx = db.transaction("store", "readwrite");
  tx.objectStore("store").put(value, "cash");
  tx.oncomplete = () => {
    currentCash = value;
    document.getElementById("totalCash").textContent = fmt(currentCash);
    computeTotalsFromDB();
  };
}

function toggleCashEdit() {
  const span = document.getElementById("totalCash");
  const input = document.getElementById("cashEditInput");
  const btn = document.getElementById("cashEditBtn");

  if (!cashEditing) {
    input.value = currentCash;
    span.style.display = "none";
    input.style.display = "inline-block";
    btn.textContent = "儲存";
    cashEditing = true;
    input.focus();
    input.select();
  } else {
    const value = Number(input.value) || 0;
    span.style.display = "inline";
    input.style.display = "none";
    btn.textContent = "修改";
    cashEditing = false;
    saveCash(value);
  }
}

document.getElementById("cashEditInput").addEventListener("keydown", e => {
  if (e.key === "Enter") toggleCashEdit();
});

/* ===== 股票 ===== */

function addStock() {
  const code = stockNameInput.value.trim();
  const qty = Number(document.getElementById("stockQty").value);
  const cost = Number(document.getElementById("stockCost").value) || 0;
  const priceInput = document.getElementById("stockPrice").value;

  if (!code || !qty) {
    alert("請輸入股票代號與股數");
    return;
  }

  const match = priceList.find(p => p.code === code);
  const name = match ? match.name : code;
  const price = priceInput !== "" ? Number(priceInput) : (match ? match.price : cost);

  const stock = {
    code,
    name,
    qty,
    cost,
    currentPrice: price,
    priceUpdatedAt: priceListUpdatedAt
  };

  const tx = db.transaction("stocks", "readwrite");
  tx.objectStore("stocks").add(stock);

  tx.oncomplete = () => {
    stockNameInput.value = "";
    document.getElementById("stockQty").value = "";
    document.getElementById("stockCost").value = "";
    document.getElementById("stockPrice").value = "";
    updateEstValue();
    collapseAddForm();
    loadStocks();
    computeTotalsFromDB();
  };

  tx.onerror = (e) => {
    console.error("新增股票失敗", e);
    alert("新增失敗，請重試");
  };
}

function deleteStock(id) {
  const tx = db.transaction("stocks", "readwrite");
  tx.objectStore("stocks").delete(id);
  tx.oncomplete = () => {
    loadStocks();
    computeTotalsFromDB();
  };
}

function loadStocks() {
  const tx = db.transaction("stocks", "readonly");
  const req = tx.objectStore("stocks").getAll();

  req.onsuccess = () => {
    const list = req.result;
    let html = "";

    list.forEach(s => {
      const price = s.currentPrice != null ? s.currentPrice : s.cost;
      const value = s.qty * price;
      const costValue = s.qty * (s.cost || 0);
      const pl = value - costValue;
      const plClass = pl > 0 ? "pl-pos" : pl < 0 ? "pl-neg" : "";
      const plSign = pl > 0 ? "+" : "";

      html += `
        <div class="stock-row-compact">
          <div class="stock-name"><b>${s.code}</b><small>${s.name || ""}</small></div>
          <div>${s.qty}</div>
          <div class="${plClass}">${plSign}${fmt(pl)}</div>
          <button class="del-btn-sm" onclick="deleteStock(${s.id})">×</button>
        </div>`;
    });

    document.getElementById("stockList").innerHTML = html || '<div class="empty-tip">尚未新增股票</div>';
  };
}

/* ===== 資產總額 / 總損益 / 總報酬率 ===== */

function computeTotalsFromDB() {
  const tx = db.transaction("stocks", "readonly");
  const req = tx.objectStore("stocks").getAll();

  req.onsuccess = () => {
    let stocksTotal = 0;
    let costTotal = 0;

    req.result.forEach(s => {
      const price = s.currentPrice != null ? s.currentPrice : s.cost;
      stocksTotal += s.qty * price;
      costTotal += s.qty * (s.cost || 0);
    });

    const plTotal = stocksTotal - costTotal;

    updateTotalCard(stocksTotal);
    updatePLSummary(plTotal, costTotal);
  };
}

function updateTotalCard(stocksTotal) {
  document.getElementById("totalStocks").textContent = fmt(stocksTotal);
  document.getElementById("totalDisplay").textContent = fmt(currentCash + stocksTotal);
}

function updatePLSummary(plTotal, costTotal) {
  const plEl = document.getElementById("totalPL");
  const rateEl = document.getElementById("totalReturnRate");
  const plClass = plTotal > 0 ? "pl-pos" : plTotal < 0 ? "pl-neg" : "";

  plEl.textContent = (plTotal > 0 ? "+" : "") + fmt(plTotal);
  plEl.className = plClass;

  if (costTotal > 0) {
    const rate = (plTotal / costTotal) * 100;
    rateEl.textContent = (rate > 0 ? "+" : "") + rate.toFixed(2) + "%";
    rateEl.className = plClass;
  } else {
    rateEl.textContent = "-";
    rateEl.className = "";
  }
}
