"use strict";

const $ = id => document.getElementById(id);

function openDB(name, upgrade) {
  return new Promise((res, rej) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = e => upgrade(e.target.result);
    req.onsuccess = e => res(e.target.result);
    req.onerror = e => rej(e.target.error);
  });
}

const idb = {
  get: (db, s, k) => new Promise((r, j) => {
    const q = db.transaction(s).objectStore(s).get(k);
    q.onsuccess = () => r(q.result);
    q.onerror = () => j(q.error);
  }),
  all: (db, s) => new Promise((r, j) => {
    const q = db.transaction(s).objectStore(s).getAll();
    q.onsuccess = () => r(q.result);
    q.onerror = () => j(q.error);
  }),
};

function upgradeStockDB(db) {
  if (!db.objectStoreNames.contains("stocks"))
    db.createObjectStore("stocks", { keyPath: "id", autoIncrement: true });
  if (!db.objectStoreNames.contains("transactions")) {
    const ts = db.createObjectStore("transactions", { keyPath: "id", autoIncrement: true });
    ts.createIndex("stockId", "stockId", { unique: false });
  }
}

function upgradeFinanceDB(db) {
  if (!db.objectStoreNames.contains("accounts"))
    db.createObjectStore("accounts", { keyPath: "id", autoIncrement: true });
  if (!db.objectStoreNames.contains("transactions")) {
    const ts = db.createObjectStore("transactions", { keyPath: "id", autoIncrement: true });
    ts.createIndex("accountId", "accountId", { unique: false });
  }
}

function upgradeGoalDB(db) {
  if (!db.objectStoreNames.contains("goals"))
    db.createObjectStore("goals", { keyPath: "id", autoIncrement: true });
}

let financeDb, stockDb, pledgeDb, goalDb;
let currentGoal = null;

let currentTrendPoints = [];
let selectedTrendIndex = null;

const ready = Promise.all([
  openDB("financeDB", upgradeFinanceDB).then(d => { financeDb = d; }),
  openDB("stockAppDB", upgradeStockDB).then(d => { stockDb = d; }),
  openDB("pledgeAppDB", upgradeStockDB).then(d => { pledgeDb = d; }),
  openDB("goalDB", upgradeGoalDB).then(d => { goalDb = d; }),
]);

function todayISO() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function addDaysISO(iso, days) {
  const d = parseISODate(iso);
  d.setDate(d.getDate() + days);
  return toISODate(d);
}

