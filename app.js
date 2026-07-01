"use strict";
/* ============================================================
   app.js — 股票 + 質押 + 餘額（收入/費用/轉帳）+ Tab
   ============================================================ */

/* ── 格式化 ─────────────────────────────────────────────────── */
const $ = id => document.getElementById(id);

function fmtPrice(n) {
  return (Number(n)||0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g,",");
}
function fmtAmount(n) {
  return Math.round(Math.abs(Number(n)||0)).toLocaleString("zh-TW");
}
function fmtPL(n) {
  const v = Math.round(Number(n)||0);
  return v < 0 ? `(${Math.abs(v).toLocaleString("zh-TW")})` : v.toLocaleString("zh-TW");
}
function fmtMoney(n) {               // 帶符號：正=$X，負=($X)
  const v = Math.round(Number(n)||0);
  return v < 0
    ? `($${Math.abs(v).toLocaleString("zh-TW")})`
    : `$${v.toLocaleString("zh-TW")}`;
}
function fmtQty(n)   { return Number(n).toLocaleString("zh-TW"); }
function parseQty(s) { return Number(String(s).replace(/,/g,""))||0; }
function fmtRate(r)  {
  const v=Number(r);
  return isFinite(v)?(v>=0?"+":"")+v.toFixed(2)+"%":"—";
}
function fmtDate(ts) {
  return new Date(ts).toLocaleString("zh-TW",
    {year:"numeric",month:"numeric",day:"numeric",hour:"numeric",minute:"2-digit"});
}
function pc(n) { return Number(n)>0?"pos":Number(n)<0?"neg":""; }
function bindQtyFormat(el) {
  if (!el||el.dataset.qtyBound) return;
  el.dataset.qtyBound="1";
  el.addEventListener("blur",  ()=>{ const v=parseQty(el.value); if(v>0) el.value=v.toLocaleString("zh-TW"); });
  el.addEventListener("focus", ()=>{ el.value=String(parseQty(el.value)||""); });
}

/* ── Tab ────────────────────────────────────────────────────── */
let activeStockSubTab = "all";

function switchStockSubTab(subtab) {
  activeStockSubTab = subtab;

  ["all", "stocks", "pledge"].forEach(t => {
    $(`stock-subtab-${t}`)?.classList.toggle("active", t === subtab);
    $(`stock-subpage-${t}`)?.classList.toggle("hidden", t !== subtab);
  });

  const showEdit = subtab === "stocks" || subtab === "pledge";

  $("stocks-edit-btn").style.display = showEdit ? "" : "none";
  $("stocks-add-btn").style.display =
    showEdit && stockEditMode[subtab] ? "" : "none";

  if (subtab === "all") renderTotalStockPage();
  if (subtab === "stocks") renderStockPage("stocks");
  if (subtab === "pledge") renderStockPage("pledge");
}

let currentTab = "stocks";
function switchTab(tab) {
  document.querySelectorAll(".page").forEach(p=>p.classList.add("hidden"));
  document.querySelectorAll(".tab").forEach(t=>t.classList.remove("active"));

  $(`page-${tab}`).classList.remove("hidden");

  const tabBtn = document.querySelector(`.tab[data-tab="${tab}"]`);
  if (tabBtn) tabBtn.classList.add("active");

  currentTab = tab;

  if (tab==="stocks") switchStockSubTab(activeStockSubTab || "all");
  if (tab==="pledge")  renderStockPage("pledge");
  if (tab==="balance") renderBalancePage();
  if (tab==="goals") renderGoalPage();
  if (tab==="settings") renderSettingsPage();
}

/* ── Modal / Overlay ────────────────────────────────────────── */
function openModal(id)  { $(id).classList.remove("hidden"); }
function closeModal(id) { $(id).classList.add("hidden"); }
function openOverlay(id)  {
  $(id).classList.remove("hidden");
  document.querySelector(".tab-bar").style.display="none";
}
function closeOverlay(id) {
  $(id).classList.add("hidden");
  document.querySelector(".tab-bar").style.display="";
}
document.addEventListener("DOMContentLoaded",()=>{
  document.querySelectorAll(".modal-overlay").forEach(el=>
    el.addEventListener("click",e=>{ if(e.target===el) el.classList.add("hidden"); })
  );
});

/* ── IndexedDB helpers ──────────────────────────────────────── */
function openDB(name, upgrade) {
  return new Promise((res,rej)=>{
    const req=indexedDB.open(name,1);
    req.onupgradeneeded=e=>upgrade(e.target.result);
    req.onsuccess=e=>res(e.target.result);
    req.onerror=e=>rej(e.target.error);
  });
}
const idb={
  get:(db,s,k)=>new Promise((r,j)=>{const q=db.transaction(s).objectStore(s).get(k);q.onsuccess=()=>r(q.result);q.onerror=()=>j(q.error);}),
  all:(db,s)=>new Promise((r,j)=>{const q=db.transaction(s).objectStore(s).getAll();q.onsuccess=()=>r(q.result);q.onerror=()=>j(q.error);}),
  put:(db,s,rec)=>new Promise((r,j)=>{const q=db.transaction(s,"readwrite").objectStore(s).put(rec);q.onsuccess=()=>r(q.result);q.onerror=()=>j(q.error);}),
  add:(db,s,rec)=>new Promise((r,j)=>{const q=db.transaction(s,"readwrite").objectStore(s).add(rec);q.onsuccess=()=>r(q.result);q.onerror=()=>j(q.error);}),
  del:(db,s,k)=>new Promise((r,j)=>{const q=db.transaction(s,"readwrite").objectStore(s).delete(k);q.onsuccess=()=>r();q.onerror=()=>j(q.error);}),
  idx:(db,s,i,v)=>new Promise((r,j)=>{const q=db.transaction(s).objectStore(s).index(i).getAll(v);q.onsuccess=()=>r(q.result);q.onerror=()=>j(q.error);}),
  delIdx:(db,s,i,v)=>new Promise((r,j)=>{
    const tx=db.transaction(s,"readwrite");
    const q=tx.objectStore(s).index(i).openCursor(IDBKeyRange.only(v));
    q.onsuccess=e=>{const c=e.target.result;if(c){c.delete();c.continue();}};
    tx.oncomplete=()=>r(); tx.onerror=()=>j(tx.error);
  }),
};

/* ════════════════════════════════════════════════════════════
   STOCK DB（股票 & 質押）
════════════════════════════════════════════════════════════ */
function upgradeStockDB(db) {
  if (!db.objectStoreNames.contains("stocks"))
    db.createObjectStore("stocks",{keyPath:"id",autoIncrement:true});
  if (!db.objectStoreNames.contains("transactions")) {
    const ts=db.createObjectStore("transactions",{keyPath:"id",autoIncrement:true});
    ts.createIndex("stockId","stockId",{unique:false});
  }
}
let stockDb, pledgeDb;
const dbsReady = Promise.all([
  openDB("stockAppDB",  upgradeStockDB).then(d=>{stockDb=d;}),
  openDB("pledgeAppDB", upgradeStockDB).then(d=>{pledgeDb=d;}),
]);
const getDb = ctx => ctx==="pledge" ? pledgeDb : stockDb;

async function getStockTotal(ctx) {   // 供餘額頁讀取市值
  const db=getDb(ctx);
  if (!db) return 0;
  const stocks=await idb.all(db,"stocks");
  return stocks.reduce((s,st)=>s+st.qty*st.price,0);
}
async function getLoanTotal() {
  await financeReady;

  const accounts = await idb.all(financeDb, "accounts");

  return accounts
    .filter(a => a.type === "loan")
    .reduce((sum, a) => sum + Math.abs(Number(a.balance) || 0), 0);
}

/* ── 股價 ───────────────────────────────────────────────────── */
let priceMap = {};
function setStatus(t) {
  if ($("priceStatusText")) $("priceStatusText").textContent = t;
  if ($("pledgeStatusText")) $("pledgeStatusText").textContent = t;
}

function normalizeQuote(item) {
  if (!item||typeof item!=="object") return null;
  const keys=Object.keys(item);
  const codeKey  =keys.find(k=>k==="Code"||/code/i.test(k)||k.includes("代號"));
  const nameKey  =keys.find(k=>k==="Name"||k==="StockName"||/name/i.test(k)||k.includes("名稱"));
  const closeKey =keys.find(k=>k==="ClosingPrice"||k==="Close"||/^closingprice$/i.test(k)||/close/i.test(k)||k.includes("收盤"));
  if (!codeKey||!closeKey) return null;
  const code=String(item[codeKey]).trim();
  const name=nameKey?String(item[nameKey]).trim():code;
  const price=parseFloat(String(item[closeKey]).replace(/,/g,""));
  if (!code||!/^\w{1,10}$/.test(code)||isNaN(price)||price<=0) return null;
  return {code,name,price};
}

async function fetchPrices() {
  setStatus("股價更新中…");
  const map={};
  try {
    const res=await fetch("/api/prices",{cache:"no-cache"});
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data=await res.json();
    data.forEach(item=>{const q=normalizeQuote(item);if(q&&!map[q.code])map[q.code]=q;});
  } catch(err) { setStatus("⚠️ 股價抓取失敗"); return {}; }
  const total=Object.keys(map).length;
  if (!total) { setStatus("⚠️ 今日尚無交易資料"); return {}; }
  setStatus(`股價已更新 ${new Date().toLocaleTimeString("zh-TW",{hour:"numeric",minute:"2-digit"})}（收盤價）— 共 ${total} 檔`);
  return map;
}

