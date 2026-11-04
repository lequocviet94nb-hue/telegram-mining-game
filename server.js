const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// === CẤU HÌNH TỪ BIẾN MÔI TRƯỜNG ===
const BOT_TOKEN = process.env.BOT_TOKEN;
const MONETAG_LINK = process.env.MONETAG_LINK;
const SECRET_KEY = process.env.SECRET_KEY || 'mysecret123';

// === HỆ THỐNG LƯU TRỮ VĨNH VIỄN (DATABASE FILE) ===
const DB_FILE = path.join(__dirname, 'database.json');

function loadDB() {
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ users: {}, claims: {} }, null, 2));
  }
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (e) {
    return { users: {}, claims: {} };
  }
}

function saveDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// 1. Xác thực chữ ký Telegram (Chống hack F12)
function verifyTelegram(initDataStr) {
  if (!initDataStr) return false;
  try {
    const params = new URLSearchParams(initDataStr);
    const hash = params.get('hash');
    params.delete('hash');

    const arr = [];
    for (const [k, v] of params.entries()) arr.push(`${k}=${v}`);
    arr.sort();
    const dataCheckStr = arr.join('\n');

    const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const calculatedHash = crypto.createHmac('sha256', secret).update(dataCheckStr).digest('hex');

    return calculatedHash === hash;
  } catch (e) {
    return false;
  }
}

// 2. Tính toán số dư in tiền trên server
function calculateBalance(user) {
  const now = Math.floor(Date.now() / 1000);
  const effectiveEnd = Math.min(now, user.fuel_expires_at);
  const runningSecs = Math.max(0, effectiveEnd - user.last_collected_at);

  if (runningSecs > 0) {
    user.balance += runningSecs * user.rate_per_sec;
    user.last_collected_at = effectiveEnd;
  }
  return user;
}

// 3. API: Đăng ký tài khoản mới cho người chơi
app.post('/api/register', (req, res) => {
  const { initData, username, pin } = req.body;
  if (!verifyTelegram(initData)) return res.status(403).json({ error: 'Auth failed' });

  if (!username || username.trim().length < 3) {
    return res.status(400).json({ error: 'Tên tài khoản phải có ít nhất 3 ký tự!' });
  }
  if (!pin || pin.trim().length < 4) {
    return res.status(400).json({ error: 'Mã PIN bảo mật phải từ 4 số trở lên!' });
  }

  const params = new URLSearchParams(initData);
  const tgUser = JSON.parse(params.get('user'));
  const tgId = String(tgUser.id);

  const db = loadDB();

  // Kiểm tra xem telegram này đã đăng ký chưa
  if (db.users[tgId]) {
    return res.status(400).json({ error: 'Tài khoản Telegram này đã đăng ký rồi!' });
  }

  // Kiểm tra trùng tên tài khoản với người khác
  const isNameTaken = Object.values(db.users).some(u => u.username.toLowerCase() === username.trim().toLowerCase());
  if (isNameTaken) {
    return res.status(400).json({ error: 'Tên tài khoản này đã có người dùng, vui lòng chọn tên khác!' });
  }

  const now = Math.floor(Date.now() / 1000);
  db.users[tgId] = {
    telegram_id: tgId,
    username: username.trim(),
    pin: pin.trim(),
    balance: 0,
    fuel_expires_at: now,
    last_collected_at: now,
    rate_per_sec: 0.0000003,
    created_at: now
  };

  saveDB(db);
  return res.json({ success: true, message: 'Đăng ký tài khoản thành công!' });
});

// 4. API: Lấy trạng thái tài khoản (Kiểm tra đã đăng ký hay chưa)
app.post('/api/user-status', (req, res) => {
  const { initData } = req.body;
  if (!verifyTelegram(initData)) return res.status(403).json({ error: 'Auth failed' });

  const params = new URLSearchParams(initData);
  const tgUser = JSON.parse(params.get('user'));
  const tgId = String(tgUser.id);

  const db = loadDB();
  const user = db.users[tgId];

  // Nếu chưa đăng ký -> Bắt buộc ra màn hình tạo tài khoản
  if (!user) {
    return res.json({ success: true, is_registered: false });
  }

  // Đã đăng ký -> Cập nhật số dư và trả về dữ liệu
  calculateBalance(user);
  saveDB(db);

  return res.json({
    success: true,
    is_registered: true,
    username: user.username,
    balance: user.balance,
    fuel_expires_at: user.fuel_expires_at,
    rate_per_sec: user.rate_per_sec
  });
});

// 5. API: Tạo phiên xem quảng cáo Monetag
app.post('/api/create-ad-session', (req, res) => {
  const { initData } = req.body;
  if (!verifyTelegram(initData)) return res.status(403).json({ error: 'Auth failed' });

  const params = new URLSearchParams(initData);
  const tgUser = JSON.parse(params.get('user'));
  const tgId = String(tgUser.id);

  const db = loadDB();
  if (!db.users[tgId]) {
    return res.status(400).json({ error: 'Vui lòng đăng ký tài khoản trước!' });
  }

  const clickId = uuidv4();
  db.claims[clickId] = {
    telegram_id: tgId,
    created_at: Date.now(),
    status: 'PENDING'
  };
  saveDB(db);

  // Link Direct link gắn ymid/sub_id_1 = clickId
  const adUrl = `${MONETAG_LINK}?sub_id_1=${clickId}&ymid=${clickId}`;
  return res.json({ success: true, adUrl });
});

// 6. API: Monetag Postback Webhook
app.get('/api/postback', (req, res) => {
  const { click_id, secret } = req.query;

  if (secret !== SECRET_KEY) return res.status(403).send('Forbidden: Sai Secret');

  const db = loadDB();
  const claim = db.claims[click_id];

  if (!claim) return res.status(404).send('Not found');
  if (claim.status !== 'PENDING') return res.status(400).send('Already claimed');

  // Chống bot: Xem tối thiểu 10 giây
  if ((Date.now() - claim.created_at) < 10000) {
    return res.status(400).send('Invalid watch time');
  }

  claim.status = 'COMPLETED';

  const user = db.users[claim.telegram_id];
  if (user) {
    const now = Math.floor(Date.now() / 1000);
    calculateBalance(user);

    // Cộng dồn 10 phút (600s)
    if (user.fuel_expires_at > now) {
      user.fuel_expires_at += 600;
    } else {
      user.fuel_expires_at = now + 600;
      user.last_collected_at = now;
    }
  }

  saveDB(db);
  console.log(`[OK] Cộng 10 phút cho user: ${claim.telegram_id}`);
  return res.send('OK');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server chạy tại cổng: ${PORT}`));
