"use strict";
/* ============================================================
   app.js
   - 4-tab 切換（目標/餘額 空殼，股票/質押完整）
   - 股票與質押共用同一套邏輯，分別存在 stockAppDB / pledgeAppDB
   - 股價共用同一個 priceMap
   ============================================================ */

/* ── 格式化 ─────────────────────────────────────────────────── */
const $ = id => document.getElementById(id);

function fmtPrice(n) {
  return (Number(n)||0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
function fmtAmount(n) {
  return Math.round(Math.abs(Number(n)||0)).toLocaleString("zh-TW");
}
function fmtPL(n) {
  const v = Math.round(Number(n)||0);
  return v < 0 ? `(${Math.abs(v).toLocaleString("zh-TW")})` : v.toLocaleString("zh-TW");
}
function fmtQty(n)  { return Number(n).toLocaleString("zh-TW"); }
function parseQty(s){ return Number(String(s).replace(/,/g,""))||0; }
function fmtRate(r) {
  const v = Number(r);
  return isFinite(v) ? (v>=0?"+":"")+v.toFixed(2)+"%" : "—";
}
function fmtDate(ts) {
  return new Date(ts).toLocaleString("zh-TW",
    { year:"numeric", month:"numeric", day:"numeric",
      hour:"numeric", minute:"2-digit" });
}
function pc(n) { return Number(n)>0?"pos":Number(n)<0?"neg":""; }

function bindQtyFormat(el) {
  if (!el || el.dataset.qtyBound) return;
  el.dataset.qtyBound = "1";
  el.addEventListener("blur",  () => { const v=parseQty(el.value); if(v>0) el.value=v.toLocaleString("zh-TW"); });
  el.addEventListener("focus", () => { el.value = String(parseQty(el.value)||""); });
}

/* ── Tab ────────────────────────────────────────────────────── */
let currentTab = "stocks";

function switchTab(tab) {
  document.querySelectorAll(".page").forEach(p => p.classList.add("hidden"));
  document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
  $(`page-${tab}`).classList.remove("hidden");
  document.querySelector(`.tab[data-tab="${tab}"]`).classList.add("active");
  currentTab = tab;
  if (tab === "stocks") renderStockPage("stocks");
  if (tab === "pledge") renderStockPage("pledge");
}

/* ── Modal ──────────────────────────────────────────────────── */
function openModal(id)  { $(id).classList.remove("hidden"); }
function closeModal(id) { $(id).classList.add("hidden");    }
document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll(".modal-overlay").forEach(el =>
    el.addEventListener("click", e => { if (e.target===el) el.classList.add("hidden"); })
  );
});

/* ── IndexedDB helpers ──────────────────────────────────────── */
function openDB(name, upgrade) {
  return new Promise((res, rej) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = e => upgrade(e.target.result);
    req.onsuccess = e => res(e.target.result);
    req.onerror   = e => rej(e.target.error);
  });
}
const idb = {
  get: (db,s,k)   => new Promise((r,j)=>{ const q=db.transaction(s).objectStore(s).get(k); q.onsuccess=()=>r(q.result); q.onerror=()=>j(q.error); }),
  all: (db,s)     => new Promise((r,j)=>{ const q=db.transaction(s).objectStore(s).getAll(); q.onsuccess=()=>r(q.result); q.onerror=()=>j(q.error); }),
  put: (db,s,rec) => new Promise((r,j)=>{ const q=db.transaction(s,"readwrite").objectStore(s).put(rec); q.onsuccess=()=>r(q.result); q.onerror=()=>j(q.error); }),
  add: (db,s,rec) => new Promise((r,j)=>{ const q=db.transaction(s,"readwrite").objectStore(s).add(rec); q.onsuccess=()=>r(q.result); q.onerror=()=>j(q.error); }),
  del: (db,s,k)   => new Promise((r,j)=>{ const q=db.transaction(s,"readwrite").objectStore(s).delete(k); q.onsuccess=()=>r(); q.onerror=()=>j(q.error); }),
  idx: (db,s,i,v) => new Promise((r,j)=>{ const q=db.transaction(s).objectStore(s).index(i).getAll(v); q.onsuccess=()=>r(q.result); q.onerror=()=>j(q.error); }),
  delIdx: (db,s,i,v) => new Promise((r,j)=>{
    const tx=db.transaction(s,"readwrite");
    const q=tx.objectStore(s).index(i).openCursor(IDBKeyRange.only(v));
    q.onsuccess=e=>{ const c=e.target.result; if(c){c.delete();c.continue();} };
    tx.oncomplete=()=>r(); tx.onerror=()=>j(tx.error);
  }),
};