async function updatePricesInDB(ctx) {
  const db=getDb(ctx);
  const stocks=await idb.all(db,"stocks");
  await Promise.all(stocks.map(async s=>{
    if(s.code&&priceMap[s.code]){s.price=priceMap[s.code].price;s.priceAt=Date.now();await idb.put(db,"stocks",s);}
  }));
}

async function doRefresh() {
  priceMap=await fetchPrices();
  await updatePricesInDB("stocks");
  await updatePricesInDB("pledge");
  renderStockPage("stocks");
  renderStockPage("pledge");
  if (currentTab==="balance") renderBalancePage();
}

/* ── 自動完成 ───────────────────────────────────────────────── */
let addCtx="stocks";
$("asCode").addEventListener("input",()=>{
  const q=$("asCode").value.trim();
  if(!q||!Object.keys(priceMap).length){$("asSuggest").style.display="none";return;}
  const m=Object.values(priceMap).filter(p=>p.code.startsWith(q)||(p.name&&p.name.includes(q))).slice(0,8);
  if(!m.length){$("asSuggest").style.display="none";return;}
  $("asSuggest").innerHTML=m.map(p=>`<div class="suggest-item" data-code="${p.code}" data-name="${p.name}" data-price="${p.price}"><span>${p.code} ${p.name}</span><span class="suggest-price">${p.price}</span></div>`).join("");
  $("asSuggest").style.display="block";
});
$("asSuggest").addEventListener("click",e=>{
  const item=e.target.closest(".suggest-item");
  if(!item) return;
  $("asCode").value=item.dataset.code;$("asName").value=item.dataset.name;$("asSuggest").style.display="none";
});
document.addEventListener("click",e=>{if(!e.target.closest(".autocomplete-wrap"))$("asSuggest").style.display="none";});

/* ── 股票/質押共用渲染 ──────────────────────────────────────── */
const expanded={stocks:null,pledge:null};
const stockEditMode = {
  stocks: false,
  pledge: false
};

function toggleStockEdit(ctx) {
  stockEditMode[ctx] = !stockEditMode[ctx];

  $("stocks-edit-btn").textContent = stockEditMode[ctx] ? "完成" : "編輯";
  $("stocks-add-btn").style.display = stockEditMode[ctx] ? "" : "none";

  if (stockEditMode[ctx]) {
    expanded[ctx] = null;
  }

  renderStockPage(ctx);
}

async function renderStockPage(ctx) {
  const db = getDb(ctx);
  if (!db) return;

  const stocks = await idb.all(db, "stocks");
  stocks.sort((a, b) => (a.sortOrder ?? a.id) - (b.sortOrder ?? b.id));

  const rowsEl = $(`${ctx}-rows`);
  const sumEl = $(`${ctx}-summary`);

  let html = "";
  let tv = 0;
  let tc = 0;

  if (!stocks.length) {
    html = '<div class="empty-tip">尚未新增任何股票<br>點右上角「＋」新增</div>';

    if (ctx !== "pledge") {
      sumEl.classList.add("hidden");
    }
  } else {
    stocks.forEach(s => {
      const cv = s.qty * s.price;
      const pl = cv - s.totalCost;

      tv += cv;
      tc += s.totalCost;

      const isOpen = expanded[ctx] === s.id;

      if (stockEditMode[ctx]) {
        html += `<div class="stock-item stock-edit-item" id="${ctx}-item-${s.id}" data-id="${s.id}">
          <div class="stock-row stock-edit-row">
            <button class="acc-delete-btn" onclick="event.stopPropagation(); deleteStock('${ctx}',${s.id})">✕</button>

            <div class="stock-name-col">
              <span class="s-name">${s.name || s.code}</span>
              <span class="s-code">${s.code}</span>
            </div>

            <span class="col-r">${fmtQty(s.qty)}</span>
            <span class="col-r ${pc(pl)}">${fmtPL(pl)}</span>
            <button class="drag-handle" type="button">≡</button>
          </div>
        </div>`;
      } else {
        html += `<div class="stock-item" id="${ctx}-item-${s.id}">
          <div class="stock-row" onclick="toggleDetail(${s.id},'${ctx}')">
            <div class="stock-name-col">
              <span class="s-name">${s.name || s.code}</span>
              <span class="s-code">${s.code}</span>
            </div>
            <span class="col-r">${fmtQty(s.qty)}</span>
            <span class="col-r ${pc(pl)}">${fmtPL(pl)}</span>
            <span class="col-chev ${isOpen ? "open" : ""}">›</span>
          </div>
          <div class="detail-panel ${isOpen ? "" : "hidden"}" id="${ctx}-panel-${s.id}">
            ${isOpen ? buildDetailHTML(s, ctx) : ""}
          </div>
        </div>`;
      }
    });

    const pl = tv - tc;
    const rate = tc > 0 ? (pl / tc) * 100 : NaN;

    $(`${ctx}-totalPL`).textContent = fmtPL(pl);
    $(`${ctx}-totalPL`).className = "sum-val " + pc(pl);

    $(`${ctx}-totalRate`).textContent = fmtRate(rate);
    $(`${ctx}-totalRate`).className = "sum-val " + pc(pl);

    $(`${ctx}-totalValue`).textContent = fmtAmount(tv);
    $(`${ctx}-totalCost`).textContent = fmtAmount(tc);

    sumEl.classList.remove("hidden");
  }

  rowsEl.innerHTML = html;

  if (ctx === "pledge") {
    const loanTotal = await getLoanTotal();

    if (loanTotal > 0 || tc > 0) {
      sumEl.classList.remove("hidden");

      $(`${ctx}-totalPL`).textContent = fmtPL(tv - tc);
      $(`${ctx}-totalPL`).className = "sum-val " + pc(tv - tc);

      $(`${ctx}-totalRate`).textContent = fmtRate(tc > 0 ? ((tv - tc) / tc) * 100 : NaN);
      $(`${ctx}-totalRate`).className = "sum-val " + pc(tv - tc);

      $(`${ctx}-totalValue`).textContent = fmtAmount(tv);
      $(`${ctx}-totalCost`).textContent = fmtAmount(tc);

      await renderPledgeLoanSummary(tc);
    } else {
      sumEl.classList.add("hidden");
    }
  }

  if (expanded[ctx] != null) {
    loadTxIntoPanel(expanded[ctx], ctx);
  }

  if (stockEditMode[ctx]) {
    bindStockDragEvents(ctx);
  }
}
async function renderPledgeLoanSummary(pledgeCost) {
  const loanTotal = await getLoanTotal();

  $("pledge-loanAmount").textContent = fmtAmount(loanTotal);

  const diff = loanTotal - pledgeCost;

  if (diff > 0) {
    $("pledge-loanStatusLabel").textContent = "未投入借款";
    $("pledge-loanStatusValue").textContent = fmtAmount(diff);
    $("pledge-loanStatusValue").className = "sum-val";
  } else if (diff < 0) {
    $("pledge-loanStatusLabel").textContent = "自有資金投入";
    $("pledge-loanStatusValue").textContent = fmtAmount(Math.abs(diff));
    $("pledge-loanStatusValue").className = "sum-val pos";
  } else {
    $("pledge-loanStatusLabel").textContent = "投入狀態";
    $("pledge-loanStatusValue").textContent = "0";
    $("pledge-loanStatusValue").className = "sum-val";
  }
}

let draggingStockRow = null;

function bindStockDragEvents(ctx) {
  document.querySelectorAll(`#${ctx}-rows .stock-edit-row .drag-handle`).forEach(handle => {
    handle.addEventListener("pointerdown", e => {
      const row = handle.closest(".stock-edit-item");
      if (!row) return;

      draggingStockRow = row;
      row.classList.add("dragging");

      handle.setPointerCapture(e.pointerId);
      e.preventDefault();
    });

    handle.addEventListener("pointermove", e => {
      if (!draggingStockRow) return;

      e.preventDefault();

      const rows = [...document.querySelectorAll(`#${ctx}-rows .stock-edit-item:not(.dragging)`)];

      const target = rows.find(row => {
        const box = row.getBoundingClientRect();
        return e.clientY >= box.top && e.clientY <= box.bottom;
      });

      if (!target) return;

      const box = target.getBoundingClientRect();
      const after = e.clientY > box.top + box.height / 2;

      if (after) {
        target.after(draggingStockRow);
      } else {
        target.before(draggingStockRow);
      }
    });

    handle.addEventListener("pointerup", async () => {
      if (!draggingStockRow) return;

      draggingStockRow.classList.remove("dragging");
      draggingStockRow = null;

      await saveStockSortOrder(ctx);
    });

    handle.addEventListener("pointercancel", async () => {
      if (!draggingStockRow) return;

      draggingStockRow.classList.remove("dragging");
      draggingStockRow = null;

      await saveStockSortOrder(ctx);
    });
  });
}

async function saveStockSortOrder(ctx) {
  const db = getDb(ctx);
  const rows = [...document.querySelectorAll(`#${ctx}-rows .stock-edit-item`)];

  for (let i = 0; i < rows.length; i++) {
    const id = Number(rows[i].dataset.id);
    const stock = await idb.get(db, "stocks", id);

    if (stock) {
      stock.sortOrder = i + 1;
      await idb.put(db, "stocks", stock);
    }
  }

  renderStockPage(ctx);
}

