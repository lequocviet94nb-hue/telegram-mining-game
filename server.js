const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// === CẤU HÌNH BIẾN MÔI TRƯỜNG ===
const BOT_TOKEN = process.env.BOT_TOKEN;
const MONETAG_LINK = process.env.MONETAG_LINK;
const SECRET_KEY = process.env.SECRET_KEY || 'mysecret123';

const RATE_PER_SEC_VND = 0.01;
const MIN_WATCH_TIME_MS = 15000; // 15 giây tối thiểu

// === DATABASE LƯU TRỮ VĨNH VIỄN ===
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

// 1. Xác thực bảo mật chữ ký Telegram
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

// 2. Tính tiền đào tự động trên Server
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

// 3. API: Đăng ký tài khoản mới
app.post('/api/register', (req, res) => {
  const { initData, username, pin } = req.body;
  if (!verifyTelegram(initData)) return res.status(403).json({ error: 'Auth failed' });

  if (!username || username.trim().length < 3) {
    return res.status(400).json({ error: 'Tên tài khoản phải từ 3 ký tự trở lên!' });
  }
  if (!pin || pin.trim().length < 4) {
    return res.status(400).json({ error: 'Mã PIN bảo mật phải từ 4 số trở lên!' });
  }

  const params = new URLSearchParams(initData);
  const tgUser = JSON.parse(params.get('user'));
  const tgId = String(tgUser.id);

  const db = loadDB();
  if (db.users[tgId]) {
    return res.status(400).json({ error: 'Tài khoản Telegram này đã đăng ký rồi!' });
  }

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
    rate_per_sec: RATE_PER_SEC_VND,
    created_at: now
  };

  saveDB(db);
  return res.json({ success: true });
});

// 4. API: Lấy thông tin tài khoản
app.post('/api/user-status', (req, res) => {
  const { initData } = req.body;
  if (!verifyTelegram(initData)) return res.status(403).json({ error: 'Auth failed' });

  const params = new URLSearchParams(initData);
  const tgUser = JSON.parse(params.get('user'));
  const tgId = String(tgUser.id);

  const db = loadDB();
  const user = db.users[tgId];

  if (!user) {
    return res.json({ success: true, is_registered: false });
  }

  user.rate_per_sec = RATE_PER_SEC_VND;
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

// 5. API: Tạo phiên xem quảng cáo nội bộ
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
    status: 'WATCHING'
  };
  saveDB(db);

  const adUrl = `${MONETAG_LINK}?sub_id_1=${clickId}&ymid=${clickId}`;
  return res.json({ success: true, adUrl, clickId });
});

// 6. API: Người chơi bấm nút 'X' để xác nhận nhận thưởng
app.post('/api/claim-reward', (req, res) => {
  const { initData, clickId } = req.body;
  if (!verifyTelegram(initData)) return res.status(403).json({ error: 'Auth failed' });

  const params = new URLSearchParams(initData);
  const tgUser = JSON.parse(params.get('user'));
  const tgId = String(tgUser.id);

  const db = loadDB();
  const claim = db.claims[clickId];

  if (!claim || claim.telegram_id !== tgId) {
    return res.status(404).json({ success: false, message: 'Phiên quảng cáo không tồn tại!' });
  }

  if (claim.status === 'COMPLETED') {
    return res.status(400).json({ success: false, message: 'Phần thưởng này đã nhận rồi!' });
  }

  // Chống gian lận: Kiểm tra nếu chưa xem đủ 15 giây
  const elapsed = Date.now() - claim.created_at;
  if (elapsed < MIN_WATCH_TIME_MS) {
    return res.status(400).json({ success: false, message: 'Bạn chưa xem đủ 15 giây quảng cáo!' });
  }

  // Đủ điều kiện: Cộng 10 phút (600s)
  claim.status = 'COMPLETED';

  const user = db.users[tgId];
  if (user) {
    const now = Math.floor(Date.now() / 1000);
    calculateBalance(user);

    if (user.fuel_expires_at > now) {
      user.fuel_expires_at += 600;
    } else {
      user.fuel_expires_at = now + 600;
      user.last_collected_at = now;
    }
  }

  saveDB(db);
  console.log(`[OK] Người chơi ${tgId} đã xem đủ và bấm nút X nhận +10 phút`);
  return res.json({ success: true, message: 'Đã cộng +10 phút nhiên liệu thành công!' });
});

// 7. API: Webhook Postback Monetag (Đồng bộ ngầm)
app.get('/api/postback', (req, res) => {
  const { click_id, secret } = req.query;
  if (secret !== SECRET_KEY) return res.status(403).send('Forbidden');

  const db = loadDB();
  const claim = db.claims[click_id];

  if (claim && claim.status !== 'COMPLETED') {
    const elapsed = Date.now() - claim.created_at;
    if (elapsed >= MIN_WATCH_TIME_MS) {
      claim.status = 'COMPLETED';
      const user = db.users[claim.telegram_id];
      if (user) {
        const now = Math.floor(Date.now() / 1000);
        calculateBalance(user);
        if (user.fuel_expires_at > now) user.fuel_expires_at += 600;
        else user.fuel_expires_at = now + 600;
      }
      saveDB(db);
    }
  }
  return res.send('OK');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server chạy tại cổng: ${PORT}`));
