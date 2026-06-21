let db;

const request = indexedDB.open("assetDB", 1);

request.onupgradeneeded = function(e) {
  db = e.target.result;
  db.createObjectStore("store");
};

request.onsuccess = function(e) {
  db = e.target.result;
  loadCash();
};

// 存資料
function saveCash() {
  const value = document.getElementById("cashInput").value;

  const tx = db.transaction("store", "readwrite");
  const store = tx.objectStore("store");

  store.put(value, "cash");

  tx.oncomplete = () => {
    loadCash();
  };
}

// 讀資料
function loadCash() {
  const tx = db.transaction("store", "readonly");
  const store = tx.objectStore("store");

  const req = store.get("cash");

  req.onsuccess = function() {
    document.getElementById("cashDisplay").innerText =
      req.result || 0;
  };
}