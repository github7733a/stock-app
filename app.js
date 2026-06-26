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
let currentTab = "stocks";
function switchTab(tab) {
  document.querySelectorAll(".page").forEach(p=>p.classList.add("hidden"));
  document.querySelectorAll(".tab").forEach(t=>t.classList.remove("active"));
  $(`page-${tab}`).classList.remove("hidden");
  document.querySelector(`.tab[data-tab="${tab}"]`).classList.add("active");
  currentTab = tab;
  if (tab==="stocks")  renderStockPage("stocks");
  if (tab==="pledge")  renderStockPage("pledge");
  if (tab==="balance") renderBalancePage();
  if (tab==="goals") renderGoalPage();
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

/* ── 股價 ───────────────────────────────────────────────────── */
let priceMap = {};
function setStatus(t) { $("priceStatusText").textContent=t; $("pledgeStatusText").textContent=t; }

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

  $(`${ctx}-edit-btn`).textContent = stockEditMode[ctx] ? "完成" : "編輯";
  $(`${ctx}-add-btn`).style.display = stockEditMode[ctx] ? "" : "none";

  if (stockEditMode[ctx]) {
    expanded[ctx] = null;
  }

  renderStockPage(ctx);
}

async function renderStockPage(ctx) {
  const db=getDb(ctx); if(!db) return;
  const stocks=await idb.all(db,"stocks");
  stocks.sort((a, b) => (a.sortOrder ?? a.id) - (b.sortOrder ?? b.id));
  const rowsEl=$(`${ctx}-rows`), sumEl=$(`${ctx}-summary`);
  let html="",tv=0,tc=0;
  if(!stocks.length){
    html='<div class="empty-tip">尚未新增任何股票<br>點右上角「＋」新增</div>';
    sumEl.classList.add("hidden");
  } else {
    stocks.forEach(s=>{
      const cv=s.qty*s.price,pl=cv-s.totalCost;
      tv+=cv;tc+=s.totalCost;
      const isOpen=expanded[ctx]===s.id;
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
            <div class="stock-name-col"><span class="s-name">${s.name||s.code}</span><span class="s-code">${s.code}</span></div>
            <span class="col-r">${fmtQty(s.qty)}</span>
            <span class="col-r ${pc(pl)}">${fmtPL(pl)}</span>
            <span class="col-chev ${isOpen?"open":""}">›</span>
          </div>
          <div class="detail-panel ${isOpen?"":"hidden"}" id="${ctx}-panel-${s.id}">${isOpen?buildDetailHTML(s,ctx):""}</div>
        </div>`;
      }
    });
    const pl=tv-tc,rate=tc>0?(pl/tc)*100:NaN;
    $(`${ctx}-totalPL`).textContent=fmtPL(pl);$(`${ctx}-totalPL`).className="sum-val "+pc(pl);
    $(`${ctx}-totalRate`).textContent=fmtRate(rate);$(`${ctx}-totalRate`).className="sum-val "+pc(pl);
    $(`${ctx}-totalValue`).textContent=fmtAmount(tv);$(`${ctx}-totalCost`).textContent=fmtAmount(tc);
    sumEl.classList.remove("hidden");
  }
  rowsEl.innerHTML=html;
  if(expanded[ctx]!=null) loadTxIntoPanel(expanded[ctx],ctx);
  if (stockEditMode[ctx]) bindStockDragEvents(ctx);
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
  const accounts  = await idb.all(financeDb, "accounts");
  accounts.sort((a, b) => (a.sortOrder ?? a.id) - (b.sortOrder ?? b.id));
  const stockVal  = await getStockTotal("stocks");
  const pledgeVal = await getStockTotal("pledge");
  const accSum    = accounts.reduce((s, a) => s + a.balance, 0);
  const nw        = accSum + stockVal + pledgeVal;

  $("nwValue").textContent = fmtMoney(nw);
  $("nwValue").className   = "nw-value " + (nw < 0 ? "neg" : "");

  let html = "";
  accounts.forEach(a => {
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
      html += `<div class="acc-row" onclick="openAccountDetail(${a.id})">
        <span class="acc-name">${a.name}</span>
        <span class="acc-bal ${a.balance < 0 ? "neg" : ""}">${fmtMoney(a.balance)}</span>
      </div>`;
    }
  });
  if (stockVal !== 0) {
    html += `<div class="acc-row readonly-row">
      <span class="acc-name">股票市值 <span class="ro-tag">自動</span></span>
      <span class="acc-bal">${fmtMoney(stockVal)}</span>
    </div>`;
  }
  if (pledgeVal !== 0) {
    html += `<div class="acc-row readonly-row">
      <span class="acc-name">質押市值 <span class="ro-tag">自動</span></span>
      <span class="acc-bal">${fmtMoney(pledgeVal)}</span>
    </div>`;
  }
  $("accountRows").innerHTML = html || '<div class="empty-tip">尚未新增帳戶<br>點右上角「＋」新增</div>';
  if (balanceEditMode) bindAccountDragEvents();
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

    html += `<div class="goal-row" onclick="openGoalModal(${g.id})">
      <div class="goal-name">${g.name}</div>
      <div class="goal-values">
        <div class="${current < 0 ? "neg" : ""}">${fmtMoney(current)}</div>
        <div class="goal-target">${fmtMoney(target)}</div>
      </div>
    </div>`;
  }

  $("goalRows").innerHTML = html;
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

  $("edit-acc-name").value = acc.name;
  $("edit-acc-balance").value = acc.balance < 0
    ? `(${Math.abs(acc.balance)})`
    : String(acc.balance);

  selectEditAccType(acc.type || "asset");
  openModal("modal-editAccount");
}

function selectEditAccType(type) {
  editAccType = type;
  $("edit-acc-type-asset").classList.toggle("active", type === "asset");
  $("edit-acc-type-liability").classList.toggle("active", type === "liability");
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

  if (tx.type === "init") {
    $("editFinanceTx-title").textContent = "修改初始餘額";
    $("edit-finance-tx-type-row").classList.add("hidden");
    $("edit-tx-to-acc").classList.add("hidden");
    editFinanceTxType = "init";
  } else {
    $("edit-finance-tx-type-row").classList.remove("hidden");
    selectEditFinanceTxType(tx.type);
  }

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

  const fromId = Number($("edit-tx-from-acc").value);
  if (!fromId) {
    alert("請選擇帳戶");
    return;
  }

  let newType = oldTx.type === "init" ? "init" : editFinanceTxType;
  let toId = null;

  if (newType === "init") {
    toId = null;
  } else if (newType === "transfer") {
    toId = Number($("edit-tx-to-acc").value);
    if (!toId || toId === fromId) {
      alert("請選擇不同的目標帳戶");
      return;
    }
  }

  await reverseFinanceTx(oldTx);

  oldTx.accountId = fromId;
  oldTx.type = newType;
  oldTx.amount = amount;
  oldTx.toAccountId = toId;
  oldTx.note = $("edit-tx-note").value.trim();

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

  switchTab("stocks");

  priceMap=await fetchPrices();
  await updatePricesInDB("stocks");
  await updatePricesInDB("pledge");
  renderStockPage("stocks");
  renderStockPage("pledge");
})();