function toISODate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function parseISODate(iso) {
  const [y, m, d] = String(iso).split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

function daysBetweenISO(startISO, endISO) {
  const a = parseISODate(startISO);
  const b = parseISODate(endISO);
  a.setHours(0, 0, 0, 0);
  b.setHours(0, 0, 0, 0);
  return Math.round((b - a) / 86400000);
}

function endOfISODate(iso) {
  const d = parseISODate(iso);
  d.setHours(23, 59, 59, 999);
  return d;
}

function formatDisplayDate(iso) {
  const d = parseISODate(iso);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

function formatMoney(n) {
  const v = Math.round(Number(n) || 0);
  return v < 0
    ? `($${Math.abs(v).toLocaleString("zh-TW")})`
    : `$${v.toLocaleString("zh-TW")}`;
}

function formatAxisMoney(n) {
  const v = Math.round(Number(n) || 0);
  const abs = Math.abs(v);
  let text;

  if (abs >= 100000000) text = (abs / 100000000).toFixed(abs % 100000000 === 0 ? 0 : 1) + "億";
  else if (abs >= 10000) text = (abs / 10000).toFixed(abs % 10000 === 0 ? 0 : 1) + "萬";
  else text = abs.toLocaleString("zh-TW");

  return v < 0 ? `(${text})` : text;
}

function getQueryGoalId() {
  return Number(new URLSearchParams(location.search).get("goalId"));
}

function goBackToGoals() {
  location.href = "index.html?tab=goals";
}

async function getStockTotal(db) {
  if (!db) return 0;
  const stocks = await idb.all(db, "stocks");
  return stocks.reduce((sum, st) => sum + (Number(st.qty) || 0) * (Number(st.price) || 0), 0);
}

function financeTxEffects(tx) {
  const amount = Number(tx.amount) || 0;

  if (tx.type === "init" || tx.type === "income") {
    return [{ accountId: Number(tx.accountId), amount }];
  }

  if (tx.type === "expense") {
    return [{ accountId: Number(tx.accountId), amount: -amount }];
  }

  if (tx.type === "transfer") {
    const effects = [{ accountId: Number(tx.accountId), amount: -amount }];
    if (tx.toAccountId != null) {
      effects.push({ accountId: Number(tx.toAccountId), amount });
    }
    return effects;
  }

  return [];
}

async function buildTrendData(goal, startISO) {
  const today = todayISO();
  const start = startISO > today ? today : startISO;

  const selected = goal.selectedItems || [];
  const selectedAccountIds = selected
    .filter(k => String(k).startsWith("account:"))
    .map(k => Number(String(k).split(":")[1]));
  const selectedAccountSet = new Set(selectedAccountIds);

  const includeStocks = selected.includes("stock:stocks");
  const includePledge = selected.includes("stock:pledge");

  const accounts = await idb.all(financeDb, "accounts");
  const txs = await idb.all(financeDb, "transactions");

  const currentAccountTotal = accounts
    .filter(a => selectedAccountSet.has(Number(a.id)))
    .reduce((sum, a) => sum + (Number(a.balance) || 0), 0);

  const startEnd = endOfISODate(start).getTime();
  const todayEnd = endOfISODate(today).getTime();

  const relevantTxs = [];

  txs.forEach(tx => {
    const ts = Number(tx.timestamp) || 0;
    if (!ts || ts > todayEnd) return;

    const effect = financeTxEffects(tx)
      .filter(e => selectedAccountSet.has(e.accountId))
      .reduce((sum, e) => sum + e.amount, 0);

    if (effect === 0) return;
    relevantTxs.push({ ts, date: toISODate(new Date(ts)), effect });
  });

  const futureEffectAfterStartDay = relevantTxs
    .filter(t => t.ts > startEnd)
    .reduce((sum, t) => sum + t.effect, 0);

  let running = currentAccountTotal - futureEffectAfterStartDay;
  const points = [{ date: start, value: running }];

  const grouped = new Map();

  relevantTxs
    .filter(t => t.ts > startEnd && t.ts <= todayEnd)
    .sort((a, b) => a.ts - b.ts)
    .forEach(t => {
      grouped.set(t.date, (grouped.get(t.date) || 0) + t.effect);
    });

  Array.from(grouped.entries()).sort((a, b) => a[0].localeCompare(b[0])).forEach(([date, effect]) => {
    running += effect;
    if (date === points[points.length - 1].date) {
      points[points.length - 1].value = running;
    } else {
      points.push({ date, value: running });
    }
  });

  let todayValue = currentAccountTotal;

  if (includeStocks) todayValue += await getStockTotal(stockDb);
  if (includePledge) todayValue += await getStockTotal(pledgeDb);

  if (points.length && points[points.length - 1].date === today) {
    points[points.length - 1].value = todayValue;
  } else {
    points.push({ date: today, value: todayValue });
  }

  if (start === today) {
    return [{ date: today, value: todayValue }];
  }

  return points;
}

function expandTrendPointsDaily(points, startISO, endISO) {
  if (!points || !points.length) return [];

  const map = new Map(points.map(p => [p.date, Number(p.value) || 0]));

  const result = [];
  let running = Number(points[0].value) || 0;

  const totalDays = daysBetweenISO(startISO, endISO);

  for (let i = 0; i <= totalDays; i++) {
    const date = addDaysISO(startISO, i);

    if (map.has(date)) {
      running = map.get(date);
    }

    result.push({
      date,
      value: running
    });
  }

  return result;
}

function resizeCanvas(canvas) {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(rect.width * dpr));
  canvas.height = Math.max(1, Math.round(rect.height * dpr));
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, width: rect.width, height: rect.height };
}