function buildDetailHTML(s,ctx){
  const cv=s.qty*s.price,pl=cv-s.totalCost,avg=s.qty>0?s.totalCost/s.qty:0;
  const rate=s.totalCost>0?(pl/s.totalCost)*100:NaN,cls=pc(pl);
  return `<div class="metrics-grid">
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
  </div>
  <div class="tx-section"><div class="tx-title">交易紀錄</div>
    <div id="${ctx}-tx-${s.id}"><span class="loading-tip">載入中…</span></div>
  </div>`;
}

async function loadTxIntoPanel(id,ctx){
  const db=getDb(ctx),el=$(`${ctx}-tx-${id}`);
  if(!el) return;
  const txs=await idb.idx(db,"transactions","stockId",id);
  txs.sort((a,b)=>b.timestamp-a.timestamp);
  const lbl={init:"初次建立",buy:"買入",sell:"賣出"};
  el.innerHTML=txs.map(t=>`<div class="tx-row">
    <div class="tx-main">
      <span class="tx-type ${t.type==="sell"?"neg":"pos"}">${lbl[t.type]||t.type}</span>
      <span class="tx-qty ${t.type==="sell"?"neg":"pos"}">${t.type==="sell"?"−":"+"}${fmtQty(t.qty)} 股</span>
      <span class="tx-amt">${fmtAmount(t.amount)}</span>
      <span class="tx-actions">
        <button class="tx-edit-btn" onclick="editTx(${t.id},'${ctx}')">改</button>
        <button class="tx-del-btn"  onclick="delTx(${t.id},'${ctx}',${id})">✕</button>
      </span>
    </div>
    <div class="tx-date">${fmtDate(t.timestamp)}</div>
  </div>`).join("")||'<div class="empty-tip">尚無交易紀錄</div>';
}

async function toggleDetail(id,ctx){
  const panel=$(`${ctx}-panel-${id}`),chev=$(`${ctx}-item-${id}`)?.querySelector(".col-chev");
  if(expanded[ctx]===id){panel.classList.add("hidden");chev?.classList.remove("open");expanded[ctx]=null;return;}
  if(expanded[ctx]!=null){$(`${ctx}-panel-${expanded[ctx]}`)?.classList.add("hidden");$(`${ctx}-item-${expanded[ctx]}`)?.querySelector(".col-chev")?.classList.remove("open");}
  expanded[ctx]=id;chev?.classList.add("open");
  const s=await idb.get(getDb(ctx),"stocks",id);if(!s) return;
  panel.innerHTML=buildDetailHTML(s,ctx);panel.classList.remove("hidden");
  await loadTxIntoPanel(id,ctx);
}

/* ── 新增股票 ───────────────────────────────────────────────── */
function openAddStock(ctx){
  addCtx=ctx;$("addStock-title").textContent=ctx==="pledge"?"新增質押股票":"新增股票";
  ["asCode","asName","asQty","asCost"].forEach(id=>$(id).value="");
  $("asSuggest").style.display="none";openModal("modal-addStock");
}
async function submitAddStock(){
  const code=$("asCode").value.trim().toUpperCase(),name=$("asName").value.trim()||code;
  const qty=parseQty($("asQty").value),cost=Number($("asCost").value);
  if(!code){alert("請輸入股票代號");return;}
  if(!qty||qty<=0){alert("請輸入正確股數");return;}
  if(!cost||cost<=0){alert("請輸入付出成本");return;}
  const price=priceMap[code]?.price??(cost/qty);
  const db=getDb(addCtx);
  const sid=await idb.add(db,"stocks",{code,name,qty,totalCost:cost,price,priceAt:Date.now()});
  await idb.add(db,"transactions",{stockId:sid,type:"init",qty,amount:cost,timestamp:Date.now()});
  closeModal("modal-addStock");renderStockPage(addCtx);
}

/* ── 買入/賣出 ──────────────────────────────────────────────── */
let tradeCtx=null,tradeStockId=null,tradeType=null;
async function openTrade(type,ctx,stockId){
  tradeCtx=ctx;tradeStockId=stockId;tradeType=type;
  $("trade-title").textContent=type==="buy"?"買入":"賣出";
  if(type==="buy"){
    $("trade-fields").innerHTML=`<input id="tQty" type="text" inputmode="decimal" placeholder="買入股數"><input id="tAmt" type="number" inputmode="decimal" placeholder="花費金額（含手續費，元）">`;
  } else {
    const s=await idb.get(getDb(ctx),"stocks",stockId);
    const avg=s&&s.qty>0?(s.totalCost/s.qty).toFixed(2):0;
    $("trade-fields").innerHTML=`<input id="tQty" type="text" inputmode="decimal" placeholder="賣出股數"><p class="trade-hint">目前均價 ${avg}，賣後成本等比例減少</p>`;
  }
  openModal("modal-trade");setTimeout(()=>bindQtyFormat($("tQty")),0);
}
async function submitTrade(){
  const qty=parseQty($("tQty")?.value??"");
  if(!qty||qty<=0){alert("請輸入正確股數");return;}
  const db=getDb(tradeCtx),s=await idb.get(db,"stocks",tradeStockId);if(!s) return;
  if(tradeType==="buy"){
    const amt=Number($("tAmt")?.value);if(!amt||amt<=0){alert("請輸入花費金額");return;}
    s.qty+=qty;s.totalCost+=amt;await idb.put(db,"stocks",s);
    await idb.add(db,"transactions",{stockId:s.id,type:"buy",qty,amount:amt,timestamp:Date.now()});
  } else {
    if(qty>s.qty){alert(`持有 ${fmtQty(s.qty)} 股，無法賣出 ${fmtQty(qty)} 股`);return;}
    const cut=(s.totalCost/s.qty)*qty;s.qty-=qty;s.totalCost-=cut;
    await idb.add(db,"transactions",{stockId:s.id,type:"sell",qty,amount:cut,timestamp:Date.now()});
    if(s.qty<=0){await idb.del(db,"stocks",s.id);closeModal("modal-trade");expanded[tradeCtx]=null;renderStockPage(tradeCtx);return;}
    await idb.put(db,"stocks",s);
  }
  closeModal("modal-trade");
  const panel=$(`${tradeCtx}-panel-${s.id}`);
  if(panel&&!panel.classList.contains("hidden")){const f=await idb.get(db,"stocks",s.id);if(f){panel.innerHTML=buildDetailHTML(f,tradeCtx);await loadTxIntoPanel(s.id,tradeCtx);}}
  renderStockPage(tradeCtx);
}
async function deleteStock(ctx,id){
  const s=await idb.get(getDb(ctx),"stocks",id);if(!s||!confirm(`確定刪除「${s.name}」？`)) return;
  await idb.del(getDb(ctx),"stocks",id);await idb.delIdx(getDb(ctx),"transactions","stockId",id);
  expanded[ctx]=null;renderStockPage(ctx);
}

/* ── 股票交易紀錄 編輯/刪除 ────────────────────────────────── */
let editTxState=null;
async function editTx(txId,ctx){
  const tx=await idb.get(getDb(ctx),"transactions",txId);if(!tx) return;
  editTxState={txId,ctx,stockId:tx.stockId,type:tx.type};
  const lbl={init:"初次建立",buy:"買入",sell:"賣出"};
  $("editTx-title").textContent="修改 — "+(lbl[tx.type]||tx.type);
  $("etQty").value=fmtQty(tx.qty);$("etAmt").value=Math.round(tx.amount);
  $("etHint").textContent=tx.type==="sell"?"賣出金額 = 股數 × 當時均價":"花費金額（含手續費）";
  openModal("modal-editTx");
}
async function submitEditTx(){
  if(!editTxState) return;
  const {txId,ctx,stockId}=editTxState;
  const newQty=parseQty($("etQty").value),newAmt=Number($("etAmt").value);
  if(!newQty||newQty<=0){alert("請輸入正確股數");return;}
  if(isNaN(newAmt)||newAmt<0){alert("請輸入正確金額");return;}
  const db=getDb(ctx),tx=await idb.get(db,"transactions",txId),s=await idb.get(db,"stocks",stockId);
  if(!tx||!s) return;
  if(tx.type==="buy"||tx.type==="init"){s.qty-=tx.qty;s.totalCost-=tx.amount;}
  else if(tx.type==="sell"){s.qty+=tx.qty;s.totalCost+=tx.amount;}
  if(tx.type==="buy"||tx.type==="init"){s.qty+=newQty;s.totalCost+=newAmt;}
  else if(tx.type==="sell"){s.qty-=newQty;s.totalCost-=newAmt;}
  tx.qty=newQty;tx.amount=newAmt;closeModal("modal-editTx");editTxState=null;
  if(s.qty<=0){await idb.del(db,"stocks",stockId);await idb.del(db,"transactions",txId);expanded[ctx]=null;renderStockPage(ctx);return;}
  await idb.put(db,"stocks",s);await idb.put(db,"transactions",tx);
  const panel=$(`${ctx}-panel-${stockId}`);
  if(panel&&!panel.classList.contains("hidden")){const f=await idb.get(db,"stocks",stockId);if(f){panel.innerHTML=buildDetailHTML(f,ctx);await loadTxIntoPanel(stockId,ctx);}}
  renderStockPage(ctx);
}
async function delTx(txId,ctx,stockId){
  if(!confirm("確定刪除這筆紀錄？")) return;
  const db=getDb(ctx),tx=await idb.get(db,"transactions",txId),s=await idb.get(db,"stocks",stockId);
  if(!tx||!s) return;
  if(tx.type==="buy"||tx.type==="init"){s.qty-=tx.qty;s.totalCost-=tx.amount;}
  else if(tx.type==="sell"){s.qty+=tx.qty;s.totalCost+=tx.amount;}
  await idb.del(db,"transactions",txId);
  if(s.qty<=0){await idb.del(db,"stocks",stockId);expanded[ctx]=null;renderStockPage(ctx);return;}
  await idb.put(db,"stocks",s);
  const panel=$(`${ctx}-panel-${stockId}`);
  if(panel&&!panel.classList.contains("hidden")){const f=await idb.get(db,"stocks",stockId);if(f){panel.innerHTML=buildDetailHTML(f,ctx);await loadTxIntoPanel(stockId,ctx);}}
  renderStockPage(ctx);
}

