import express from 'express';
import Database from 'better-sqlite3';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const db = new Database('cooperative.db');

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Database schema
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    role TEXT NOT NULL,
    service TEXT,
    area TEXT,
    base_rate INTEGER DEFAULT 250,
    id_type TEXT,
    id_number TEXT,
    is_verified INTEGER DEFAULT 0,
    is_available INTEGER DEFAULT 1,
    rating REAL DEFAULT 5.0,
    rating_count INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER,
    customer_name TEXT,
    provider_id INTEGER,
    provider_name TEXT,
    service TEXT,
    amount INTEGER DEFAULT 250,
    otp TEXT,
    status TEXT DEFAULT 'Pending',
    rating INTEGER DEFAULT NULL,
    customer_lat REAL DEFAULT 13.1189,
    customer_lng REAL DEFAULT 80.1018,
    provider_lat REAL DEFAULT NULL,
    provider_lng REAL DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Auto-migrate schema columns
try {
  const userCols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
  if (!userCols.includes('base_rate')) db.exec("ALTER TABLE users ADD COLUMN base_rate INTEGER DEFAULT 250");
  if (!userCols.includes('id_type')) db.exec("ALTER TABLE users ADD COLUMN id_type TEXT");
  if (!userCols.includes('id_number')) db.exec("ALTER TABLE users ADD COLUMN id_number TEXT");
  if (!userCols.includes('is_verified')) db.exec("ALTER TABLE users ADD COLUMN is_verified INTEGER DEFAULT 0");
  if (!userCols.includes('is_available')) db.exec("ALTER TABLE users ADD COLUMN is_available INTEGER DEFAULT 1");
  if (!userCols.includes('rating')) db.exec("ALTER TABLE users ADD COLUMN rating REAL DEFAULT 5.0");
  if (!userCols.includes('rating_count')) db.exec("ALTER TABLE users ADD COLUMN rating_count INTEGER DEFAULT 1");

  const orderCols = db.prepare("PRAGMA table_info(orders)").all().map(c => c.name);
  if (!orderCols.includes('rating')) db.exec("ALTER TABLE orders ADD COLUMN rating INTEGER DEFAULT NULL");
  if (!orderCols.includes('customer_lat')) db.exec("ALTER TABLE orders ADD COLUMN customer_lat REAL DEFAULT 13.1189");
  if (!orderCols.includes('customer_lng')) db.exec("ALTER TABLE orders ADD COLUMN customer_lng REAL DEFAULT 80.1018");
  if (!orderCols.includes('provider_lat')) db.exec("ALTER TABLE orders ADD COLUMN provider_lat REAL DEFAULT NULL");
  if (!orderCols.includes('provider_lng')) db.exec("ALTER TABLE orders ADD COLUMN provider_lng REAL DEFAULT NULL");
  if (!orderCols.includes('created_at')) db.exec("ALTER TABLE orders ADD COLUMN created_at DATETIME DEFAULT CURRENT_TIMESTAMP");
} catch (e) {
  console.log("Migration notice:", e.message);
}

function validateId(type, number) {
  if (type === 'aadhaar') {
    const clean = number.replace(/\s+/g, '');
    return /^\d{12}$/.test(clean);
  } else if (type === 'pan') {
    return /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/.test(number.toUpperCase());
  }
  return false;
}

function maskId(type, number) {
  const clean = number.replace(/\s+/g, '').toUpperCase();
  if (type === 'aadhaar') {
    return `[Aadhaar Redacted]`;
  } else {
    return `${clean.slice(0, 2)}XXXXX${clean.slice(-3)}`;
  }
}

