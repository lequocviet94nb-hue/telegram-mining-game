const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Đọc cấu hình từ biến môi trường
const BOT_TOKEN = process.env.BOT_TOKEN;
const MONETAG_LINK = process.env.MONETAG_LINK;
const SECRET_KEY = process.env.SECRET_KEY || 'mysecret123';

const users = new Map();
const pendingClaims = new Map();

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

// 2. Tính tiền đào tự động trên Server (Chống hack)
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

// 3. API: Tạo phiên xem quảng cáo Monetag
app.post('/api/create-ad-session', (req, res) => {
  const { initData } = req.body;
  if (!verifyTelegram(initData)) return res.status(403).json({ error: 'Auth failed' });

  const params = new URLSearchParams(initData);
  const tgUser = JSON.parse(params.get('user'));

  const clickId = uuidv4();
  pendingClaims.set(clickId, {
    telegram_id: tgUser.id,
    created_at: Date.now(),
    status: 'PENDING'
  });

  const adUrl = `${MONETAG_LINK}?sub_id_1=${clickId}`;
  res.json({ success: true, adUrl });
});

// 4. API: Webhook Postback Monetag (Cộng 10 phút sau khi xem xong)
app.get('/api/postback', (req, res) => {
  const { click_id, secret } = req.query;

  if (secret !== SECRET_KEY) return res.status(403).send('Forbidden: Sai Secret');

  const claim = pendingClaims.get(click_id);
  if (!claim) return res.status(404).send('Not found');
  if (claim.status !== 'PENDING') return res.status(400).send('Already claimed');

  // Chống bot spam: Bắt buộc thời gian xem tối thiểu 10 giây
  if ((Date.now() - claim.created_at) < 10000) {
    return res.status(400).send('Invalid watch time');
  }

  claim.status = 'COMPLETED';

  const now = Math.floor(Date.now() / 1000);
  let user = users.get(claim.telegram_id) || {
    balance: 0,
    fuel_expires_at: now,
    last_collected_at: now,
    rate_per_sec: 0.0000003
  };

  user = calculateBalance(user);

  // Cộng dồn 10 phút (600 giây) không giới hạn
  if (user.fuel_expires_at > now) {
    user.fuel_expires_at += 600;
  } else {
    user.fuel_expires_at = now + 600;
    user.last_collected_at = now;
  }

  users.set(claim.telegram_id, user);
  console.log(`[OK] Cộng 10 phút cho user: ${claim.telegram_id}`);
  res.send('OK');
});

// 5. API: Lấy số dư và thời gian nhiên liệu
app.post('/api/user-status', (req, res) => {
  const { initData } = req.body;
  if (!verifyTelegram(initData)) return res.status(403).json({ error: 'Auth failed' });

  const params = new URLSearchParams(initData);
  const tgUser = JSON.parse(params.get('user'));

  let user = users.get(tgUser.id) || {
    balance: 0,
    fuel_expires_at: Math.floor(Date.now() / 1000),
    last_collected_at: Math.floor(Date.now() / 1000),
    rate_per_sec: 0.0000003
  };

  user = calculateBalance(user);
  users.set(tgUser.id, user);

  res.json({
    success: true,
    balance: user.balance,
    fuel_expires_at: user.fuel_expires_at,
    rate_per_sec: user.rate_per_sec
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server chạy tại cổng: ${PORT}`));