/* ════════════════════════════════════════════════════════════
   FINANCE DB（餘額頁）
   帳戶餘額帶符號：資產=正，負債=負
   淨資產 = 帳戶加總 + 股票市值 + 質押市值
════════════════════════════════════════════════════════════ */
let financeDb;
const financeReady = openDB("financeDB", db => {
  if (!db.objectStoreNames.contains("accounts"))
    db.createObjectStore("accounts", { keyPath:"id", autoIncrement:true });
  if (!db.objectStoreNames.contains("transactions")) {
    const ts = db.createObjectStore("transactions", { keyPath:"id", autoIncrement:true });
    ts.createIndex("accountId","accountId",{ unique:false });
  }
}).then(d => { financeDb = d; });

let goalDb;
const goalReady = openDB("goalDB", db => {
  if (!db.objectStoreNames.contains("goals"))
    db.createObjectStore("goals", { keyPath: "id", autoIncrement: true });
}).then(d => { goalDb = d; });

/* ── 共用輔助 ──────────────────────────────────────────────── */
function fmtMoney(n) {           // $X,XXX 或 ($X,XXX)
  const v = Math.round(Number(n) || 0);
  return v < 0
    ? `($${Math.abs(v).toLocaleString("zh-TW")})`
    : `$${v.toLocaleString("zh-TW")}`;
}
async function getStockTotal(ctx) {
  const db = getDb(ctx);
  if (!db) return 0;
  const stocks = await idb.all(db, "stocks");
  return stocks.reduce((s, st) => s + st.qty * st.price, 0);
}
function openOverlay(id)  { $(id).classList.remove("hidden"); }
function closeOverlay(id) { $(id).classList.add("hidden"); }

/* ── 餘額頁渲染 ──────────────────────────────────────────── */
async function renderBalancePage() {
  await financeReady;

  const accounts = await idb.all(financeDb, "accounts");
  accounts.sort((a, b) => (a.sortOrder ?? a.id) - (b.sortOrder ?? b.id));

  const stockVal  = await getStockTotal("stocks");
  const pledgeVal = await getStockTotal("pledge");

  const accSum = accounts.reduce((s, a) => s + a.balance, 0);
  const nw = accSum + stockVal + pledgeVal;

  $("nwValue").textContent = fmtMoney(nw);
  $("nwValue").className = "nw-value " + (nw < 0 ? "neg" : "");

  const groups = [
    { type: "asset", title: "資產" },
    { type: "liability", title: "負債" },
    { type: "loan", title: "借款" }
  ];

  let html = "";

  groups.forEach(g => {
    const list = accounts.filter(a => (a.type || "asset") === g.type);
    if (!list.length) return;

    const groupTotal = list.reduce((sum, a) => sum + Number(a.balance || 0), 0);

    html += `<div class="acc-group-title">
      <span>${g.title}</span>
      <span class="${groupTotal < 0 ? "neg" : ""}">${fmtMoney(groupTotal)}</span>
    </div>`;

    list.forEach(a => {
      if (balanceEditMode) {
        html += `<div class="acc-row edit-mode-row" data-id="${a.id}">
          <button class="acc-delete-btn" onclick="event.stopPropagation(); deleteAccountFromList(${a.id})">✕</button>

          <div class="acc-edit-main" onclick="event.stopPropagation(); openEditAccountBasic(${a.id})">
            <span class="acc-name">${a.name}</span>
            <span class="acc-bal ${a.balance < 0 ? "neg" : ""}">${fmtMoney(a.balance)}</span>
          </div>

          <button class="drag-handle" type="button">≡</button>
        </div>`;
      } else {
        html += `<div class="acc-row acc-row-stack" onclick="openAccountDetail(${a.id})">
          <div class="acc-name">${a.name}</div>
          <div class="acc-bal ${a.balance < 0 ? "neg" : ""}">${fmtMoney(a.balance)}</div>
        </div>`;
      }
    });
  });

  if (stockVal !== 0 || pledgeVal !== 0) {
    const stockGroupTotal = stockVal + pledgeVal;

    html += `<div class="acc-group-title">
      <span>股票</span>
      <span>${fmtMoney(stockGroupTotal)}</span>
    </div>`;

   if (stockVal !== 0) {
      html += `<div class="acc-row acc-row-stack readonly-row">
        <div class="acc-name">自有股票市值 <span class="ro-tag">自動</span></div>
        <div class="acc-bal">${fmtMoney(stockVal)}</div>
      </div>`;
    }

    if (pledgeVal !== 0) {
      html += `<div class="acc-row acc-row-stack readonly-row">
        <div class="acc-name">借款股票市值 <span class="ro-tag">自動</span></div>
        <div class="acc-bal">${fmtMoney(pledgeVal)}</div>
      </div>`;
    }
  }

  $("accountRows").innerHTML = html || '<div class="empty-tip">尚未新增帳戶<br>點右上角「＋」新增</div>';

  if (balanceEditMode) bindAccountDragEvents();
}

let totalStockExpanded = null;

async function renderTotalStockPage(e) {
  if (e) e.stopPropagation();

  const normalStocks = await idb.all(stockDb, "stocks");
  const pledgeStocks = await idb.all(pledgeDb, "stocks");

  const map = new Map();

  [...normalStocks, ...pledgeStocks].forEach(s => {
    const code = s.code;
    const price = priceMap[code]?.price ?? s.price ?? 0;

    if (!map.has(code)) {
      map.set(code, {
        code,
        name: s.name || code,
        qty: 0,
        totalCost: 0,
        price
      });
    }

    const row = map.get(code);
    row.qty += Number(s.qty) || 0;
    row.totalCost += Number(s.totalCost) || 0;
    row.price = price;
  });

  const rows = [...map.values()].sort((a, b) => a.code.localeCompare(b.code));

  let totalValue = 0;
  let totalCost = 0;
  let html = "";

  rows.forEach(s => {
    const cv = s.qty * s.price;
    const pl = cv - s.totalCost;
    const isOpen = totalStockExpanded === s.code;

    totalValue += cv;
    totalCost += s.totalCost;

    html += `<div class="stock-item" id="totalStock-item-${s.code}">
      <div class="stock-row" onclick="toggleTotalStockDetail('${s.code}')">
        <div class="stock-name-col">
          <span class="s-name">${s.name || s.code}</span>
          <span class="s-code">${s.code}</span>
        </div>
        <span class="col-r">${fmtQty(s.qty)}</span>
        <span class="col-r ${pc(pl)}">${fmtPL(pl)}</span>
        <span class="col-chev ${isOpen ? "open" : ""}">›</span>
      </div>
      <div class="detail-panel ${isOpen ? "" : "hidden"}" id="totalStock-panel-${s.code}">
        ${isOpen ? buildTotalStockDetailHTML(s) : ""}
      </div>
    </div>`;
  });

  const totalPL = totalValue - totalCost;
  const totalRate = totalCost > 0 ? (totalPL / totalCost) * 100 : NaN;

  $("totalStockRows").innerHTML =
    html || '<div class="empty-tip">尚無股票資料</div>';

  $("totalStockSummary").innerHTML = `
    <div class="summary-row">
      <span class="sum-label">總損益</span><span class="sum-val ${pc(totalPL)}">${fmtPL(totalPL)}</span>
      <span class="sep">|</span>
      <span class="sum-label">總報酬率</span><span class="sum-val ${pc(totalPL)}">${fmtRate(totalRate)}</span>
    </div>
    <div class="summary-row">
      <span class="sum-label">總現值</span><span class="sum-val">${fmtAmount(totalValue)}</span>
      <span class="sep">|</span>
      <span class="sum-label">總成本</span><span class="sum-val">${fmtAmount(totalCost)}</span>
    </div>
  `;

}

async function toggleTotalStockDetail(code) {
  if (totalStockExpanded === code) {
    $(`totalStock-panel-${code}`)?.classList.add("hidden");
    $(`totalStock-item-${code}`)?.querySelector(".col-chev")?.classList.remove("open");
    totalStockExpanded = null;
    return;
  }

  if (totalStockExpanded) {
    $(`totalStock-panel-${totalStockExpanded}`)?.classList.add("hidden");
    $(`totalStock-item-${totalStockExpanded}`)?.querySelector(".col-chev")?.classList.remove("open");
  }

  totalStockExpanded = code;
  renderTotalStockPage();
}

