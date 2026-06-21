/* =========================================================
   資產管理 app.js

   資料結構（IndexedDB v3）：
   - accounts: { id, category: 'cash'|'invest'|'debt', code(投資選填),
                 name, qty, price, createdAt }
     餘額固定 = qty * price。流動資金/負債的 qty 固定為 1，
     price 就是餘額；投資可以是 qty 股 * 股價。
   - transactions: { id, accountId, label, deltaType:'money'|'qty',
                      deltaValue, resultBalance, resultQty, timestamp }
     只有使用者主動操作（新增/增減/修改餘額）才會寫入，
     每天自動更新股價不會產生紀錄。

   股價資料來源同舊版：透過 /api/prices（Cloudflare Pages Function）
   代抓證交所 + 櫃買中心，每天更新一次、非即時。

   舊版資料（store 的 cash、stocks 表）會在第一次升級時
   自動搬進新的 accounts / transactions。
   ========================================================= */

let db;
let priceList = [];
let priceListUpdatedAt = null;

let expandedCategory = null;
let addFlowCategory = null;
let currentDetailAccountId = null;
let activeEditor = null;

const categoryLabels = { cash: "流動資金", invest: "投資", debt: "負債" };

const request = indexedDB.open("assetDB", 3);

request.onupgradeneeded = function (e) {
  const database = e.target.result;
  const tx = e.target.transaction;

  if (!database.objectStoreNames.contains("store")) {
    database.createObjectStore("store");
  }

  const hasOldStocks = database.objectStoreNames.contains("stocks");
  const hasAccounts = database.objectStoreNames.contains("accounts");
  const hasTxStore = database.objectStoreNames.contains("transactions");

  const accountsStore = hasAccounts
    ? tx.objectStore("accounts")
    : database.createObjectStore("accounts", { keyPath: "id", autoIncrement: true });

  let txStore;
  if (hasTxStore) {
    txStore = tx.objectStore("transactions");
  } else {
    txStore = database.createObjectStore("transactions", { keyPath: "id", autoIncrement: true });
    txStore.createIndex("accountId", "accountId", { unique: false });
  }

  // 舊版股票資料 -> 投資帳戶
  if (hasOldStocks) {
    const oldStockStore = tx.objectStore("stocks");
    const now = Date.now();

    oldStockStore.getAll().onsuccess = function (ev) {
      const oldStocks = ev.target.result || [];
      oldStocks.forEach(s => {
        const qty = s.qty || 0;
        const price = s.currentPrice != null ? s.currentPrice : (s.cost || 0);
        const addReq = accountsStore.add({
          category: "invest",
          code: s.code || null,
          name: s.name || s.code || "投資",
          qty: qty,
          price: price,
          createdAt: now
        });
        addReq.onsuccess = function (addEv) {
          const newId = addEv.target.result;
          txStore.add({
            accountId: newId,
            label: "資料轉移",
            deltaType: "money",
            deltaValue: qty * price,
            resultBalance: qty * price,
            resultQty: qty,
            timestamp: now
          });
        };
      });
    };

    database.deleteObjectStore("stocks");
  }

  // 舊版現金 -> 流動資金帳戶
  const oldStoreForCash = tx.objectStore("store");
  oldStoreForCash.get("cash").onsuccess = function (ev) {
    const cashVal = Number(ev.target.result) || 0;
    if (cashVal > 0) {
      const now2 = Date.now();
      const addReq = accountsStore.add({
        category: "cash",
        code: null,
        name: "現金",
        qty: 1,
        price: cashVal,
        createdAt: now2
      });
      addReq.onsuccess = function (addEv) {
        const newId = addEv.target.result;
        txStore.add({
          accountId: newId,
          label: "資料轉移",
          deltaType: "money",
          deltaValue: cashVal,
          resultBalance: cashVal,
          resultQty: 1,
          timestamp: now2
        });
      };
    }
  };
};

