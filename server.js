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

// Tốc độ: 0.01 VNĐ / giây
const RATE_PER_SEC_VND = 0.01;

// Thời gian xem quảng cáo tối thiểu: 15 Giây (15000 ms)
const MIN_WATCH_TIME_MS = 15000;

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

  const adUrl = `${MONETAG_LINK}?sub_id_1=${clickId}&ymid=${clickId}`;
  return res.json({ success: true, adUrl, clickId });
});

// 6. API MỚI: Game gọi để kiểm tra xem lượt xem quảng cáo có hợp lệ không
app.post('/api/check-ad-status', (req, res) => {
  const { initData, clickId } = req.body;
  if (!verifyTelegram(initData)) return res.status(403).json({ error: 'Auth failed' });

  const db = loadDB();
  const claim = db.claims[clickId];

  if (!claim) {
    return res.json({ success: false, status: 'NOT_FOUND', message: 'Không tìm thấy phiên quảng cáo!' });
  }

  if (claim.status === 'COMPLETED') {
    return res.json({ success: true, status: 'COMPLETED', message: 'Hợp lệ! Đã cộng +10 phút nhiên liệu.' });
  }

  if (claim.status === 'TOO_FAST') {
    return res.json({ success: false, status: 'TOO_FAST', message: 'Bạn tắt quảng cáo quá sớm! Không đủ điều kiện nhận thưởng.' });
  }

  // Nếu vẫn PENDING mà đã quá 40 giây hoặc người dùng quay lại quá sớm
  const elapsed = Date.now() - claim.created_at;
  if (elapsed < MIN_WATCH_TIME_MS) {
    claim.status = 'TOO_FAST';
    saveDB(db);
    return res.json({ success: false, status: 'TOO_FAST', message: 'Bạn tắt quảng cáo quá sớm! Phải xem tối thiểu 15 giây.' });
  }

  return res.json({ success: false, status: 'PENDING', message: 'Chưa hoàn thành hoặc chưa nhận được phản hồi từ mạng quảng cáo!' });
});

// 7. API: Webhook Postback Monetag
app.get('/api/postback', (req, res) => {
  const { click_id, secret, reward_event_type } = req.query;

  if (secret !== SECRET_KEY) return res.status(403).send('Forbidden: Sai Secret');

  const db = loadDB();
  const claim = db.claims[click_id];

  if (!claim) return res.status(404).send('Not found');
  if (claim.status !== 'PENDING') return res.status(400).send('Already processed');

  // Kiểm tra thời gian: Nếu xem dưới 15 giây -> Từ chối ngay
  const elapsed = Date.now() - claim.created_at;
  if (elapsed < MIN_WATCH_TIME_MS) {
    claim.status = 'TOO_FAST';
    saveDB(db);
    console.log(`[CẢNH BÁO] User ${claim.telegram_id} tắt quảng cáo quá sớm (${elapsed}ms) -> TỪ CHỐI`);
    return res.status(400).send('Too fast');
  }

  // Nếu Monetag báo quảng cáo không có giá trị
  if (reward_event_type === 'non_valued') {
    claim.status = 'NON_VALUED';
    saveDB(db);
    return res.status(400).send('Non valued');
  }

  // Đủ điều kiện: Đánh dấu thành công và cộng 10 phút
  claim.status = 'COMPLETED';

  const user = db.users[claim.telegram_id];
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
  console.log(`[OK] Quảng cáo hợp lệ! Đã cộng 10 phút cho user: ${claim.telegram_id}`);
  return res.send('OK');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server chạy tại cổng: ${PORT}`));