function buildTotalStockDetailHTML(s) {
  const cv = s.qty * s.price;
  const pl = cv - s.totalCost;
  const avg = s.qty > 0 ? s.totalCost / s.qty : 0;
  const rate = s.totalCost > 0 ? (pl / s.totalCost) * 100 : NaN;
  const cls = pc(pl);

  return `<div class="metrics-grid">
    <div class="metric"><div class="m-label">成交均價</div><div class="m-val">${fmtPrice(avg)}</div></div>
    <div class="metric"><div class="m-label">現值</div><div class="m-val">${fmtAmount(cv)}</div></div>
    <div class="metric"><div class="m-label">市價</div><div class="m-val">${fmtPrice(s.price)}</div></div>
    <div class="metric"><div class="m-label">預估損益</div><div class="m-val ${cls}">${fmtPL(pl)}</div></div>
    <div class="metric"><div class="m-label">付出成本</div><div class="m-val">${fmtAmount(s.totalCost)}</div></div>
    <div class="metric"><div class="m-label">報酬率</div><div class="m-val ${cls}">${fmtRate(rate)}</div></div>
  </div>`;
}

let editingGoalId = null;
let goalSelectedItems = [];

async function getGoalSources() {
  await Promise.all([financeReady, dbsReady]);

  const accounts = await idb.all(financeDb, "accounts");
  accounts.sort((a, b) => (a.sortOrder ?? a.id) - (b.sortOrder ?? b.id));

  const stockVal = await getStockTotal("stocks");
  const pledgeVal = await getStockTotal("pledge");

  const sources = accounts.map(a => ({
    key: `account:${a.id}`,
    name: a.name,
    value: Number(a.balance) || 0
  }));

  if (stockVal !== 0) {
    sources.push({
      key: "stock:stocks",
      name: "股票市值",
      value: stockVal
    });
  }

  if (pledgeVal !== 0) {
    sources.push({
      key: "stock:pledge",
      name: "質押股票市值",
      value: pledgeVal
    });
  }

  return sources;
}

async function calcGoalCurrent(selectedItems) {
  const sources = await getGoalSources();
  return sources
    .filter(s => selectedItems.includes(s.key))
    .reduce((sum, s) => sum + s.value, 0);
}

async function renderGoalPage() {
  await goalReady;

  const goals = await idb.all(goalDb, "goals");

  if (!goals.length) {
    $("goalRows").innerHTML = '<div class="empty-tip">尚未新增目標<br>點右上角「新增」建立</div>';
    return;
  }

  let html = "";

  for (const g of goals) {
    const current = await calcGoalCurrent(g.selectedItems || []);
    const target = Number(g.targetAmount) || 0;

    let progress = 0;

    if (target > 0) {
        progress = Math.min(
            Math.max(current / target, 0),
            1
        );
    }

    html += `
    <div class="goal-item">

        <div class="goal-row" data-id="${g.id}" onclick="openGoalTrend(${g.id})">

            <div class="goal-left">

                <div class="goal-icon">

                    <div class="goal-ring"
                        style="--p:${progress};">
                    </div>

                    <img src="target.png">

                </div>

                <div class="goal-main">

                    <div class="goal-name">
                        ${g.name}
                        ${progress >= 1 ? '<span class="goal-done">✅</span>' : ''}
                    </div>

                </div>

            </div>

            <div class="goal-right-wrap">

                <button class="goal-edit-btn"
                    onclick="event.stopPropagation();openGoalModal(${g.id})">
                    編輯
                </button>

                <div class="goal-right-swipe">

                    <div class="goal-values">

                        <div class="${current<0?"neg":""}">
                            ${fmtMoney(current)}
                        </div>

                        <div class="goal-target">
                            ${fmtMoney(target)}
                        </div>

                    </div>

                </div>

            </div>

        </div>

    </div>`;
  }

  $("goalRows").innerHTML = html;
  bindGoalSwipe();
}

function getGithubSettings() {
  return {
    username: localStorage.getItem("github_username") || "",
    repo: localStorage.getItem("github_repo") || "",
    token: localStorage.getItem("github_token") || ""
  };
}

function renderSettingsPage() {
  const s = getGithubSettings();

  $("gh-username").value = s.username;
  $("gh-repo").value = s.repo;
  $("gh-token").value = s.token;

  const lastBackup = localStorage.getItem("github_last_backup");

  $("github-last-backup").textContent =
  lastBackup ? formatDateTime(lastBackup) : "尚未備份";

  $("gh-auto-backup").checked =
  localStorage.getItem("github_auto_backup") === "Y";

$("gh-backup-days").value =
  localStorage.getItem("github_backup_days") || "3";
}

function saveGithubSettings() {
  const username = $("gh-username").value.trim();
  const repo = $("gh-repo").value.trim();
  const token = $("gh-token").value.trim();

  if (!username) {
    alert("請輸入 GitHub Username");
    return;
  }

  if (!repo) {
    alert("請輸入 Repository");
    return;
  }

  if (!token) {
    alert("請輸入 GitHub Token");
    return;
  }

  localStorage.setItem("github_username", username);
  localStorage.setItem("github_repo", repo);
  localStorage.setItem("github_token", token);

  localStorage.setItem(
    "github_auto_backup",
    $("gh-auto-backup").checked ? "Y" : "N"
  );

  localStorage.setItem(
    "github_backup_days",
    Math.max(1, Number($("gh-backup-days").value) || 3)
  );

  alert("設定已儲存");
}

function setGithubStatus(text) {
  const el = $("githubStatus");
  if (el) el.textContent = text || "";
}

function getGithubApiConfig() {
  const s = getGithubSettings();

  if (!s.username || !s.repo || !s.token) {
    throw new Error("請先完成 GitHub 設定");
  }

  return {
    owner: s.username,
    repo: s.repo,
    token: s.token,
    path: "latest.json"
  };
}

async function githubRequest(url, options = {}) {
  const config = getGithubApiConfig();

  const res = await fetch(url, {
    ...options,
    headers: {
      "Authorization": `Bearer ${config.token}`,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(options.headers || {})
    }
  });

  return res;
}

async function testGithubConnection() {
  try {
    setGithubStatus("測試連線中...");

    const config = getGithubApiConfig();

    const url =
      `https://api.github.com/repos/${config.owner}/${config.repo}`;

    const res = await githubRequest(url);

    if (!res.ok) {
      throw new Error(`GitHub 連線失敗：HTTP ${res.status}`);
    }

    setGithubStatus("GitHub 連線成功");
  } catch (err) {
    console.error(err);
    setGithubStatus(err.message || "GitHub 連線失敗");
  }
}

async function exportAllData() {
  await Promise.all([financeReady, dbsReady, goalReady]);

  const financeAccounts = await idb.all(financeDb, "accounts");
  const financeTransactions = await idb.all(financeDb, "transactions");

  const stockStocks = await idb.all(stockDb, "stocks");
  const stockTransactions = await idb.all(stockDb, "transactions");

  const pledgeStocks = await idb.all(pledgeDb, "stocks");
  const pledgeTransactions = await idb.all(pledgeDb, "transactions");

  const goals = await idb.all(goalDb, "goals");

  return {
    app: "stock-app",
    version: 1,
    exportedAt: new Date().toISOString(),
    finance: {
      accounts: financeAccounts,
      transactions: financeTransactions
    },
    stocks: {
      stocks: stockStocks,
      transactions: stockTransactions
    },
    pledge: {
      stocks: pledgeStocks,
      transactions: pledgeTransactions
    },
    goals: {
      goals
    }
  };
}

function encodeBase64Unicode(str) {
  return btoa(unescape(encodeURIComponent(str)));
}

function decodeBase64Unicode(str) {
  return decodeURIComponent(escape(atob(str)));
}

async function backupToGithub() {
  try {
    setGithubStatus("正在產生備份...");

    const config = getGithubApiConfig();
    const backup = await exportAllData();
    const json = JSON.stringify(backup, null, 2);

    const apiUrl =
      `https://api.github.com/repos/${config.owner}/${config.repo}/contents/${config.path}`;

    let sha = null;

    setGithubStatus("正在檢查 GitHub 備份檔...");

    const getRes = await githubRequest(apiUrl);

    if (getRes.ok) {
      const file = await getRes.json();
      sha = file.sha;
    } else if (getRes.status !== 404) {
      throw new Error(`讀取備份檔失敗：HTTP ${getRes.status}`);
    }

    const body = {
      message: `backup ${new Date().toISOString()}`,
      content: encodeBase64Unicode(json)
    };

    if (sha) body.sha = sha;

    setGithubStatus("正在上傳到 GitHub...");

    const putRes = await githubRequest(apiUrl, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });

    if (!putRes.ok) {
      throw new Error(`GitHub 備份失敗：HTTP ${putRes.status}`);
    }

    const now = new Date().toISOString();

    localStorage.setItem("github_last_backup", now);

    renderSettingsPage();

    setGithubStatus("備份完成");
  } catch (err) {
    console.error(err);
    setGithubStatus(err.message || "備份失敗");
  }
}

let autoBackupRunning = false;

async function checkAutoBackup(){
  try{
    if(autoBackupRunning) return;

    const enabled =
      localStorage.getItem("github_auto_backup") === "Y";

    if(!enabled) return;

    const lastBackup =
      localStorage.getItem("github_last_backup");

    if(!lastBackup) return;

    const days =
      Math.max(1, Number(localStorage.getItem("github_backup_days")) || 3);

    const nextTime =
      new Date(lastBackup).getTime() + days * 24 * 60 * 60 * 1000;

    if(Date.now() < nextTime) return;

    const s = getGithubSettings();

    if(!s.username || !s.repo || !s.token) return;

    autoBackupRunning = true;

    await backupToGithub();

  }catch(err){
    console.warn("auto backup skipped", err);
  }finally{
    autoBackupRunning = false;
  }
}

