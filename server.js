const express = require('express');
const Database = require('better-sqlite3');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// Database setup
const db = new Database(path.join(__dirname, 'cooperative.db'));

// Base tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    role TEXT NOT NULL,
    phone TEXT,
    service TEXT,
    area TEXT,
    address TEXT,
    base_rate INTEGER DEFAULT 250,
    rating REAL DEFAULT 5.0,
    is_available INTEGER DEFAULT 1,
    is_verified INTEGER DEFAULT 1,
    jobs_today INTEGER DEFAULT 0,
    lat REAL,
    lng REAL
  );

  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER,
    customer_name TEXT,
    customer_phone TEXT,
    customer_address TEXT,
    client_lat REAL,
    client_lng REAL,
    provider_id INTEGER,
    provider_name TEXT,
    service TEXT,
    amount INTEGER DEFAULT 250,
    otp TEXT,
    status TEXT DEFAULT 'Requested',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Auto-migrate missing columns safely
const userCols = db.prepare(`PRAGMA table_info(users)`).all().map(c => c.name);
if (!userCols.includes('phone')) db.exec(`ALTER TABLE users ADD COLUMN phone TEXT;`);
if (!userCols.includes('address')) db.exec(`ALTER TABLE users ADD COLUMN address TEXT;`);
if (!userCols.includes('rating')) db.exec(`ALTER TABLE users ADD COLUMN rating REAL DEFAULT 5.0;`);
if (!userCols.includes('base_rate')) db.exec(`ALTER TABLE users ADD COLUMN base_rate INTEGER DEFAULT 250;`);
if (!userCols.includes('is_available')) db.exec(`ALTER TABLE users ADD COLUMN is_available INTEGER DEFAULT 1;`);
if (!userCols.includes('is_verified')) db.exec(`ALTER TABLE users ADD COLUMN is_verified INTEGER DEFAULT 1;`);
if (!userCols.includes('jobs_today')) db.exec(`ALTER TABLE users ADD COLUMN jobs_today INTEGER DEFAULT 0;`);
if (!userCols.includes('lat')) db.exec(`ALTER TABLE users ADD COLUMN lat REAL;`);
if (!userCols.includes('lng')) db.exec(`ALTER TABLE users ADD COLUMN lng REAL;`);

const orderCols = db.prepare(`PRAGMA table_info(orders)`).all().map(c => c.name);
if (!orderCols.includes('customer_phone')) db.exec(`ALTER TABLE orders ADD COLUMN customer_phone TEXT;`);
if (!orderCols.includes('customer_address')) db.exec(`ALTER TABLE orders ADD COLUMN customer_address TEXT;`);
if (!orderCols.includes('client_lat')) db.exec(`ALTER TABLE orders ADD COLUMN client_lat REAL;`);
if (!orderCols.includes('client_lng')) db.exec(`ALTER TABLE orders ADD COLUMN client_lng REAL;`);
if (!orderCols.includes('amount')) db.exec(`ALTER TABLE orders ADD COLUMN amount INTEGER DEFAULT 250;`);

// Background: 90-second auto-expiry
setInterval(() => {
  try {
    const expiredOrders = db.prepare(`
      SELECT id, strftime('%s', 'now') - strftime('%s', created_at) AS elapsed
      FROM orders
      WHERE status = 'Requested'
    `).all();

    for (const ord of expiredOrders) {
      if (ord.elapsed >= 90) {
        db.prepare(`UPDATE orders SET status = 'Expired' WHERE id = ?`).run(ord.id);
      }
    }
  } catch (err) {
    console.error('Timeout check error:', err.message);
  }
}, 5000);

// --- AUTH ROUTES ---

app.post('/api/auth/login', (req, res) => {
  const { email } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (user) {
    res.json({ success: true, user });
  } else {
    res.status(401).json({ success: false, message: 'User not found' });
  }
});

