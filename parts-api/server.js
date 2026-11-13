const express = require('express');
const helmet = require('helmet');
const fs = require('fs');
const readline = require('readline');
const iconv = require('iconv-lite');

const PORT = process.env.PORT || 8080;
const DATA_FILE = process.env.DATA_FILE || './LE.txt';
const ENCODING = 'win1257'; // file has Estonian/Lithuanian chars (õ, š, ž) in a legacy encoding
const PAGE_SIZE = 30;


// Column layout of LE.txt (tab separated, every field in "quotes", no header row)
const COL = {
  serial: 0,
  name: 1,
  stock: [2, 3, 4, 5, 6], // five quantity columns (meaning unclear - ask teacher)
  cost: 8,                // purchase price, comma decimal
  brand: 9,
  price: 10               // sale price (= cost * 1.2, looks like VAT included)
};

const app = express();
app.use(helmet());

let ready = false;
let loadedRows = 0;
let views = { name: [], price: [], serial: [] };

const unquote = (s = '') => s.replace(/^"|"$/g, '');
const clean = (s) => unquote(s).replace(/[\u0000-\u001f]/g, '').trim();
const toNum = (s) => {
  const n = parseFloat(unquote(s).replace(',', '.'));
  return Number.isNaN(n) ? null : n;
};
const round2 = (n) => (n === null ? null : Math.round(n * 100) / 100);

async function loadData(file) {
  const rows = [];
  const rl = readline.createInterface({
    input: fs.createReadStream(file).pipe(iconv.decodeStream(ENCODING)),
    crlfDelay: Infinity
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    const c = line.split('\t');
    if (c.length < 11) continue; // skip malformed rows

    const serial = clean(c[COL.serial]);
    const name = clean(c[COL.name]);
    rows.push({
      serial,
      name,
      stock: COL.stock.map((i) => toNum(c[i]) ?? 0),
      cost: round2(toNum(c[COL.cost])),
      brand: unquote(c[COL.brand]),
      price: round2(toNum(c[COL.price])),
      _s: serial.toLowerCase(),
      _n: name.toLowerCase()
    });
  }

  // Sort once at load time; filtering a sorted array keeps it sorted
  const newViews = {
    serial: [...rows].sort((a, b) => (a._s < b._s ? -1 : a._s > b._s ? 1 : 0)),
    name: [...rows].sort((a, b) => a._n.localeCompare(b._n)),
    price: [...rows].sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity))
  };
  views = newViews; // atomic swap
  loadedRows = rows.length;
  ready = true;
  console.log(`Loaded ${rows.length} parts`);
}

// GET /api/parts?name=laager&serial=0054&sort=price&order=asc&page=1
app.get('/api/parts', (req, res) => {
  if (!ready) return res.status(503).json({ error: 'Data is still loading, try again shortly' });

  const name = String(req.query.name || '').trim().toLowerCase();
  const serial = String(req.query.serial || '').trim().toLowerCase();
  const sort = ['name', 'serial', 'price'].includes(req.query.sort) ? req.query.sort : 'serial';
  const desc = req.query.order === 'desc';
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);

  const src = views[sort];
  const n = src.length;
  const start = (page - 1) * PAGE_SIZE;
  const items = [];
  let total = 0;

  for (let k = 0; k < n; k++) {
    const row = src[desc ? n - 1 - k : k];
    if (name && !row._n.includes(name)) continue;
    if (serial && !row._s.includes(serial)) continue;
    if (total >= start && items.length < PAGE_SIZE) {
      items.push({ serial: row.serial, name: row.name, brand: row.brand, stock: row.stock, cost: row.cost, price: row.price });
    }
    total++;
  }

  res.json({ page, pageSize: PAGE_SIZE, total, totalPages: Math.ceil(total / PAGE_SIZE), items });
});

app.get('/health', (req, res) => res.json({ ready, rows: loadedRows }));

app.listen(PORT, '0.0.0.0', () => console.log(`Parts API on http://localhost:${PORT}`));
loadData(DATA_FILE).catch((err) => { console.error('Load failed:', err); process.exit(1); });