async function clearStore(db, storeName) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    const store = tx.objectStore(storeName);
    store.clear();

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function importRecords(db, storeName, records) {
  if (!Array.isArray(records)) return;

  for (const rec of records) {
    await idb.put(db, storeName, rec);
  }
}

async function importAllData(data) {
  await Promise.all([financeReady, dbsReady, goalReady]);

  if (!data || data.app !== "stock-app") {
    throw new Error("備份檔格式不正確");
  }

  await clearStore(financeDb, "accounts");
  await clearStore(financeDb, "transactions");

  await clearStore(stockDb, "stocks");
  await clearStore(stockDb, "transactions");

  await clearStore(pledgeDb, "stocks");
  await clearStore(pledgeDb, "transactions");

  await clearStore(goalDb, "goals");

  await importRecords(financeDb, "accounts", data.finance?.accounts || []);
  await importRecords(financeDb, "transactions", data.finance?.transactions || []);

  await importRecords(stockDb, "stocks", data.stocks?.stocks || []);
  await importRecords(stockDb, "transactions", data.stocks?.transactions || []);

  await importRecords(pledgeDb, "stocks", data.pledge?.stocks || []);
  await importRecords(pledgeDb, "transactions", data.pledge?.transactions || []);

  await importRecords(goalDb, "goals", data.goals?.goals || []);
}

async function restoreFromGithub() {
  try {
    if (!confirm("確定要從 GitHub 還原？目前手機內資料會被覆蓋。")) {
      return;
    }

    setGithubStatus("正在從 GitHub 下載備份...");

    const config = getGithubApiConfig();

    const apiUrl =
      `https://api.github.com/repos/${config.owner}/${config.repo}/contents/${config.path}`;

    const res = await githubRequest(apiUrl);

    if (!res.ok) {
      throw new Error(`讀取 GitHub 備份失敗：HTTP ${res.status}`);
    }

    const file = await res.json();
    const base64 = String(file.content || "").replace(/\n/g, "");
    const json = decodeBase64Unicode(base64);
    const data = JSON.parse(json);

    setGithubStatus("正在還原資料...");

    await importAllData(data);

    setGithubStatus("還原完成");

    if (currentTab === "balance") renderBalancePage();
    if (currentTab === "stocks") renderStockPage("stocks");
    if (currentTab === "pledge") renderStockPage("pledge");
    if (currentTab === "goals") renderGoalPage();

  } catch (err) {
    console.error(err);
    setGithubStatus(err.message || "還原失敗");
  }
}

function formatDateTime(iso){
  const d = new Date(iso);

  return d.getFullYear()+"/"
    +String(d.getMonth()+1).padStart(2,"0")+"/"
    +String(d.getDate()).padStart(2,"0");
}

let goalSwipe = null;

let openedGoalSwipe = null;

function closeOpenedGoalSwipe(){
    if(openedGoalSwipe){
        openedGoalSwipe.style.transform = "translateX(0)";
        openedGoalSwipe = null;
    }
}

function bindGoalSwipe(){

    document.querySelectorAll(".goal-right-swipe").forEach(swipe=>{

        let startX = 0;
        let startY = 0;
        let dx = 0;
        let dy = 0;
        let dragging = false;

        swipe.onpointerdown = e => {
            startX = e.clientX;
            startY = e.clientY;
            dx = 0;
            dy = 0;
            dragging = true;
            swipe.dataset.swiped = "0";

            if(openedGoalSwipe && openedGoalSwipe !== swipe){
                closeOpenedGoalSwipe();
            }
        };

        swipe.onpointermove = e => {
            if(!dragging) return;

            dx = e.clientX - startX;
            dy = e.clientY - startY;

            if(Math.abs(dx) > 6){
                swipe.dataset.swiped = "1";
            }

            // 垂直滑動就讓頁面正常捲動
            if(Math.abs(dy) > Math.abs(dx)){
                return;
            }

            e.preventDefault();

            // 左滑打開，右滑收回
            const currentOpen = openedGoalSwipe === swipe ? -72 : 0;
            let next = currentOpen + dx;

            next = Math.min(0, Math.max(next, -72));

            swipe.style.transform = `translateX(${next}px)`;
        };

        swipe.onpointerup = () => {
            if(!dragging) return;
            dragging = false;

            if(dx < -35){
                closeOpenedGoalSwipe();
                swipe.style.transform = "translateX(-72px)";
                openedGoalSwipe = swipe;
            }else if(dx > 25){
                swipe.style.transform = "translateX(0)";
                if(openedGoalSwipe === swipe){
                    openedGoalSwipe = null;
                }
            }else{
                if(openedGoalSwipe === swipe){
                    swipe.style.transform = "translateX(-72px)";
                }else{
                    swipe.style.transform = "translateX(0)";
                }
            }
        };

        swipe.onpointercancel = () => {
            dragging = false;
        };

        swipe.onclick = e => {
            if(swipe.dataset.swiped === "1"){
                e.preventDefault();
                e.stopPropagation();
                swipe.dataset.swiped = "0";
            }
        };
    });
}

document.addEventListener("pointerdown", e => {
    if(!e.target.closest(".goal-row")){
        closeOpenedGoalSwipe();
    }
});

function openGoalTrend(goalId) {
  closeOpenedGoalSwipe();
  location.href = `trend.html?goalId=${goalId}`;
}

async function openGoalModal(goalId) {
  editingGoalId = goalId || null;

  const sources = await getGoalSources();

  if (editingGoalId) {
    const g = await idb.get(goalDb, "goals", editingGoalId);
    if (!g) return;

    $("goal-modal-title").textContent = "編輯目標";
    $("goal-name").value = g.name;
    $("goal-target").value = g.targetAmount < 0
      ? `(${Math.abs(g.targetAmount)})`
      : String(g.targetAmount);

    goalSelectedItems = [...(g.selectedItems || [])];
    $("goal-delete-btn").classList.remove("hidden");
  } else {
    $("goal-modal-title").textContent = "新增目標";
    $("goal-name").value = "";
    $("goal-target").value = "";

    // 預設全選
    goalSelectedItems = sources.map(s => s.key);
    $("goal-delete-btn").classList.add("hidden");
  }

  renderGoalSourceList(sources);
  await updateGoalPreview();

  openModal("modal-goal");
}

function renderGoalSourceList(sources) {
  $("goal-source-list").innerHTML = sources.map(s => {
    const selected = goalSelectedItems.includes(s.key);

    return `<div class="goal-source-row ${selected ? "selected" : ""}" onclick="toggleGoalSourceByKey('${s.key}')">
      <span class="goal-source-name">${s.name}</span>
      <span class="goal-source-value ${s.value < 0 ? "neg" : ""}">${fmtMoney(s.value)}</span>
      <span class="goal-check">${selected ? "✓" : ""}</span>
    </div>`;
  }).join("");
}

async function toggleGoalSourceByKey(key) {
  if (goalSelectedItems.includes(key)) {
    goalSelectedItems = goalSelectedItems.filter(x => x !== key);
  } else {
    goalSelectedItems.push(key);
  }

  const sources = await getGoalSources();
  renderGoalSourceList(sources);
  await updateGoalPreview();
}

async function updateGoalPreview() {
  const current = await calcGoalCurrent(goalSelectedItems);
  $("goal-current-preview").textContent = fmtMoney(current);
  $("goal-current-preview").className = "goal-current-value " + (current < 0 ? "neg" : "");
}

async function submitGoal() {
  const name = $("goal-name").value.trim();
  const targetAmount = parseMoneyInput($("goal-target").value);

  if (!name) {
    alert("請輸入目標名稱");
    return;
  }

  const rec = {
    name,
    targetAmount,
    selectedItems: [...goalSelectedItems],
    updatedAt: Date.now()
  };

  if (editingGoalId) {
    rec.id = editingGoalId;
    const old = await idb.get(goalDb, "goals", editingGoalId);
    rec.createdAt = old?.createdAt || Date.now();
    await idb.put(goalDb, "goals", rec);
  } else {
    rec.createdAt = Date.now();
    await idb.add(goalDb, "goals", rec);
  }

  closeModal("modal-goal");
  renderGoalPage();
}

async function deleteGoal() {
  if (!editingGoalId) return;

  const g = await idb.get(goalDb, "goals", editingGoalId);
  if (!g) return;

  if (!confirm(`確定刪除目標「${g.name}」？`)) return;

  await idb.del(goalDb, "goals", editingGoalId);
  closeModal("modal-goal");
  renderGoalPage();
}

let draggingRow = null;