/* ── DB 初始化 ──────────────────────────────────────────────── */
function upgradeStockDB(db) {
  if (!db.objectStoreNames.contains("stocks"))
    db.createObjectStore("stocks", { keyPath:"id", autoIncrement:true });
  if (!db.objectStoreNames.contains("transactions")) {
    const ts = db.createObjectStore("transactions", { keyPath:"id", autoIncrement:true });
    ts.createIndex("stockId","stockId",{ unique:false });
  }
}

let stockDb, pledgeDb;
const dbsReady = Promise.all([
  openDB("stockAppDB",  upgradeStockDB).then(d => { stockDb  = d; }),
  openDB("pledgeAppDB", upgradeStockDB).then(d => { pledgeDb = d; }),
]);
const getDb = ctx => ctx === "pledge" ? pledgeDb : stockDb;

/* ── 股價 ───────────────────────────────────────────────────── */
let priceMap = {};

function normalizeQuote(item) {
  if (!item || typeof item !== "object") return null;
  const keys = Object.keys(item);
  const codeKey  = keys.find(k => k==="Code" || /code/i.test(k) || k.includes("代號"));
  const nameKey  = keys.find(k => k==="Name"||k==="StockName"||/name/i.test(k)||k.includes("名稱"));
  const closeKey = keys.find(k => k==="ClosingPrice"||k==="Close"||/^closingprice$/i.test(k)||/close/i.test(k)||k.includes("收盤"));
  if (!codeKey || !closeKey) return null;
  const code  = String(item[codeKey]).trim();
  const name  = nameKey ? String(item[nameKey]).trim() : code;
  const price = parseFloat(String(item[closeKey]).replace(/,/g,""));
  if (!code || !/^\w{1,10}$/.test(code) || isNaN(price) || price<=0) return null;
  return { code, name, price };
}

function setStatus(text) {
  $("priceStatusText").textContent = text;
  $("pledgeStatusText").textContent = text;
}