function drawGoalTrend(points, selectedIndex = null) {
  const canvas = $("goalTrendChart");
  const empty = $("trendEmptyText");
  const { ctx, width, height } = resizeCanvas(canvas);

  ctx.clearRect(0, 0, width, height);

  if (!points || !points.length) {
    empty.classList.remove("hidden");
    return;
  }

  empty.classList.add("hidden");

  const padL = 58;
  const padR = 18;
  const padT = 18;
  const padB = 36;
  const chartW = Math.max(1, width - padL - padR);
  const chartH = Math.max(1, height - padT - padB);

  const values = points.map(p => Number(p.value) || 0);
  let min = Math.min(...values);
  let max = Math.max(...values);

  if (min === max) {
    const pad = Math.max(Math.abs(max) * 0.1, 1000);
    min -= pad;
    max += pad;
  } else {
    const pad = (max - min) * 0.12;
    min -= pad;
    max += pad;
  }

  const xFor = i => {
    if (points.length === 1) return padL + chartW / 2;
    return padL + (chartW * i) / (points.length - 1);
  };

  const yFor = v => padT + chartH - ((v - min) / (max - min)) * chartH;

  ctx.lineWidth = 1;
  ctx.strokeStyle = "#e5e5ea";
  ctx.fillStyle = "#8e8e93";
  ctx.font = "11px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";

  const gridCount = 4;
  for (let i = 0; i <= gridCount; i++) {
    const y = padT + (chartH * i) / gridCount;
    const val = max - ((max - min) * i) / gridCount;

    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(width - padR, y);
    ctx.stroke();

    ctx.fillText(formatAxisMoney(val), padL - 8, y);
  }

  ctx.strokeStyle = "#007aff";
  ctx.lineWidth = 2.5;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  if (points.length >= 2) {
    ctx.beginPath();
    points.forEach((p, i) => {
      const x = xFor(i);
      const y = yFor(p.value);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  ctx.fillStyle = "#8e8e93";
  ctx.font = "11px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
  ctx.textBaseline = "top";

  if (points.length === 1) {
    ctx.textAlign = "center";
    ctx.fillText(formatDisplayDate(points[0].date), xFor(0), height - padB + 14);
  } else {
    ctx.textAlign = "left";
    ctx.fillText(formatDisplayDate(points[0].date), padL, height - padB + 14);
    ctx.textAlign = "right";
    ctx.fillText("今天", width - padR, height - padB + 14);
  }

  if (selectedIndex !== null && points[selectedIndex]) {
  const selected = points[selectedIndex];
  const sx = xFor(selectedIndex);
  const sy = yFor(selected.value);

  ctx.strokeStyle = "#8e8e93";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(sx, padT);
  ctx.lineTo(sx, padT + chartH);
  ctx.stroke();

  ctx.beginPath();
  ctx.fillStyle = "#ffffff";
  ctx.arc(sx, sy, 6, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = "#007aff";
  ctx.stroke();

  ctx.fillStyle = "#1c1c1e";
  ctx.font = "12px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
  ctx.textAlign = sx > width - 90 ? "right" : "left";
  ctx.textBaseline = "bottom";
  ctx.fillText(
    formatMoney(selected.value),
    sx + (sx > width - 90 ? -8 : 8),
    sy - 8
  );

  ctx.fillStyle = "#1c1c1e";
  ctx.font = "12px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.fillText(formatDisplayDate(selected.date), sx, padT + chartH + 8);
}

  if (selectedIndex === null) {
    const last = points[points.length - 1];
    const lastX = xFor(points.length - 1);
    const lastY = yFor(last.value);

    ctx.fillStyle = "#1c1c1e";
    ctx.font = "12px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
    ctx.textAlign = lastX > width - 90 ? "right" : "left";
    ctx.textBaseline = "bottom";
    ctx.fillText(
      formatMoney(last.value),
      lastX + (ctx.textAlign === "right" ? -8 : 8),
      lastY - 8
    );
  }
}

async function renderTrend() {
  if (!currentGoal) return;

  const startISO = $("trendStartDate").value || addDaysISO(todayISO(), -30);
  const today = todayISO();

  const rawPoints = await buildTrendData(currentGoal, startISO);
  currentTrendPoints = expandTrendPointsDaily(rawPoints, startISO > today ? today : startISO, today);

  if (selectedTrendIndex !== null) {
    selectedTrendIndex = Math.min(selectedTrendIndex, currentTrendPoints.length - 1);
  }

  drawGoalTrend(currentTrendPoints, selectedTrendIndex);
}

function bindTrendTouch() {
  const canvas = $("goalTrendChart");
  if (!canvas) return;

  function updateSelectedByClientX(clientX) {
    if (!currentTrendPoints.length) return;

    const rect = canvas.getBoundingClientRect();

    const padL = 58;
    const padR = 18;
    const chartW = Math.max(1, rect.width - padL - padR);

    let x = clientX - rect.left;
    x = Math.min(rect.width - padR, Math.max(padL, x));

    let index;

    if (currentTrendPoints.length === 1) {
      index = 0;
    } else {
      index = Math.round(((x - padL) / chartW) * (currentTrendPoints.length - 1));
    }

    index = Math.max(0, Math.min(currentTrendPoints.length - 1, index));

    selectedTrendIndex = index;
    drawGoalTrend(currentTrendPoints, selectedTrendIndex);
  }

  canvas.addEventListener("pointerdown", e => {
    canvas.setPointerCapture(e.pointerId);
    updateSelectedByClientX(e.clientX);
    e.preventDefault();
  });

  canvas.addEventListener("pointermove", e => {
    if (e.buttons !== 1 && e.pointerType !== "touch") return;
    updateSelectedByClientX(e.clientX);
    e.preventDefault();
  });

  canvas.addEventListener("pointerup", e => {
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch {}
  });
}

async function initTrendPage() {
  await ready;

  const goalId = getQueryGoalId();
  if (!goalId) {
    $("trendTitle").textContent = "找不到目標";
    drawGoalTrend([]);
    return;
  }

  currentGoal = await idb.get(goalDb, "goals", goalId);

  if (!currentGoal) {
    $("trendTitle").textContent = "找不到目標";
    drawGoalTrend([]);
    return;
  }

  const today = todayISO();
  $("trendTitle").textContent = currentGoal.name || "目標趨勢";
  $("trendTodayText").textContent = formatDisplayDate(today);
  $("trendStartDate").max = today;
  $("trendStartDate").value = addDaysISO(today, -30);
  $("trendStartDate").addEventListener("change", () => {
    selectedTrendIndex = null;
    renderTrend();
  });

  bindTrendTouch();

  await renderTrend();
}

window.addEventListener("resize", () => {
  if (currentGoal) renderTrend();
});

initTrendPage().catch(err => {
  console.error(err);
  $("trendTitle").textContent = "載入失敗";
  $("trendEmptyText").textContent = "趨勢資料載入失敗";
  $("trendEmptyText").classList.remove("hidden");
});