request.onsuccess = async function (e) {
  db = e.target.result;
  renderAll();
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

function fmtQty(n) {
  const num = Number(n) || 0;
  return (Math.round(num * 100) / 100).toString();
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
    renderAll();
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

  renderAll();
}

// 用最新 priceList 更新有連結代號的投資帳戶（不寫入變動紀錄）
function syncStockPrices() {
  return new Promise(resolve => {
    if (!priceList.length) return resolve();
    const tx = db.transaction("accounts", "readwrite");
    const store = tx.objectStore("accounts");
    const req = store.getAll();

    req.onsuccess = () => {
      req.result.forEach(acc => {
        if (acc.category === "invest" && acc.code) {
          const match = priceList.find(p => p.code === acc.code);
          if (match) {
            acc.price = match.price;
            store.put(acc);
          }
        }
      });
    };
    tx.oncomplete = resolve;
    tx.onerror = resolve;
  });
}

/* ===== 主畫面：分類展開/收合 + 渲染 ===== */

function toggleCategory(cat) {
  const list = document.getElementById(cat + "AccountList");
  const chevron = document.getElementById(cat + "Chevron");
  const collapsed = list.classList.toggle("collapsed");
  chevron.classList.toggle("open", !collapsed);
}

function renderAll() {
  if (!db) return;
  const tx = db.transaction("accounts", "readonly");
  const req = tx.objectStore("accounts").getAll();

  req.onsuccess = () => {
    const all = req.result;
    const byCategory = { cash: [], invest: [], debt: [] };
    all.forEach(a => { if (byCategory[a.category]) byCategory[a.category].push(a); });

    let cashTotal = 0, investTotal = 0, debtTotal = 0;
    byCategory.cash.forEach(a => cashTotal += a.qty * a.price);
    byCategory.invest.forEach(a => investTotal += a.qty * a.price);
    byCategory.debt.forEach(a => debtTotal += a.qty * a.price);

    document.getElementById("cashCategoryTotal").textContent = fmt(cashTotal);
    document.getElementById("investCategoryTotal").textContent = fmt(investTotal);
    document.getElementById("debtCategoryTotal").textContent = fmt(debtTotal);
    document.getElementById("netWorthDisplay").textContent = fmt(cashTotal + investTotal - debtTotal);

    renderAccountList("cash", byCategory.cash);
    renderAccountList("invest", byCategory.invest);
    renderAccountList("debt", byCategory.debt);

    if (currentDetailAccountId != null) {
      const acc = all.find(a => a.id === currentDetailAccountId);
      if (acc) renderDetailHeader(acc);
    }
  };
}

function renderAccountList(category, accounts) {
  const listEl = document.getElementById(category + "AccountList");
  if (!accounts.length) {
    listEl.innerHTML = '<div class="empty-tip">尚無帳戶</div>';
    return;
  }
  listEl.innerHTML = accounts
    .map(acc => {
      const balance = acc.qty * acc.price;
      return `<div class="account-item" onclick="openDetail(${acc.id})">
        <span>${acc.name}</span>
        <span>${fmt(balance)}</span>
      </div>`;
    })
    .join("");
}

/* ===== 新增帳戶流程 ===== */

function openAddFlow() {
  addFlowCategory = null;
  document.getElementById("addStep1").classList.remove("hidden");
  document.getElementById("addStep2").classList.add("hidden");
  document.getElementById("addFlowOverlay").classList.remove("hidden");
}

function closeAddFlow() {
  document.getElementById("addFlowOverlay").classList.add("hidden");
  document.getElementById("addAccountCode").value = "";
  document.getElementById("addAccountName").value = "";
  document.getElementById("addAccountQty").value = "";
  document.getElementById("addAccountAmount").value = "";
  document.getElementById("addSuggestList").innerHTML = "";
}

function selectAddCategory(cat) {
  addFlowCategory = cat;
  document.getElementById("addStep2Title").textContent = categoryLabels[cat];
  document.getElementById("addStep1").classList.add("hidden");
  document.getElementById("addStep2").classList.remove("hidden");

  const isInvest = cat === "invest";
  document.getElementById("addInvestCodeWrap").classList.toggle("hidden", !isInvest);
  document.getElementById("addAccountQty").classList.toggle("hidden", !isInvest);
  document.getElementById("addAccountAmount").placeholder = isInvest ? "目前股價（自動帶入，也可手動修改）" : "金額";
}

function submitAddAccount() {
  const category = addFlowCategory;
  const name = document.getElementById("addAccountName").value.trim();
  let qty = 1;
  let price = 0;
  let code = null;

  if (category === "invest") {
    code = document.getElementById("addAccountCode").value.trim() || null;
    qty = Number(document.getElementById("addAccountQty").value) || 0;
    price = Number(document.getElementById("addAccountAmount").value) || 0;
    if (!name || !qty || !price) {
      alert("請完整輸入帳戶名稱、股數與股價");
      return;
    }
  } else {
    price = Number(document.getElementById("addAccountAmount").value) || 0;
    if (!name) {
      alert("請輸入帳戶名稱");
      return;
    }
  }

  const acc = { category, code, name, qty, price, createdAt: Date.now() };

  const tx = db.transaction("accounts", "readwrite");
  const req = tx.objectStore("accounts").add(acc);

  tx.oncomplete = () => {
    const newId = req.result;
    recordTransaction(newId, "新建帳戶", "money", qty * price, qty * price, qty);
    closeAddFlow();
    renderAll();
  };
}

/* ===== 帳戶詳情 ===== */

function openDetail(id) {
  currentDetailAccountId = id;
  cancelEditor();
  const tx = db.transaction("accounts", "readonly");
  tx.objectStore("accounts").get(id).onsuccess = e => {
    const acc = e.target.result;
    if (!acc) return;
    renderDetailHeader(acc);
    loadTransactions(id);
    document.getElementById("detailOverlay").classList.remove("hidden");
  };
}

function closeDetail() {
  document.getElementById("detailOverlay").classList.add("hidden");
  currentDetailAccountId = null;
  cancelEditor();
}

function renderDetailHeader(acc) {
  const balance = acc.qty * acc.price;
  document.getElementById("detailName").textContent = acc.name;
  document.getElementById("detailBalance").textContent = fmt(balance);

  const isInvest = acc.category === "invest";
  document.getElementById("detailQtyPriceRow").classList.toggle("hidden", !isInvest);
  if (isInvest) {
    document.getElementById("detailQtyPriceText").textContent =
      fmtQty(acc.qty) + " 股 × " + fmt(acc.price) + (acc.code ? "（" + acc.code + "）" : "");
  }
  document.getElementById("deltaBtnLabel").textContent = isInvest ? "增減股數" : "增減金額";
}

function loadTransactions(accountId) {
  const tx = db.transaction("transactions", "readonly");
  const idx = tx.objectStore("transactions").index("accountId");
  const req = idx.getAll(accountId);

  req.onsuccess = () => {
    const list = (req.result || []).sort((a, b) => b.timestamp - a.timestamp);
    const html = list
      .map(t => {
        const isQty = t.deltaType === "qty";
        const sign = t.deltaValue >= 0 ? "+" : "";
        const deltaText = isQty ? sign + fmtQty(t.deltaValue) + " 股" : sign + fmt(t.deltaValue);
        const dateStr = new Date(t.timestamp).toLocaleString("zh-TW", {
          year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit"
        });
        return `<div class="tx-row">
          <div class="tx-top">
            <span>${t.label}</span>
            <span>${deltaText}</span>
          </div>
          <div class="tx-bottom">
            <span>${dateStr}</span>
            <span>餘額 ${fmt(t.resultBalance)}</span>
          </div>
        </div>`;
      })
      .join("");
    document.getElementById("txList").innerHTML = html || '<div class="empty-tip">尚無紀錄</div>';
  };
}

function recordTransaction(accountId, label, deltaType, deltaValue, resultBalance, resultQty) {
  const tx = db.transaction("transactions", "readwrite");
  tx.objectStore("transactions").add({
    accountId, label, deltaType, deltaValue, resultBalance, resultQty, timestamp: Date.now()
  });
}

/* ===== 增減金額／股數、修改餘額 ===== */

function showEditor(type) {
  activeEditor = type;
  document.getElementById("editorDelta").classList.toggle("hidden", type !== "delta");
  document.getElementById("editorBalance").classList.toggle("hidden", type !== "balance");

  if (type === "delta") {
    document.getElementById("deltaInput").value = "";
    document.getElementById("deltaInput").focus();
  } else if (type === "balance") {
    document.getElementById("balanceInput").value = "";
    document.getElementById("balanceInput").focus();
  }
}

function cancelEditor() {
  activeEditor = null;
  document.getElementById("editorDelta").classList.add("hidden");
  document.getElementById("editorBalance").classList.add("hidden");
}

function confirmDelta() {
  const id = currentDetailAccountId;
  const rawStr = document.getElementById("deltaInput").value;
  if (rawStr === "") { cancelEditor(); return; }
  const raw = Number(rawStr);

  const tx = db.transaction("accounts", "readwrite");
  const store = tx.objectStore("accounts");

  store.get(id).onsuccess = e => {
    const acc = e.target.result;
    if (!acc) return;
    const isInvest = acc.category === "invest";
    let label, deltaType;

    if (isInvest) {
      acc.qty = (acc.qty || 0) + raw;
      label = "增減股數";
      deltaType = "qty";
    } else {
      acc.price = (acc.price || 0) + raw;
      label = "增減金額";
      deltaType = "money";
    }
    store.put(acc);

    tx.oncomplete = () => {
      recordTransaction(id, label, deltaType, raw, acc.qty * acc.price, acc.qty);
      cancelEditor();
      openDetail(id);
      renderAll();
    };
  };
}

function confirmBalance() {
  const id = currentDetailAccountId;
  const rawStr = document.getElementById("balanceInput").value;
  if (rawStr === "") { cancelEditor(); return; }
  const newBalance = Number(rawStr);

  const tx = db.transaction("accounts", "readwrite");
  const store = tx.objectStore("accounts");

  store.get(id).onsuccess = e => {
    const acc = e.target.result;
    if (!acc) return;
    const oldBalance = acc.qty * acc.price;

    if (acc.category === "invest" && acc.code && acc.price > 0) {
      // 有連結股價：股價維持市價，反推股數
      acc.qty = newBalance / acc.price;
    } else {
      // 現金 / 負債 / 自訂投資：股數不變，直接調整金額
      const qty = acc.qty || 1;
      acc.price = newBalance / qty;
      if (!acc.qty) acc.qty = 1;
    }
    store.put(acc);

    tx.oncomplete = () => {
      recordTransaction(id, "修改餘額", "money", newBalance - oldBalance, newBalance, acc.qty);
      cancelEditor();
      openDetail(id);
      renderAll();
    };
  };
}

function deleteAccount() {
  const id = currentDetailAccountId;
  if (!confirm("確定要刪除這個帳戶嗎？相關紀錄也會一併刪除")) return;

  const tx = db.transaction(["accounts", "transactions"], "readwrite");
  tx.objectStore("accounts").delete(id);

  const idx = tx.objectStore("transactions").index("accountId");
  idx.openCursor(IDBKeyRange.only(id)).onsuccess = e => {
    const cursor = e.target.result;
    if (cursor) {
      cursor.delete();
      cursor.continue();
    }
  };

  tx.oncomplete = () => {
    closeDetail();
    renderAll();
  };
}

/* ===== 新增帳戶：股票自動完成 ===== */

const addAccountCodeInput = document.getElementById("addAccountCode");
const addSuggestList = document.getElementById("addSuggestList");

addAccountCodeInput.addEventListener("input", () => {
  const q = addAccountCodeInput.value.trim();
  if (!q) {
    addSuggestList.innerHTML = "";
    addSuggestList.style.display = "none";
    return;
  }

  const matches = priceList.filter(p => p.code.startsWith(q) || p.name.includes(q)).slice(0, 8);
  if (!matches.length) {
    addSuggestList.innerHTML = "";
    addSuggestList.style.display = "none";
    return;
  }

  addSuggestList.innerHTML = matches
    .map(
      m => `<div class="suggest-item" data-code="${m.code}" data-name="${m.name}" data-price="${m.price}">
              <span>${m.code} ${m.name}</span>
              <span class="suggest-price">${m.price}</span>
            </div>`
    )
    .join("");
  addSuggestList.style.display = "block";
});

addSuggestList.addEventListener("click", e => {
  const item = e.target.closest(".suggest-item");
  if (!item) return;
  addAccountCodeInput.value = item.dataset.code;
  document.getElementById("addAccountName").value = item.dataset.name;
  document.getElementById("addAccountAmount").value = item.dataset.price;
  addSuggestList.innerHTML = "";
  addSuggestList.style.display = "none";
});

document.addEventListener("click", e => {
  if (!e.target.closest(".autocomplete-wrap")) {
    addSuggestList.style.display = "none";
  }
});