async function fetchPrices() {
  setStatus("股價更新中…");
  const map = {};
  try {
    const res = await fetch("/api/prices", { cache:"no-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data)) throw new Error("非陣列");
    data.forEach(item => { const q=normalizeQuote(item); if(q&&!map[q.code]) map[q.code]=q; });
    console.log(`/api/prices: ${Object.keys(map).length} 筆`);
  } catch(err) {
    console.warn("/api/prices 失敗:", err.message);
    setStatus("⚠️ 股價抓取失敗");
    return {};
  }
  const total = Object.keys(map).length;
  if (!total) { setStatus("⚠️ 今日尚無交易資料"); return {}; }
  setStatus(`股價已更新 ${new Date().toLocaleTimeString("zh-TW",{hour:"numeric",minute:"2-digit"})}（收盤價）— 共 ${total} 檔`);
  return map;
}

async function updatePricesInDB(ctx) {
  const db = getDb(ctx);
  const stocks = await idb.all(db, "stocks");
  await Promise.all(stocks.map(async s => {
    if (s.code && priceMap[s.code]) {
      s.price = priceMap[s.code].price; s.priceAt = Date.now();
      await idb.put(db, "stocks", s);
    }
  }));
}

async function doRefresh() {
  priceMap = await fetchPrices();
  await updatePricesInDB("stocks");
  await updatePricesInDB("pledge");
  renderStockPage("stocks");
  renderStockPage("pledge");
}

/* ── 自動完成 ───────────────────────────────────────────────── */
let addCtx = "stocks";

$("asCode").addEventListener("input", () => {
  const q = $("asCode").value.trim();
  if (!q || !Object.keys(priceMap).length) { $("asSuggest").style.display="none"; return; }
  const matches = Object.values(priceMap)
    .filter(p => p.code.startsWith(q)||(p.name&&p.name.includes(q))).slice(0,8);
  if (!matches.length) { $("asSuggest").style.display="none"; return; }
  $("asSuggest").innerHTML = matches.map(m =>
    `<div class="suggest-item" data-code="${m.code}" data-name="${m.name}" data-price="${m.price}">
       <span>${m.code} ${m.name}</span><span class="suggest-price">${m.price}</span>
     </div>`).join("");
  $("asSuggest").style.display = "block";
});
$("asSuggest").addEventListener("click", e => {
  const item = e.target.closest(".suggest-item");
  if (!item) return;
  $("asCode").value = item.dataset.code;
  $("asName").value = item.dataset.name;
  $("asSuggest").style.display = "none";
});
document.addEventListener("click", e => {
  if (!e.target.closest(".autocomplete-wrap")) $("asSuggest").style.display = "none";
});

/* ── 股票/質押頁渲染（共用）────────────────────────────────── */
const expanded = { stocks: null, pledge: null };

async function renderStockPage(ctx) {
  const db = getDb(ctx);
  if (!db) return;
  const stocks    = await idb.all(db, "stocks");
  const rowsEl    = $(`${ctx}-rows`);
  const summaryEl = $(`${ctx}-summary`);
  let html = "", totalValue = 0, totalCost = 0;

  if (!stocks.length) {
    html = '<div class="empty-tip">尚未新增任何股票<br>點右上角「＋」新增</div>';
    summaryEl.classList.add("hidden");
  } else {
    stocks.forEach(s => {
      const cv=s.qty*s.price, pl=cv-s.totalCost;
      totalValue+=cv; totalCost+=s.totalCost;
      const isOpen = expanded[ctx]===s.id;
      html += `
        <div class="stock-item" id="${ctx}-item-${s.id}">
          <div class="stock-row" onclick="toggleDetail(${s.id},'${ctx}')">
            <div class="stock-name-col">
              <span class="s-name">${s.name||s.code}</span>
              <span class="s-code">${s.code}</span>
            </div>
            <span class="col-r">${fmtQty(s.qty)}</span>
            <span class="col-r ${pc(pl)}">${fmtPL(pl)}</span>
            <span class="col-chev ${isOpen?"open":""}">›</span>
          </div>
          <div class="detail-panel ${isOpen?"":"hidden"}" id="${ctx}-panel-${s.id}">
            ${isOpen ? buildDetailHTML(s, ctx) : ""}
          </div>
        </div>`;
    });
    const pl=totalValue-totalCost, rate=totalCost>0?(pl/totalCost)*100:NaN;
    $(`${ctx}-totalPL`).textContent = fmtPL(pl);
    $(`${ctx}-totalPL`).className   = "sum-val "+pc(pl);
    $(`${ctx}-totalRate`).textContent = fmtRate(rate);
    $(`${ctx}-totalRate`).className   = "sum-val "+pc(pl);
    $(`${ctx}-totalValue`).textContent = fmtAmount(totalValue);
    $(`${ctx}-totalCost`).textContent  = fmtAmount(totalCost);
    summaryEl.classList.remove("hidden");
  }
  rowsEl.innerHTML = html;
  if (expanded[ctx]!=null) loadTxIntoPanel(expanded[ctx], ctx);
}

function buildDetailHTML(s, ctx) {
  const cv=s.qty*s.price, pl=cv-s.totalCost;
  const avg=s.qty>0?s.totalCost/s.qty:0;
  const rate=s.totalCost>0?(pl/s.totalCost)*100:NaN;
  const cls=pc(pl);
  return `
    <div class="metrics-grid">
      <div class="metric"><div class="m-label">成交均價</div><div class="m-val">${fmtPrice(avg)}</div></div>
      <div class="metric"><div class="m-label">現值</div><div class="m-val">${fmtAmount(cv)}</div></div>
      <div class="metric"><div class="m-label">市價</div><div class="m-val">${fmtPrice(s.price)}</div></div>
      <div class="metric"><div class="m-label">預估損益</div><div class="m-val ${cls}">${fmtPL(pl)}</div></div>
      <div class="metric"><div class="m-label">付出成本</div><div class="m-val">${fmtAmount(s.totalCost)}</div></div>
      <div class="metric"><div class="m-label">報酬率</div><div class="m-val ${cls}">${fmtRate(rate)}</div></div>
    </div>
    <div class="detail-actions">
      <button class="buy-btn"  onclick="openTrade('buy','${ctx}',${s.id})">買入</button>
      <button class="sell-btn" onclick="openTrade('sell','${ctx}',${s.id})">賣出</button>
      <button class="del-btn"  onclick="deleteStock('${ctx}',${s.id})">刪除</button>
    </div>
    <div class="tx-section">
      <div class="tx-title">交易紀錄</div>
      <div id="${ctx}-tx-${s.id}"><span class="loading-tip">載入中…</span></div>
    </div>`;
}

async function loadTxIntoPanel(stockId, ctx) {
  const db = getDb(ctx);
  const el = $(`${ctx}-tx-${stockId}`);
  if (!el) return;
  const txs = await idb.idx(db, "transactions", "stockId", stockId);
  txs.sort((a,b)=>b.timestamp-a.timestamp);
  const lbl = { init:"初次建立", buy:"買入", sell:"賣出" };
  el.innerHTML = txs.map(t => `
    <div class="tx-row">
      <div class="tx-main">
        <span class="tx-type ${t.type==="sell"?"neg":"pos"}">${lbl[t.type]||t.type}</span>
        <span class="tx-qty ${t.type==="sell"?"neg":"pos"}">${t.type==="sell"?"−":"+"}${fmtQty(t.qty)} 股</span>
        <span class="tx-amt">${fmtAmount(t.amount)}</span>
        <span class="tx-actions">
          <button class="tx-edit-btn" onclick="editTx(${t.id},'${ctx}')">改</button>
          <button class="tx-del-btn"  onclick="delTx(${t.id},'${ctx}',${stockId})">✕</button>
        </span>
      </div>
      <div class="tx-date">${fmtDate(t.timestamp)}</div>
    </div>`).join("") || '<div class="empty-tip">尚無交易紀錄</div>';
}

async function toggleDetail(id, ctx) {
  const panel = $(`${ctx}-panel-${id}`);
  const chev  = $(`${ctx}-item-${id}`)?.querySelector(".col-chev");
  if (expanded[ctx]===id) {
    panel.classList.add("hidden"); chev?.classList.remove("open");
    expanded[ctx]=null; return;
  }
  if (expanded[ctx]!=null) {
    $(`${ctx}-panel-${expanded[ctx]}`)?.classList.add("hidden");
    $(`${ctx}-item-${expanded[ctx]}`)?.querySelector(".col-chev")?.classList.remove("open");
  }
  expanded[ctx]=id; chev?.classList.add("open");
  const s = await idb.get(getDb(ctx), "stocks", id);
  if (!s) return;
  panel.innerHTML = buildDetailHTML(s, ctx);
  panel.classList.remove("hidden");
  await loadTxIntoPanel(id, ctx);
}

/* ── 新增股票 ───────────────────────────────────────────────── */
function openAddStock(ctx) {
  addCtx = ctx;
  $("addStock-title").textContent = ctx==="pledge" ? "新增質押股票" : "新增股票";
  ["asCode","asName","asQty","asCost"].forEach(id=>$(id).value="");
  $("asSuggest").style.display="none";
  openModal("modal-addStock");
}

async function submitAddStock() {
  const code = $("asCode").value.trim().toUpperCase();
  const name = $("asName").value.trim() || code;
  const qty  = parseQty($("asQty").value);
  const cost = Number($("asCost").value);
  if (!code)             { alert("請輸入股票代號"); return; }
  if (!qty || qty<=0)    { alert("請輸入正確股數"); return; }
  if (!cost || cost<=0)  { alert("請輸入付出成本"); return; }
  const price = priceMap[code]?.price ?? (cost/qty);
  const db = getDb(addCtx);
  const sid = await idb.add(db,"stocks",{ code,name,qty,totalCost:cost,price,priceAt:Date.now() });
  await idb.add(db,"transactions",{ stockId:sid,type:"init",qty,amount:cost,timestamp:Date.now() });
  closeModal("modal-addStock");
  renderStockPage(addCtx);
}

/* ── 買入/賣出 ──────────────────────────────────────────────── */
let tradeCtx=null, tradeStockId=null, tradeType=null;

async function openTrade(type, ctx, stockId) {
  tradeCtx=ctx; tradeStockId=stockId; tradeType=type;
  $("trade-title").textContent = type==="buy"?"買入":"賣出";
  if (type==="buy") {
    $("trade-fields").innerHTML=`
      <input id="tQty" type="text" inputmode="decimal" placeholder="買入股數">
      <input id="tAmt" type="number" inputmode="decimal" placeholder="花費金額（含手續費，元）">`;
  } else {
    const s = await idb.get(getDb(ctx),"stocks",stockId);
    const avg = s&&s.qty>0 ? (s.totalCost/s.qty).toFixed(2) : 0;
    $("trade-fields").innerHTML=`
      <input id="tQty" type="text" inputmode="decimal" placeholder="賣出股數">
      <p class="trade-hint">目前均價 ${avg}，賣後成本等比例減少</p>`;
  }
  openModal("modal-trade");
  setTimeout(()=>bindQtyFormat($("tQty")),0);
}

async function submitTrade() {
  const qty = parseQty($("tQty")?.value??"");
  if (!qty||qty<=0) { alert("請輸入正確股數"); return; }
  const db = getDb(tradeCtx);
  const s  = await idb.get(db,"stocks",tradeStockId);
  if (!s) return;
  if (tradeType==="buy") {
    const amt = Number($("tAmt")?.value);
    if (!amt||amt<=0) { alert("請輸入花費金額"); return; }
    s.qty+=qty; s.totalCost+=amt;
    await idb.put(db,"stocks",s);
    await idb.add(db,"transactions",{stockId:s.id,type:"buy",qty,amount:amt,timestamp:Date.now()});
  } else {
    if (qty>s.qty) { alert(`持有 ${fmtQty(s.qty)} 股，無法賣出 ${fmtQty(qty)} 股`); return; }
    const costCut=(s.totalCost/s.qty)*qty;
    s.qty-=qty; s.totalCost-=costCut;
    await idb.add(db,"transactions",{stockId:s.id,type:"sell",qty,amount:costCut,timestamp:Date.now()});
    if (s.qty<=0) {
      await idb.del(db,"stocks",s.id);
      closeModal("modal-trade"); expanded[tradeCtx]=null;
      renderStockPage(tradeCtx); return;
    }
    await idb.put(db,"stocks",s);
  }
  closeModal("modal-trade");
  const panel=$(`${tradeCtx}-panel-${s.id}`);
  if (panel&&!panel.classList.contains("hidden")) {
    const fresh=await idb.get(db,"stocks",s.id);
    if (fresh) { panel.innerHTML=buildDetailHTML(fresh,tradeCtx); await loadTxIntoPanel(s.id,tradeCtx); }
  }
  renderStockPage(tradeCtx);
}

async function deleteStock(ctx, id) {
  const s = await idb.get(getDb(ctx),"stocks",id);
  if (!s||!confirm(`確定刪除「${s.name}」？`)) return;
  await idb.del(getDb(ctx),"stocks",id);
  await idb.delIdx(getDb(ctx),"transactions","stockId",id);
  expanded[ctx]=null;
  renderStockPage(ctx);
}

/* ── 交易紀錄 編輯/刪除 ─────────────────────────────────────── */
let editTxState = null;

async function editTx(txId, ctx) {
  const tx = await idb.get(getDb(ctx),"transactions",txId);
  if (!tx) return;
  editTxState = { txId, ctx, stockId:tx.stockId, type:tx.type };
  const lbl = { init:"初次建立", buy:"買入", sell:"賣出" };
  $("editTx-title").textContent = "修改 — "+(lbl[tx.type]||tx.type);
  $("etQty").value = fmtQty(tx.qty);
  $("etAmt").value = Math.round(tx.amount);
  $("etHint").textContent = tx.type==="sell" ? "賣出金額 = 股數 × 當時均價" : "花費金額（含手續費）";
  openModal("modal-editTx");
}

async function submitEditTx() {
  if (!editTxState) return;
  const {txId,ctx,stockId} = editTxState;
  const newQty=parseQty($("etQty").value), newAmt=Number($("etAmt").value);
  if (!newQty||newQty<=0)       { alert("請輸入正確股數"); return; }
  if (isNaN(newAmt)||newAmt<0)  { alert("請輸入正確金額"); return; }
  const db=getDb(ctx);
  const tx=await idb.get(db,"transactions",txId);
  const s =await idb.get(db,"stocks",stockId);
  if (!tx||!s) return;
  if (tx.type==="buy"||tx.type==="init") { s.qty-=tx.qty; s.totalCost-=tx.amount; }
  else if (tx.type==="sell")             { s.qty+=tx.qty; s.totalCost+=tx.amount; }
  if (tx.type==="buy"||tx.type==="init") { s.qty+=newQty; s.totalCost+=newAmt; }
  else if (tx.type==="sell")             { s.qty-=newQty; s.totalCost-=newAmt; }
  tx.qty=newQty; tx.amount=newAmt;
  closeModal("modal-editTx"); editTxState=null;
  if (s.qty<=0) {
    await idb.del(db,"stocks",stockId); await idb.del(db,"transactions",txId);
    expanded[ctx]=null; renderStockPage(ctx); return;
  }
  await idb.put(db,"stocks",s); await idb.put(db,"transactions",tx);
  const panel=$(`${ctx}-panel-${stockId}`);
  if (panel&&!panel.classList.contains("hidden")) {
    const fresh=await idb.get(db,"stocks",stockId);
    if (fresh) { panel.innerHTML=buildDetailHTML(fresh,ctx); await loadTxIntoPanel(stockId,ctx); }
  }
  renderStockPage(ctx);
}

async function delTx(txId, ctx, stockId) {
  if (!confirm("確定刪除這筆紀錄？")) return;
  const db=getDb(ctx);
  const tx=await idb.get(db,"transactions",txId);
  const s =await idb.get(db,"stocks",stockId);
  if (!tx||!s) return;
  if (tx.type==="buy"||tx.type==="init") { s.qty-=tx.qty; s.totalCost-=tx.amount; }
  else if (tx.type==="sell")             { s.qty+=tx.qty; s.totalCost+=tx.amount; }
  await idb.del(db,"transactions",txId);
  if (s.qty<=0) {
    await idb.del(db,"stocks",stockId); expanded[ctx]=null; renderStockPage(ctx); return;
  }
  await idb.put(db,"stocks",s);
  const panel=$(`${ctx}-panel-${stockId}`);
  if (panel&&!panel.classList.contains("hidden")) {
    const fresh=await idb.get(db,"stocks",stockId);
    if (fresh) { panel.innerHTML=buildDetailHTML(fresh,ctx); await loadTxIntoPanel(stockId,ctx); }
  }
  renderStockPage(ctx);
}

/* ── 啟動 ───────────────────────────────────────────────────── */
(async () => {
  if ("serviceWorker" in navigator)
    navigator.serviceWorker.register("./sw.js").catch(e=>console.warn("SW:",e));

  await dbsReady;
  bindQtyFormat($("asQty"));
  bindQtyFormat($("etQty"));

  // 預設顯示股票頁
  switchTab("stocks");

  // 抓股價，更新兩個 DB
  priceMap = await fetchPrices();
  await updatePricesInDB("stocks");
  await updatePricesInDB("pledge");
  renderStockPage("stocks");
  renderStockPage("pledge");
})();