function bindAccountDragEvents() {
  document.querySelectorAll(".edit-mode-row .drag-handle").forEach(handle => {
    handle.addEventListener("pointerdown", e => {
      const row = handle.closest(".edit-mode-row");
      if (!row) return;

      draggingRow = row;
      row.classList.add("dragging");

      handle.setPointerCapture(e.pointerId);
      e.preventDefault();
    });

    handle.addEventListener("pointermove", e => {
      if (!draggingRow) return;
    
      e.preventDefault();
    
      const rows = [...document.querySelectorAll(".edit-mode-row:not(.dragging)")];
    
      const target = rows.find(row => {
        const box = row.getBoundingClientRect();
        return e.clientY >= box.top && e.clientY <= box.bottom;
      });
    
      if (!target) return;
    
      const box = target.getBoundingClientRect();
      const after = e.clientY > box.top + box.height / 2;
    
      if (after) {
        target.after(draggingRow);
      } else {
        target.before(draggingRow);
      }
    });

    handle.addEventListener("pointerup", async e => {
      if (!draggingRow) return;

      draggingRow.classList.remove("dragging");
      draggingRow = null;

      await saveAccountSortOrder();
    });

    handle.addEventListener("pointercancel", async e => {
      if (!draggingRow) return;

      draggingRow.classList.remove("dragging");
      draggingRow = null;

      await saveAccountSortOrder();
    });
  });
}

async function saveAccountSortOrder() {
  const rows = [...document.querySelectorAll(".edit-mode-row")];

  for (let i = 0; i < rows.length; i++) {
    const id = Number(rows[i].dataset.id);
    const acc = await idb.get(financeDb, "accounts", id);

    if (acc) {
      acc.sortOrder = i + 1;
      await idb.put(financeDb, "accounts", acc);
    }
  }

  renderBalancePage();
}

/* ── 新增帳戶 ─────────────────────────────────────────────── */
let addAccType = "asset";
let balanceEditMode = false;

function toggleBalanceEdit() {
  balanceEditMode = !balanceEditMode;

  $("balance-edit-btn").textContent = balanceEditMode ? "完成" : "編輯";
  $("balance-add-btn").style.display = balanceEditMode ? "" : "none";

  renderBalancePage();
}

function openAddAccount() {
  $("acc-name").value = ""; $("acc-init").value = "";
  selectAccType("asset");
  openModal("modal-addAccount");
}
function selectAccType(type) {
  addAccType = type;
  $("acc-type-asset").classList.toggle("active", type === "asset");
  $("acc-type-liability").classList.toggle("active", type === "liability");
  $("acc-type-loan").classList.toggle("active", type === "loan");
}
function parseMoneyInput(s) {
  s = String(s || "").trim().replace(/,/g, "");

  if (!s) return 0;

  if (/^\(.+\)$/.test(s)) {
    return -Math.abs(Number(s.slice(1, -1)) || 0);
  }

  return Number(s) || 0;
}

function toggleAccInitNegative() {
  const el = $("acc-init");
  let v = el.value.trim();

  if (!v) return;

  if (/^\(.+\)$/.test(v)) {
    el.value = v.slice(1, -1);
  } else {
    el.value = `(${v})`;
  }
}

async function submitAddAccount() {
  const name = $("acc-name").value.trim();
  const raw = $("acc-init").value.trim();

  if (!name) {
    alert("請輸入帳戶名稱");
    return;
  }

  const balance = parseMoneyInput(raw);

  const accId = await idb.add(financeDb, "accounts", {
    name,
    type: addAccType,
    balance,
    sortOrder: Date.now(),
    createdAt: Date.now()
  });

  await idb.add(financeDb, "transactions", {
    accountId: accId,
    type: "init",
    amount: balance,
    toAccountId: null,
    note: "初始餘額",
    timestamp: Date.now()
  });

  closeModal("modal-addAccount");
  renderBalancePage();
}

/* ── 帳戶明細 ─────────────────────────────────────────────── */
let currentAccId = null;

async function openAccountDetail(id) {
  currentAccId = id;
  const acc = await idb.get(financeDb, "accounts", id);
  if (!acc) return;
  $("ov-acc-name").textContent    = acc.name;
  $("ov-acc-balance").textContent = fmtMoney(acc.balance);
  $("ov-acc-balance").className   = "acc-balance-val " + (acc.balance < 0 ? "neg" : "");
  await loadAccTxList(id);
  openOverlay("overlay-account");
}
function closeAccountDetail() { closeOverlay("overlay-account"); currentAccId = null; }

async function loadAccTxList(accId) {
  const txs    = await idb.idx(financeDb, "transactions", "accountId", accId);
  const allAcc = await idb.all(financeDb, "accounts");
  const accMap = Object.fromEntries(allAcc.map(a => [a.id, a.name]));

  txs.sort((a, b) => b.timestamp - a.timestamp);

  const lbl = {
    init: "初始餘額",
    income: "收入",
    expense: "費用",
    transfer: "資金轉帳"
  };

  $("acc-tx-list").innerHTML = txs.map(t => {
    const isOut = t.type === "expense" || t.type === "transfer" || Number(t.amount) < 0;
    const cls   = isOut ? "neg" : "pos";
    const sign  = isOut ? "−" : "+";

    const title = t.type === "transfer" && t.toAccountId
      ? `${lbl[t.type]} → ${accMap[t.toAccountId] || "?"}`
      : lbl[t.type] || t.type;

    return `<div class="tx-row">
      <div class="tx-main">
        <span class="tx-type ${cls}">${title}</span>
        <span class="tx-amt">${sign}${fmtAmount(t.amount)}</span>
        <span class="tx-actions">
          <button class="tx-edit-btn" onclick="openEditFinanceTx(${t.id})">改</button>

          ${t.type === "init"
              ? ""
              : `<button class="tx-del-btn" onclick="deleteFinanceTx(${t.id})">✕</button>`}
        </span>
      </div>
      <div class="tx-date">${fmtDate(t.timestamp)}${t.note ? ` · ${t.note}` : ""}</div>
    </div>`;
  }).join("") || '<div class="empty-tip">尚無交易紀錄</div>';
}

async function deleteCurrentAccount() {
  const acc = await idb.get(financeDb, "accounts", currentAccId);
  if (!acc || !confirm(`確定刪除「${acc.name}」？紀錄也會一併刪除。`)) return;
  await idb.del(financeDb, "accounts", currentAccId);
  await idb.delIdx(financeDb, "transactions", "accountId", currentAccId);
  closeAccountDetail();
  renderBalancePage();
}

let editAccId = null;
let editAccType = "asset";

async function openEditAccountBasic(id) {
  editAccId = id;

  const acc = await idb.get(financeDb, "accounts", id);
  if (!acc) return;

  $("edit-account-title").textContent = "修改初始餘額";

  $("edit-acc-name").value = acc.name;

  const txs = await idb.idx(financeDb, "transactions", "accountId", id);
  const initTx = txs.find(t => t.type === "init");

  const initAmount = initTx
    ? Number(initTx.amount) || 0
    : Number(acc.balance) || 0;

  $("edit-acc-balance").value = initAmount < 0
    ? `(${Math.abs(initAmount)})`
    : String(initAmount);

  selectEditAccType(acc.type || "asset");

  openModal("modal-editAccount");
}

function selectEditAccType(type) {
  editAccType = type;
  $("edit-acc-type-asset").classList.toggle("active", type === "asset");
  $("edit-acc-type-liability").classList.toggle("active", type === "liability");
  $("edit-acc-type-loan").classList.toggle("active", type === "loan");
}

function toggleEditAccNegative() {
  const el = $("edit-acc-balance");
  let v = el.value.trim();

  if (!v) return;

  if (/^\(.+\)$/.test(v)) {
    el.value = v.slice(1, -1);
  } else {
    el.value = `(${v})`;
  }
}

async function submitEditAccountBasic() {
  const acc = await idb.get(financeDb, "accounts", editAccId);
  if (!acc) return;

  const name = $("edit-acc-name").value.trim();
  const newInit = parseMoneyInput($("edit-acc-balance").value);

  if (!name) {
    alert("請輸入帳號名稱");
    return;
  }

  const txs = await idb.idx(financeDb, "transactions", "accountId", editAccId);
  let initTx = txs.find(t => t.type === "init");

  const oldInit = initTx ? Number(initTx.amount) || 0 : 0;
  const diff = newInit - oldInit;

  acc.name = name;
  acc.type = editAccType;
  acc.balance = (Number(acc.balance) || 0) + diff;

  await idb.put(financeDb, "accounts", acc);

  if (initTx) {
    initTx.amount = newInit;
    initTx.note = "初始餘額";
    await idb.put(financeDb, "transactions", initTx);
  } else {
    await idb.add(financeDb, "transactions", {
      accountId: editAccId,
      type: "init",
      amount: newInit,
      toAccountId: null,
      note: "初始餘額",
      timestamp: Date.now()
    });
  }

  closeModal("modal-editAccount");
  renderBalancePage();
}

async function deleteAccountFromList(id) {
  const acc = await idb.get(financeDb, "accounts", id);
  if (!acc) return;

  if (!confirm(`確定刪除「${acc.name}」？紀錄也會一併刪除。`)) return;

  await idb.del(financeDb, "accounts", id);
  await idb.delIdx(financeDb, "transactions", "accountId", id);

  renderBalancePage();
}

/* ── 記帳 ─────────────────────────────────────────────────── */
let addTxType = "income";

async function openAddTx(presetType) {
  addTxType = presetType || "income";
  $("tx-amount").value = ""; $("tx-note").value = "";

  // 填入帳戶下拉
  const accounts = await idb.all(financeDb, "accounts");
  const accOpts  = accounts.map(a =>
    `<option value="${a.id}" ${a.id === currentAccId ? "selected" : ""}>${a.name}</option>`
  ).join("");
  $("tx-from-acc").innerHTML  = accOpts || '<option value="">（無帳戶）</option>';
  $("tx-to-acc").innerHTML    = accOpts || '<option value="">（無帳戶）</option>';

  selectTxType(addTxType);
  openModal("modal-addTx");
}

