const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
const db = new Database('cooperative.db');

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Initialize database tables with schema migrations
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    phone TEXT,
    address TEXT,
    role TEXT NOT NULL,
    service TEXT,
    area TEXT,
    base_rate INTEGER DEFAULT 250,
    is_available INTEGER DEFAULT 1,
    rating REAL DEFAULT 5.0,
    rating_count INTEGER DEFAULT 1,
    jobs_today INTEGER DEFAULT 0,
    is_verified INTEGER DEFAULT 0,
    id_type TEXT,
    id_number_masked TEXT,
    lat REAL,
    lng REAL
  );

  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER,
    customer_name TEXT,
    customer_phone TEXT,
    customer_address TEXT,
    provider_id INTEGER,
    provider_name TEXT,
    service TEXT,
    amount INTEGER,
    status TEXT DEFAULT 'Pending',
    otp TEXT,
    customer_lat REAL,
    customer_lng REAL,
    provider_lat REAL,
    provider_lng REAL,
    rating INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Safe column migrations in case older cooperative.db exists
const userCols = db.prepare(`PRAGMA table_info(users)`).all().map(c => c.name);
if (!userCols.includes('phone')) db.prepare(`ALTER TABLE users ADD COLUMN phone TEXT`).run();
if (!userCols.includes('address')) db.prepare(`ALTER TABLE users ADD COLUMN address TEXT`).run();
if (!userCols.includes('lat')) db.prepare(`ALTER TABLE users ADD COLUMN lat REAL`).run();
if (!userCols.includes('lng')) db.prepare(`ALTER TABLE users ADD COLUMN lng REAL`).run();

const orderCols = db.prepare(`PRAGMA table_info(orders)`).all().map(c => c.name);
if (!orderCols.includes('customer_phone')) db.prepare(`ALTER TABLE orders ADD COLUMN customer_phone TEXT`).run();
if (!orderCols.includes('customer_address')) db.prepare(`ALTER TABLE orders ADD COLUMN customer_address TEXT`).run();

// Seed initial verified workers if table is empty
const workerCount = db.prepare(`SELECT COUNT(*) AS count FROM users WHERE role = 'provider'`).get().count;
if (workerCount === 0) {
  const seed = db.prepare(`
    INSERT INTO users (name, email, phone, role, service, area, base_rate, is_available, rating, rating_count, jobs_today, is_verified, id_type, id_number_masked, lat, lng)
    VALUES (?, ?, ?, 'provider', ?, ?, ?, 1, ?, ?, 0, 1, 'aadhaar', 'XXXX-XXXX-8921', ?, ?)
  `);
  seed.run('Kiran S.', 'kiran@avadi.com', '9876543210', 'Electrician', 'Gandhi Nagar', 300, 4.8, 12, 13.1256, 80.1085);
  seed.run('Karthi Ram', 'karthi@avadi.com', '9876543211', 'Plumber', 'Avadi Checkpost', 250, 4.9, 9, 13.1189, 80.1018);
  seed.run('Megaganath V.', 'mega@avadi.com', '9876543212', 'Plumber', 'Gandhi Nagar', 250, 5.0, 5, 13.1270, 80.1100);
}

// Background cleaner: auto-expire orders pending > 90 seconds
setInterval(() => {
  try {
    db.prepare(`
      UPDATE orders 
      SET status = 'Expired' 
      WHERE status = 'Pending' 
      AND (strftime('%s', 'now') - strftime('%s', created_at)) > 90
    `).run();
  } catch (err) {
    console.error('Timeout check error:', err);
  }
}, 3000);

