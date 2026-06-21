let db;

const request = indexedDB.open("assetDB", 1);

request.onupgradeneeded = function(e) {
  db = e.target.result;
  db.createObjectStore("store");
  db.createObjectStore("stocks"); // 股票表
};

request.onsuccess = function(e) {
  db = e.target.result;
  loadCash();
  loadStocks();
};

/* ===== 現金 ===== */

function saveCash() {
  const value = document.getElementById("cashInput").value;

  const tx = db.transaction("store", "readwrite");
  tx.objectStore("store").put(value, "cash");

  tx.oncomplete = loadCash;
}

function loadCash() {
  const tx = db.transaction("store", "readonly");
  const req = tx.objectStore("store").get("cash");

  req.onsuccess = () => {
    document.getElementById("cashDisplay").innerText = req.result || 0;
  };
}

/* ===== 股票 ===== */

function addStock() {
  const name = document.getElementById("stockName").value;
  const qty = Number(document.getElementById("stockQty").value);
  const cost = Number(document.getElementById("stockCost").value);

  const stock = {
    name,
    qty,
    cost
  };

  const tx = db.transaction("stocks", "readwrite");
  tx.objectStore("stocks").add(stock);

  tx.oncomplete = loadStocks;
}

function loadStocks() {
  const tx = db.transaction("stocks", "readonly");
  const store = tx.objectStore("stocks");

  const req = store.getAll();

  req.onsuccess = function() {
    const list = req.result;

    let html = "";

    list.forEach(s => {
      html += `
        <div>
          股票：${s.name} |
          股數：${s.qty} |
          成本：${s.cost}
        </div>
      `;
    });

    document.getElementById("stockList").innerHTML = html;
  };
}
