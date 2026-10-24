// Seeds .hive/tenants/default.db with demo nodes/links for the /graph preview.
// Uses the compiled @hivemind/core schema so column names stay in sync.
const path = require('path');
const fs = require('fs');
const { initializeDatabase } = require(path.resolve(__dirname, '..', 'packages', 'core', 'dist', 'index.js'));

const dbPath = path.resolve('.hive/tenants/default.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.rmSync(dbPath + suffix, { force: true }); } catch {}
}
const db = initializeDatabase(dbPath);

const NOW = Date.now();
const daysAgo = (n) => NOW - n * 86400000;

const ins = db.prepare(
  `INSERT OR REPLACE INTO nodes
   (id, tree, parent, kind, name, filePath, startLine, endLine, status, ver, hash,
    l0, l1, l2, tokL0, tokL1, tokL2, stale, createdAt, updatedAt)
   VALUES (?, 'code', NULL, ?, ?, ?, 1, 40, 'live', 1, 'h', ?, ?, ?, ?, ?, ?, 0, ?, ?)`
);

const rows = [
  {
    row: ['c:app', 'function', 'renderApp', 'packages/web/src/App.tsx',
      'single-page react frontend shell with router, pages, css layout'],
    l1: 'render() mounts pages and wires the css layout for each route',
    l2: 'const App = () => <Router><Pages /><Layout /></Router>; // frontend shell',
    tok: [10, 40, 300], age: 1,
  },
  {
    row: ['c:cart', 'class', 'CartModel', 'packages/core/src/shop/cart.ts',
      'checkout cart model storing order and total cents'],
    l1: 'cart add item updates the order total',
    l2: 'class CartModel { total; add(item) { this.total += item.cents } }',
    tok: [8, 30, 200], age: 9,
  },
  {
    row: ['c:checkout', 'function', 'checkout', 'packages/core/src/shop/checkout.ts',
      'payment checkout flow charges card via gateway and returns receipt'],
    l1: 'checkout(cart, card) validates the order then charges',
    l2: 'function checkout(cart, card) { return gateway.charge(card, cart.total) }',
    tok: [8, 30, 240], age: 2,
  },
  {
    row: ['c:gateway', 'function', 'chargeGateway', 'packages/core/src/shop/gateway.ts',
      'payment gateway charge: card, wallet, transaction reconciliation'],
    l1: 'chargeGateway(card, cents) posts the transaction',
    l2: 'function chargeGateway(card, cents) { return gateway.post({ payment: card, amount: cents }) }',
    tok: [6, 24, 180], age: 20,
  },
  {
    row: ['c:jwt', 'function', 'verifyToken', 'packages/core/src/auth/jwt.ts',
      'jwt auth verify token for login session'],
    l1: 'verifyToken(token) checks signature',
    l2: 'function verifyToken(token) { return jwt.verify(token); } // auth session',
    tok: [6, 24, 160], age: 4,
  },
  {
    row: ['c:dbm', 'class', 'Migration', 'packages/core/src/db.ts',
      'sqlite migration runner creates table schema with column index'],
    l1: 'Migration up/down migrate the database schema',
    l2: 'class Migration { up(db) { db.exec(sql) } down(db) { db.exec(drop) } }',
    tok: [6, 24, 140], age: 30,
  },
];

for (const r of rows) {
  ins.run(r.row[0], r.row[1], r.row[2], r.row[3], r.row[4], r.l1, r.l2,
    r.tok[0], r.tok[1], r.tok[2], daysAgo(r.age), daysAgo(r.age));
}

const L = db.prepare('INSERT OR REPLACE INTO links (src, dst, rel, w) VALUES (?, ?, ?, ?)');
L.run('c:app', 'c:cart', 'imports', 0.8);
L.run('c:app', 'c:jwt', 'calls', 0.7);
L.run('c:checkout', 'c:cart', 'imports', 0.9);
L.run('c:checkout', 'c:gateway', 'calls', 0.95);
L.run('c:cart', 'c:dbm', 'calls', 0.5);
L.run('c:gateway', 'c:dbm', 'calls', 0.6);
L.run('c:jwt', 'c:dbm', 'imports', 0.5);

console.log('seeded:', JSON.stringify({
  nodes: db.prepare('SELECT COUNT(*) c FROM nodes').get().c,
  links: db.prepare('SELECT COUNT(*) c FROM links').get().c,
}));
db.close();