// 1. Auth APIs
app.post('/api/register', (req, res) => {
  const { name, email, role, service, area, base_rate, id_type, id_number } = req.body;
  let maskedId = null;
  let isVerified = 0;
  const rate = parseInt(base_rate) || 250;

  if (role === 'provider') {
    if (!id_type || !id_number) {
      return res.status(400).json({ error: 'Identity verification is required for onboarding.' });
    }
    if (!validateId(id_type, id_number)) {
      return res.status(400).json({ 
        error: id_type === 'aadhaar' 
          ? 'Invalid format. Must be 12 numeric digits.' 
          : 'Invalid PAN format. Standard: ABCDE1234F' 
      });
    }
    maskedId = maskId(id_type, id_number);
    isVerified = 1;
  }

  try {
    const stmt = db.prepare(`
      INSERT INTO users (name, email, role, service, area, base_rate, id_type, id_number, is_verified) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const info = stmt.run(name, email, role, service || null, area || null, rate, id_type || null, maskedId, isVerified);
    res.json(db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid));
  } catch (err) {
    res.status(400).json({ error: 'User with this email already exists' });
  }
});

app.post('/api/login', (req, res) => {
  const { email } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user) return res.status(404).json({ error: 'User not found. Please register first.' });
  res.json(user);
});

// 2. Fetch providers
app.get('/api/providers', (req, res) => {
  const providers = db.prepare(`
    SELECT u.id, u.name, u.service, u.area, u.base_rate, u.id_type, u.id_number, u.is_verified, u.is_available, u.rating, u.rating_count,
      (SELECT COUNT(*) FROM orders o WHERE o.provider_id = u.id AND o.status IN ('Accepted', 'Completed')) as jobs_today
    FROM users u
    WHERE u.role = 'provider'
  `).all();

  providers.sort((a, b) => {
    if (a.is_available !== b.is_available) return b.is_available - a.is_available;
    const scoreA = (a.rating * 2) - (a.jobs_today * 1.5);
    const scoreB = (b.rating * 2) - (b.jobs_today * 1.5);
    return scoreB - scoreA;
  });

  res.json(providers);
});

// 3. Worker custom rate update
app.post('/api/provider/rate', (req, res) => {
  const { provider_id, base_rate } = req.body;
  const rate = parseInt(base_rate);
  if (!rate || rate < 50) {
    return res.status(400).json({ error: 'Please enter a valid rate (minimum ₹50).' });
  }
  db.prepare('UPDATE users SET base_rate = ? WHERE id = ?').run(rate, provider_id);
  const updatedUser = db.prepare('SELECT * FROM users WHERE id = ?').get(provider_id);
  res.json({ success: true, base_rate: rate, user: updatedUser });
});

// 4. Availability Toggle
app.post('/api/provider/availability', (req, res) => {
  const { provider_id, is_available } = req.body;
  const val = is_available ? 1 : 0;
  db.prepare('UPDATE users SET is_available = ? WHERE id = ?').run(val, provider_id);
  res.json({ success: true, is_available: val });
});

// 5. Booking Flow with Geo Coordinates
app.post('/api/book', (req, res) => {
  const { customer_id, customer_name, provider_id, provider_name, service, customer_lat, customer_lng } = req.body;
  const provider = db.prepare('SELECT base_rate FROM users WHERE id = ?').get(provider_id);
  const amount = provider ? (provider.base_rate || 250) : 250;
  const otp = Math.floor(1000 + Math.random() * 9000).toString();

  const lat = customer_lat || 13.1189;
  const lng = customer_lng || 80.1018;

  db.prepare(`
    INSERT INTO orders (customer_id, customer_name, provider_id, provider_name, service, amount, otp, status, customer_lat, customer_lng)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'Pending', ?, ?)
  `).run(customer_id, customer_name, provider_id, provider_name, service, amount, otp, lat, lng);

  res.json({ success: true, message: `Job booked with ${provider_name} at ₹${amount}` });
});

// 6. Live Location Streaming Endpoint
app.post('/api/orders/track', (req, res) => {
  const { order_id, provider_lat, provider_lng } = req.body;
  db.prepare('UPDATE orders SET provider_lat = ?, provider_lng = ? WHERE id = ?')
    .run(provider_lat, provider_lng, order_id);
  res.json({ success: true });
});

// 7. Orders Queries
app.get('/api/orders/customer/:id', (req, res) => {
  res.json(db.prepare('SELECT * FROM orders WHERE customer_id = ? ORDER BY id DESC').all(req.params.id));
});

app.get('/api/orders/provider/:id', (req, res) => {
  res.json(db.prepare('SELECT * FROM orders WHERE provider_id = ? ORDER BY id DESC').all(req.params.id));
});

app.post('/api/orders/status', (req, res) => {
  const { order_id, status } = req.body;
  db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, order_id);
  res.json({ success: true });
});

app.post('/api/orders/complete', (req, res) => {
  const { order_id, otp } = req.body;
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(order_id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (order.otp !== otp) return res.status(400).json({ error: 'Invalid completion OTP' });

  db.prepare("UPDATE orders SET status = 'Completed' WHERE id = ?").run(order_id);
  res.json({ success: true, message: 'Job verified and completed' });
});

app.post('/api/orders/rate', (req, res) => {
  const { order_id, provider_id, rating } = req.body;
  db.prepare('UPDATE orders SET rating = ? WHERE id = ?').run(rating, order_id);

  const p = db.prepare('SELECT rating, rating_count FROM users WHERE id = ?').get(provider_id);
  const newCount = (p.rating_count || 0) + 1;
  const newRating = Number((((p.rating * (newCount - 1)) + rating) / newCount).toFixed(1));

  db.prepare('UPDATE users SET rating = ?, rating_count = ? WHERE id = ?').run(newRating, newCount, provider_id);
  res.json({ success: true, newRating });
});

// 8. Admin Metrics
app.get('/api/admin/metrics', (req, res) => {
  const totalOrders = db.prepare('SELECT COUNT(*) as count FROM orders').get().count;
  const completedOrders = db.prepare("SELECT * FROM orders WHERE status = 'Completed'").all();
  
  const grossVolume = completedOrders.reduce((sum, o) => sum + (o.amount || 0), 0);
  const totalWelfareFund = Math.round(grossVolume * 0.02);
  const totalWorkerPayout = Math.round(grossVolume * 0.98);

  const totalWorkers = db.prepare("SELECT COUNT(*) as count FROM users WHERE role = 'provider'").get().count;
  const verifiedWorkers = db.prepare("SELECT COUNT(*) as count FROM users WHERE role = 'provider' AND is_verified = 1").get().count;
  const activeWorkers = db.prepare("SELECT COUNT(*) as count FROM users WHERE role = 'provider' AND is_available = 1").get().count;

  const workerWorkloads = db.prepare(`
    SELECT u.name, u.area, u.service, u.base_rate, u.is_available, u.is_verified, u.id_type, u.id_number, u.rating,
           COUNT(o.id) as completed_jobs,
           COALESCE(SUM(CASE WHEN o.status = 'Completed' THEN o.amount ELSE 0 END), 0) as total_earned
    FROM users u
    LEFT JOIN orders o ON u.id = o.provider_id AND o.status = 'Completed'
    WHERE u.role = 'provider'
    GROUP BY u.id
  `).all();

  const auditLogs = db.prepare(`
    SELECT id, customer_name, provider_name, service, amount, status, customer_lat, customer_lng, created_at
    FROM orders
    ORDER BY id DESC
    LIMIT 15
  `).all();

  res.json({
    grossVolume,
    totalWelfareFund,
    totalWorkerPayout,
    totalOrders,
    completedCount: completedOrders.length,
    totalWorkers,
    verifiedWorkers,
    activeWorkers,
    workerWorkloads,
    auditLogs
  });
});

const PORT = 3000;
app.listen(PORT, () => console.log(`Backend running on http://localhost:${PORT}`));