// API: Register
app.post('/api/register', (req, res) => {
  const { name, email, phone, address, role, service, area, base_rate, id_type, id_number, lat, lng } = req.body;
  try {
    let masked = null;
    let verified = 0;
    if (role === 'provider' && id_number) {
      masked = id_number.length > 4 ? 'XXXX-XXXX-' + id_number.slice(-4) : id_number;
      verified = 1;
    }

    const stmt = db.prepare(`
      INSERT INTO users (name, email, phone, address, role, service, area, base_rate, is_verified, id_type, id_number_masked, lat, lng)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const info = stmt.run(name, email, phone || null, address || null, role, service || null, area || null, base_rate || 250, verified, id_type || null, masked, lat || null, lng || null);
    
    const user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(info.lastInsertRowid);
    res.json(user);
  } catch (err) {
    res.status(400).json({ error: 'Email already registered or invalid entry' });
  }
});

// API: Login
app.post('/api/login', (req, res) => {
  const { email } = req.body;
  const user = db.prepare(`SELECT * FROM users WHERE email = ?`).get(email);
  if (!user) return res.status(404).json({ error: 'User not found. Please register first.' });
  res.json(user);
});

// API: Get Providers list
app.get('/api/providers', (req, res) => {
  const providers = db.prepare(`
    SELECT id, name, phone, service, area, base_rate, rating, is_available, jobs_today, is_verified, lat, lng
    FROM users 
    WHERE role = 'provider'
  `).all();
  res.json(providers);
});

// API: Provider rate update
app.post('/api/provider/rate', (req, res) => {
  const { provider_id, base_rate } = req.body;
  db.prepare(`UPDATE users SET base_rate = ? WHERE id = ?`).run(base_rate, provider_id);
  res.json({ success: true, base_rate });
});

// API: Provider availability toggle
app.post('/api/provider/availability', (req, res) => {
  const { provider_id, is_available } = req.body;
  db.prepare(`UPDATE users SET is_available = ? WHERE id = ?`).run(is_available ? 1 : 0, provider_id);
  res.json({ success: true, is_available });
});

// API: Create Booking
app.post('/api/book', (req, res) => {
  const { customer_id, customer_name, customer_phone, customer_address, provider_id, provider_name, service, customer_lat, customer_lng } = req.body;
  
  const provider = db.prepare(`SELECT base_rate, lat, lng FROM users WHERE id = ?`).get(provider_id);
  const amount = provider ? provider.base_rate : 250;
  const otp = Math.floor(1000 + Math.random() * 9000).toString();

  const stmt = db.prepare(`
    INSERT INTO orders (customer_id, customer_name, customer_phone, customer_address, provider_id, provider_name, service, amount, status, otp, customer_lat, customer_lng, provider_lat, provider_lng)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Pending', ?, ?, ?, ?, ?)
  `);

  const info = stmt.run(
    customer_id, customer_name, customer_phone || 'Not given', customer_address || 'Avadi Area',
    provider_id, provider_name, service, amount, otp,
    customer_lat, customer_lng, provider?.lat || null, provider?.lng || null
  );

  res.json({ success: true, orderId: info.lastInsertRowid, message: 'Booking requested! Waiting for worker response (90s window).' });
});

// API: Customer Orders
app.get('/api/orders/customer/:id', (req, res) => {
  const orders = db.prepare(`
    SELECT * FROM orders 
    WHERE customer_id = ? 
    ORDER BY id DESC
  `).all(req.params.id);
  res.json(orders);
});

// API: Provider Orders
app.get('/api/orders/provider/:id', (req, res) => {
  const orders = db.prepare(`
    SELECT * FROM orders 
    WHERE provider_id = ? 
    ORDER BY id DESC
  `).all(req.params.id);
  res.json(orders);
});

// API: Order Status Transition
app.post('/api/orders/status', (req, res) => {
  const { order_id, status } = req.body;
  db.prepare(`UPDATE orders SET status = ? WHERE id = ?`).run(status, order_id);
  res.json({ success: true, status });
});

// API: Complete Order via OTP
app.post('/api/orders/complete', (req, res) => {
  const { order_id, otp } = req.body;
  const order = db.prepare(`SELECT * FROM orders WHERE id = ?`).get(order_id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (order.otp !== otp.trim()) return res.status(400).json({ error: 'Incorrect OTP entered.' });

  db.prepare(`UPDATE orders SET status = 'Completed' WHERE id = ?`).run(order_id);
  db.prepare(`UPDATE users SET jobs_today = jobs_today + 1 WHERE id = ?`).run(order.provider_id);
  res.json({ success: true, message: 'Job successfully verified & completed!' });
});

// API: Worker Tracking Stream
app.post('/api/orders/track', (req, res) => {
  const { order_id, provider_lat, provider_lng } = req.body;
  db.prepare(`UPDATE orders SET provider_lat = ?, provider_lng = ? WHERE id = ?`).run(provider_lat, provider_lng, order_id);
  res.json({ success: true });
});

// API: Rate Order
app.post('/api/orders/rate', (req, res) => {
  const { order_id, provider_id, rating } = req.body;
  db.prepare(`UPDATE orders SET rating = ? WHERE id = ?`).run(rating, order_id);
  
  const p = db.prepare(`SELECT rating, rating_count FROM users WHERE id = ?`).get(provider_id);
  if (p) {
    const newCount = (p.rating_count || 0) + 1;
    const newAvg = Number((((p.rating * (newCount - 1)) + rating) / newCount).toFixed(1));
    db.prepare(`UPDATE users SET rating = ?, rating_count = ? WHERE id = ?`).run(newAvg, newCount, provider_id);
  }
  res.json({ success: true });
});

// API: Federation Metrics
app.get('/api/admin/metrics', (req, res) => {
  const orders = db.prepare(`SELECT * FROM orders ORDER BY id DESC`).all();
  const completed = orders.filter(o => o.status === 'Completed');
  const gmv = completed.reduce((sum, o) => sum + (o.amount || 0), 0);
  const workers = db.prepare(`
    SELECT u.id, u.name, u.service, u.area, u.base_rate, u.rating, u.is_available, u.is_verified,
           COUNT(o.id) as completed_jobs,
           COALESCE(SUM(o.amount), 0) as total_earned
    FROM users u
    LEFT JOIN orders o ON u.id = o.provider_id AND o.status = 'Completed'
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
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Avadi Cooperative app running at http://localhost:${PORT}`);
});