app.post('/api/auth/register', (req, res) => {
  const { name, email, role, phone, service, area, address, base_rate, lat, lng } = req.body;
  try {
    const info = db.prepare(`
      INSERT INTO users (name, email, role, phone, service, area, address, base_rate, lat, lng, is_available, is_verified, jobs_today, rating)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 0, 5.0)
    `).run(name, email, role, phone || '', service || null, area || 'Avadi', address || '', base_rate || 250, lat || 13.1147, lng || 80.1018);

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
    res.json({ success: true, user });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// --- PROVIDER ROUTES ---

app.get('/api/providers', (req, res) => {
  try {
    const providers = db.prepare(`
      SELECT id, name, phone, service, area, address,
             COALESCE(base_rate, 250) AS base_rate,
             COALESCE(rating, 5.0) AS rating,
             COALESCE(is_available, 1) AS is_available,
             COALESCE(is_verified, 1) AS is_verified,
             COALESCE(jobs_today, 0) AS jobs_today,
             lat, lng
      FROM users
      WHERE role = 'provider'
    `).all();
    res.json(providers);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/providers/duty', (req, res) => {
  const { id, is_available } = req.body;
  db.prepare('UPDATE users SET is_available = ? WHERE id = ?').run(is_available ? 1 : 0, id);
  res.json({ success: true });
});

// --- ORDER ROUTES ---

app.post('/api/orders/create', (req, res) => {
  const { customer_id, customer_name, customer_phone, customer_address, client_lat, client_lng, provider_id, provider_name, service, amount } = req.body;
  const otp = Math.floor(1000 + Math.random() * 9000).toString();

  const info = db.prepare(`
    INSERT INTO orders (customer_id, customer_name, customer_phone, customer_address, client_lat, client_lng, provider_id, provider_name, service, amount, otp, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Requested')
  `).run(customer_id, customer_name, customer_phone, customer_address, client_lat, client_lng, provider_id, provider_name, service, amount || 250, otp);

  res.json({ success: true, orderId: info.lastInsertRowid });
});

app.get('/api/orders/provider/:id', (req, res) => {
  try {
    const orders = db.prepare(`SELECT * FROM orders WHERE provider_id = ? ORDER BY id DESC`).all(req.params.id);
    res.json(orders);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/orders/customer/:id', (req, res) => {
  try {
    const orders = db.prepare(`SELECT * FROM orders WHERE customer_id = ? ORDER BY id DESC`).all(req.params.id);
    res.json(orders);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/orders/user/:id', (req, res) => {
  const uid = req.params.id;
  const orders = db.prepare(`
    SELECT * FROM orders
    WHERE customer_id = ? OR provider_id = ?
    ORDER BY id DESC
  `).all(uid, uid);
  res.json(orders);
});

app.post('/api/orders/status', (req, res) => {
  const { order_id, status } = req.body;
  db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, order_id);

  if (status === 'Completed') {
    const ord = db.prepare('SELECT provider_id FROM orders WHERE id = ?').get(order_id);
    if (ord && ord.provider_id) {
      db.prepare('UPDATE users SET jobs_today = COALESCE(jobs_today, 0) + 1 WHERE id = ?').run(ord.provider_id);
    }
  }
  res.json({ success: true });
});

// Rate provider & update running average rating
app.post('/api/orders/rate', (req, res) => {
  const { order_id, rating } = req.body;
  const numRating = parseFloat(rating);

  if (isNaN(numRating) || numRating < 1 || numRating > 5) {
    return res.status(400).json({ success: false, message: 'Rating must be between 1 and 5' });
  }

  try {
    const order = db.prepare('SELECT provider_id FROM orders WHERE id = ?').get(order_id);
    if (!order || !order.provider_id) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    db.prepare(`
      UPDATE users 
      SET rating = ROUND((COALESCE(rating, 5.0) + ?) / 2.0, 1)
      WHERE id = ?
    `).run(numRating, order.provider_id);

    db.prepare(`UPDATE orders SET status = 'Rated' WHERE id = ?`).run(order_id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// --- ADMIN AUDIT ROUTE ---

app.get('/api/admin/metrics', (req, res) => {
  try {
    const orders = db.prepare('SELECT * FROM orders ORDER BY id DESC').all();
    const completed = orders.filter(o => o.status === 'Completed' || o.status === 'Rated');
    const gmv = completed.reduce((sum, o) => sum + (o.amount || 0), 0);

    const workers = db.prepare(`
      SELECT u.id, u.name, u.service, u.area, 
             COALESCE(u.base_rate, 250) AS base_rate, 
             COALESCE(u.rating, 5.0) AS rating, 
             COALESCE(u.is_available, 1) AS is_available, 
             COALESCE(u.is_verified, 1) AS is_verified,
             COUNT(o.id) AS completed_jobs,
             COALESCE(SUM(o.amount), 0) AS total_earned
      FROM users u
      LEFT JOIN orders o ON u.id = o.provider_id AND (o.status = 'Completed' OR o.status = 'Rated')
      WHERE u.role = 'provider'
      GROUP BY u.id
    `).all();

    res.json({
      grossVolume: gmv,
      totalWelfareFund: Math.round(gmv * 0.02),
      totalWorkerPayout: Math.round(gmv * 0.98),
      totalWorkers: workers.length,
      verifiedWorkers: workers.filter(w => w.is_verified === 1).length,
      workerWorkloads: workers,
      auditLogs: orders
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Avadi Cooperative app running at http://localhost:${PORT}`);
});