function selectTxType(type) {
  addTxType = type;
  const titles = { income:"記收入", expense:"記費用", transfer:"資金轉帳" };
  $("addTx-title").textContent = titles[type] || "記帳";
  document.querySelectorAll("#tx-type-row .type-btn").forEach((b,i) => {
    b.classList.toggle("active", ["income","expense","transfer"][i] === type);
  });
  $("tx-to-acc").classList.toggle("hidden", type !== "transfer");
  $("tx-category").classList.add("hidden");
}

async function submitAddTx() {
  const amount = Number($("tx-amount").value);
  if (!amount || amount <= 0) { alert("請輸入正確金額"); return; }
  const note    = $("tx-note").value.trim();
  const fromId  = Number($("tx-from-acc").value);
  if (!fromId)  { alert("請選擇帳戶"); return; }

  const acc = await idb.get(financeDb, "accounts", fromId);
  if (!acc) return;

  if (addTxType === "income") {
    acc.balance += amount;
    await idb.put(financeDb, "accounts", acc);
    await idb.add(financeDb, "transactions",
      { accountId:fromId, type:"income", amount, toAccountId:null, note, timestamp:Date.now() });

  } else if (addTxType === "expense") {
    acc.balance -= amount;
    await idb.put(financeDb, "accounts", acc);
    await idb.add(financeDb, "transactions",
      { accountId:fromId, type:"expense", amount, toAccountId:null, note, timestamp:Date.now() });

  } else if (addTxType === "transfer") {
    const toId  = Number($("tx-to-acc").value);
    if (!toId || toId === fromId) { alert("請選擇不同的目標帳戶"); return; }
    const toAcc = await idb.get(financeDb, "accounts", toId);
    if (!toAcc) return;
    acc.balance   -= amount;
    toAcc.balance += amount;
    await idb.put(financeDb, "accounts", acc);
    await idb.put(financeDb, "accounts", toAcc);
    await idb.add(financeDb, "transactions",
      { accountId:fromId, type:"transfer", amount, toAccountId:toId, note, timestamp:Date.now() });
  }

  closeModal("modal-addTx");
  // 如果帳戶明細開著，同步更新
  if (currentAccId) {
    const fresh = await idb.get(financeDb, "accounts", currentAccId);
    if (fresh) {
      $("ov-acc-balance").textContent = fmtMoney(fresh.balance);
      $("ov-acc-balance").className   = "acc-balance-val " + (fresh.balance < 0 ? "neg" : "");
    }
    await loadAccTxList(currentAccId);
  }
  renderBalancePage();
}

let editFinanceTxId = null;
let editFinanceTxType = "income";

async function openEditFinanceTx(txId) {
  editFinanceTxId = txId;

  const tx = await idb.get(financeDb, "transactions", txId);
  if (!tx) return;

  // 初始餘額改走帳戶基本資料
  if (tx.type === "init") {
    openEditAccountBasic(tx.accountId);
    return;
  }

  const accounts = await idb.all(financeDb, "accounts");
  const accOpts = accounts.map(a =>
    `<option value="${a.id}">${a.name}</option>`
  ).join("");

  $("edit-tx-from-acc").innerHTML = accOpts;
  $("edit-tx-to-acc").innerHTML = accOpts;

  $("edit-tx-from-acc").value = tx.accountId;
  $("edit-tx-to-acc").value = tx.toAccountId || "";

  $("edit-tx-amount").value = Math.abs(Number(tx.amount) || 0);
  $("edit-tx-note").value = tx.note || "";

  // 修改時不可改類型
  $("edit-finance-tx-type-row").classList.add("hidden");

  // 修改時不可改帳戶
  $("edit-tx-from-acc").disabled = true;
  $("edit-tx-to-acc").disabled = true;

  if (tx.type === "income") {
    $("editFinanceTx-title").textContent = "修改收入";
    $("edit-tx-to-acc").classList.add("hidden");
  } else if (tx.type === "expense") {
    $("editFinanceTx-title").textContent = "修改費用";
    $("edit-tx-to-acc").classList.add("hidden");
  } else if (tx.type === "transfer") {
    $("editFinanceTx-title").textContent = "修改資金轉帳";
    $("edit-tx-to-acc").classList.remove("hidden");
  }

  editFinanceTxType = tx.type;

  openModal("modal-editFinanceTx");
}

function selectEditFinanceTxType(type) {
  editFinanceTxType = type;

  const titles = {
    income: "修改收入",
    expense: "修改費用",
    transfer: "修改資金轉帳",
    init: "修改初始餘額"
  };

  $("editFinanceTx-title").textContent = titles[type] || "修改紀錄";

  document.querySelectorAll("#edit-finance-tx-type-row .type-btn").forEach((b, i) => {
    b.classList.toggle("active", ["income", "expense", "transfer"][i] === type);
  });

  $("edit-tx-to-acc").classList.toggle("hidden", type !== "transfer");
}

async function reverseFinanceTx(tx) {
  const acc = await idb.get(financeDb, "accounts", tx.accountId);
  if (!acc) return;

  if (tx.type === "income" || tx.type === "init") {
    acc.balance -= tx.amount;
  } else if (tx.type === "expense") {
    acc.balance += tx.amount;
  } else if (tx.type === "transfer") {
    acc.balance += tx.amount;

    const toAcc = await idb.get(financeDb, "accounts", tx.toAccountId);
    if (toAcc) {
      toAcc.balance -= tx.amount;
      await idb.put(financeDb, "accounts", toAcc);
    }
  }

  await idb.put(financeDb, "accounts", acc);
}

async function applyFinanceTx(tx) {
  const acc = await idb.get(financeDb, "accounts", tx.accountId);
  if (!acc) return;

  if (tx.type === "income" || tx.type === "init") {
    acc.balance += tx.amount;
  } else if (tx.type === "expense") {
    acc.balance -= tx.amount;
  } else if (tx.type === "transfer") {
    acc.balance -= tx.amount;

    const toAcc = await idb.get(financeDb, "accounts", tx.toAccountId);
    if (toAcc) {
      toAcc.balance += tx.amount;
      await idb.put(financeDb, "accounts", toAcc);
    }
  }

  await idb.put(financeDb, "accounts", acc);
}

async function submitEditFinanceTx() {
  const oldTx = await idb.get(financeDb, "transactions", editFinanceTxId);
  if (!oldTx) return;

  const amount = Number($("edit-tx-amount").value);
  if (!amount || amount <= 0) {
    alert("請輸入正確金額");
    return;
  }

  // 先還原舊交易影響
  await reverseFinanceTx(oldTx);

  // 只允許改金額與備註
  oldTx.amount = amount;
  oldTx.note = $("edit-tx-note").value.trim();

  // 帳戶、類型、轉入帳戶全部維持原本
  await applyFinanceTx(oldTx);
  await idb.put(financeDb, "transactions", oldTx);

  closeModal("modal-editFinanceTx");

  if (currentAccId) {
    const fresh = await idb.get(financeDb, "accounts", currentAccId);
    if (fresh) {
      $("ov-acc-balance").textContent = fmtMoney(fresh.balance);
      $("ov-acc-balance").className = "acc-balance-val " + (fresh.balance < 0 ? "neg" : "");
    }

    await loadAccTxList(currentAccId);
  }

  renderBalancePage();
}

async function deleteFinanceTx(txId) {
  if (!confirm("確定刪除這筆紀錄？")) return;
  const tx  = await idb.get(financeDb, "transactions", txId);
  if (!tx) return;
  const acc = await idb.get(financeDb, "accounts", tx.accountId);
  if (acc) {
    if (tx.type === "income" || tx.type === "init") acc.balance -= tx.amount;
    else if (tx.type === "expense")                  acc.balance += tx.amount;
    else if (tx.type === "transfer") {
      acc.balance += tx.amount;
      const toAcc = await idb.get(financeDb, "accounts", tx.toAccountId);
      if (toAcc) { toAcc.balance -= tx.amount; await idb.put(financeDb, "accounts", toAcc); }
    }
    await idb.put(financeDb, "accounts", acc);
  }
  await idb.del(financeDb, "transactions", txId);
  const fresh = await idb.get(financeDb, "accounts", currentAccId);
  if (fresh) {
    $("ov-acc-balance").textContent = fmtMoney(fresh.balance);
    $("ov-acc-balance").className   = "acc-balance-val " + (fresh.balance < 0 ? "neg" : "");
  }
  await loadAccTxList(currentAccId);
  renderBalancePage();
}

/* ── 啟動 ───────────────────────────────────────────────────── */
(async()=>{
  if("serviceWorker" in navigator)
    navigator.serviceWorker.register("./sw.js").catch(e=>console.warn("SW:",e));

  await Promise.all([dbsReady, financeReady, goalReady]);
  bindQtyFormat($("asQty")); bindQtyFormat($("etQty"));

  const tab = new URLSearchParams(location.search).get("tab");

  switchTab(tab || "stocks");
  switchStockSubTab("all");

  priceMap=await fetchPrices();
  await updatePricesInDB("stocks");
  await updatePricesInDB("pledge");
  renderStockPage("stocks");
  renderStockPage("pledge");
  checkAutoBackup();
})();

window.addEventListener("focus", () => {
  checkAutoBackup();
});
