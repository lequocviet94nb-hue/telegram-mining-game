const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json());

// Chống lưu Cache
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

const SERVER_BUILD_ID = Date.now().toString();

// === CẤU HÌNH BIẾN MÔI TRƯỜNG ===
const BOT_TOKEN = process.env.BOT_TOKEN;
const MONETAG_LINK = process.env.MONETAG_LINK;
const SECRET_KEY = process.env.SECRET_KEY || 'mysecret123';
const APP_URL = 'https://mayintien-tele.onrender.com';

const RATE_PER_SEC_VND = 0.01;
const MIN_WATCH_TIME_MS = 15000;

// === DATABASE LƯU TRỮ VĨNH VIỄN ===
const DB_FILE = path.join(__dirname, 'database.json');

function loadDB() {
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ users: {}, sessions: {}, devices: {} }, null, 2));
  }
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (e) {
    return { users: {}, sessions: {}, devices: {} };
  }
}

function saveDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// 1. Tự động thiết lập Bot Telegram
async function setupTelegramBot() {
  if (!BOT_TOKEN) return;
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook?url=${APP_URL}/api/telegram-webhook`);
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setChatMenuButton`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        menu_button: {
          type: 'web_app',
          text: '🎮 Chơi Game',
          web_app: { url: APP_URL }
        }
      })
    });
    console.log('[Telegram Bot] Kích hoạt Bot thành công!');
  } catch (err) {
    console.error(err);
  }
}
setupTelegramBot();

app.get('/api/version', (req, res) => {
  res.json({ version: SERVER_BUILD_ID });
});

app.post('/api/telegram-webhook', async (req, res) => {
  const { message } = req.body;
  if (message && message.text && message.text.startsWith('/start')) {
    const chatId = message.chat.id;
    const firstName = message.from ? message.from.first_name : 'bạn';

    try {
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: `👋 Chào mừng **${firstName}** đến với **Máy In Tiền Tự Động**!\n\n⚡ Cày tiền VNĐ thụ động 24/7 không giới hạn.\n👇 Bấm nút bên dưới để mở game chơi ngay:`,
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: "⚡ MỞ MÁY IN TIỀN NGAY ⚡", web_app: { url: APP_URL } }]
            ]
          }
        })
      });
    } catch (e) {}
  }
  res.sendStatus(200);
});

// 2. Xác thực Telegram
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

// 3. Tính toán tiền in tự động khi thoát game mở lại (Không mất 1 xu)
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

// 4. API Đăng ký tài khoản (KHÓA CHẶT 1 THIẾT BỊ = 1 TÀI KHOẢN)
app.post('/api/register', (req, res) => {
  const { initData, username, pin, deviceId } = req.body;
  if (!verifyTelegram(initData)) return res.status(403).json({ error: 'Auth failed' });

  if (!deviceId) return res.status(400).json({ error: 'Không nhận diện được thiết bị!' });
  if (!username || username.trim().length < 3) return res.status(400).json({ error: 'Tên phải từ 3 ký tự!' });
  if (!pin || pin.trim().length < 4) return res.status(400).json({ error: 'Mã PIN từ 4 số trở lên!' });

  const params = new URLSearchParams(initData);
  const tgUser = JSON.parse(params.get('user'));
  const tgId = String(tgUser.id);

  const db = loadDB();

  // Kiểm tra 1 thiết bị chỉ được tạo 1 tài khoản
  if (db.devices && db.devices[deviceId] && db.devices[deviceId] !== tgId) {
    return res.status(400).json({ error: '⛔ Thiết bị này đã đăng ký 1 tài khoản khác rồi! Mỗi thiết bị chỉ được phép chơi 1 tài khoản duy nhất.' });
  }

  if (db.users[tgId]) return res.status(400).json({ error: 'Tài khoản Telegram này đã đăng ký rồi!' });

  const isNameTaken = Object.values(db.users).some(u => u.username.toLowerCase() === username.trim().toLowerCase());
  if (isNameTaken) return res.status(400).json({ error: 'Tên tài khoản này đã có người dùng!' });

  const now = Math.floor(Date.now() / 1000);
  db.users[tgId] = {
    telegram_id: tgId,
    username: username.trim(),
    pin: pin.trim(),
    device_id: deviceId,
    balance: 0,
    fuel_expires_at: now,
    last_collected_at: now,
    rate_per_sec: RATE_PER_SEC_VND,
    created_at: now
  };

  if (!db.devices) db.devices = {};
  db.devices[deviceId] = tgId;

  saveDB(db);
  return res.json({ success: true });
});

// 5. API Khôi phục tài khoản từ đám mây Telegram (Chống mất dữ liệu khi Render restart)
app.post('/api/restore-account', (req, res) => {
  const { initData, backup } = req.body;
  if (!verifyTelegram(initData)) return res.status(403).json({ error: 'Auth failed' });

  const params = new URLSearchParams(initData);
  const tgUser = JSON.parse(params.get('user'));
  const tgId = String(tgUser.id);

  if (!backup || !backup.username) return res.json({ success: false });

  const db = loadDB();
  if (!db.users[tgId]) {
    // Khôi phục lại tài khoản từ đám mây của người dùng
    db.users[tgId] = {
      telegram_id: tgId,
      username: backup.username,
      pin: backup.pin || '1234',
      device_id: backup.deviceId || 'restored',
      balance: backup.balance || 0,
      fuel_expires_at: backup.fuel_expires_at || Math.floor(Date.now() / 1000),
      last_collected_at: backup.last_collected_at || Math.floor(Date.now() / 1000),
      rate_per_sec: RATE_PER_SEC_VND,
      created_at: backup.created_at || Math.floor(Date.now() / 1000)
    };
    if (backup.deviceId) {
      if (!db.devices) db.devices = {};
      db.devices[backup.deviceId] = tgId;
    }
    saveDB(db);
    console.log(`[RESTORE] Đã khôi phục tài khoản an toàn cho user: ${tgId}`);
  }
  return res.json({ success: true });
});

// 6. API Lấy thông tin tài khoản
app.post('/api/user-status', (req, res) => {
  const { initData, deviceId } = req.body;
  if (!verifyTelegram(initData)) return res.status(403).json({ error: 'Auth failed' });

  const params = new URLSearchParams(initData);
  const tgUser = JSON.parse(params.get('user'));
  const tgId = String(tgUser.id);

  const db = loadDB();

  // Kiểm tra khóa thiết bị: Nếu thiết bị này thuộc về tài khoản khác
  if (deviceId && db.devices && db.devices[deviceId] && db.devices[deviceId] !== tgId) {
    return res.json({
      success: false,
      device_blocked: true,
      error: '⛔ THIẾT BỊ NÀY ĐÃ ĐĂNG NHẬP TÀI KHOẢN KHÁC! Mỗi máy chỉ được chơi 1 tài khoản.'
    });
  }

  const user = db.users[tgId];
  if (!user) return res.json({ success: true, is_registered: false });

  user.rate_per_sec = RATE_PER_SEC_VND;
  calculateBalance(user);
  saveDB(db);

  return res.json({
    success: true,
    is_registered: true,
    user: {
      username: user.username,
      pin: user.pin,
      balance: user.balance,
      fuel_expires_at: user.fuel_expires_at,
      last_collected_at: user.last_collected_at,
      rate_per_sec: user.rate_per_sec,
      deviceId: user.device_id
    }
  });
});

// 7. API Quảng Cáo 1/2
app.post('/api/start-ad-1', (req, res) => {
  const { initData, rewardType } = req.body;
  if (!verifyTelegram(initData)) return res.status(403).json({ error: 'Auth failed' });

  const params = new URLSearchParams(initData);
  const tgUser = JSON.parse(params.get('user'));
  const tgId = String(tgUser.id);

  const db = loadDB();
  if (!db.users[tgId]) return res.status(400).json({ error: 'Vui lòng đăng ký trước!' });

  const sessionId = uuidv4();
  const clickId1 = uuidv4();

  db.sessions[sessionId] = {
    telegram_id: tgId,
    reward_type: rewardType || 'CASH',
    step: 1,
    ad1_start: Date.now(),
    ad1_click_id: clickId1,
    status: 'WATCHING_1'
  };
  saveDB(db);

  const adUrl = `${MONETAG_LINK}?sub_id_1=${clickId1}&ymid=${clickId1}`;
  return res.json({ success: true, sessionId, adUrl });
});

// 8. API Quảng Cáo 2/2
app.post('/api/start-ad-2', (req, res) => {
  const { initData, sessionId } = req.body;
  if (!verifyTelegram(initData)) return res.status(403).json({ error: 'Auth failed' });

  const db = loadDB();
  const sess = db.sessions[sessionId];
  if (!sess) return res.status(404).json({ error: 'Phiên không tồn tại!' });

  const elapsed1 = Date.now() - sess.ad1_start;
  if (elapsed1 < MIN_WATCH_TIME_MS) {
    return res.status(400).json({ error: 'Bạn chưa xem đủ 15 giây quảng cáo 1!' });
  }

  const clickId2 = uuidv4();
  sess.step = 2;
  sess.ad2_start = Date.now();
  sess.ad2_click_id = clickId2;
  sess.status = 'WATCHING_2';
  saveDB(db);

  const adUrl = `${MONETAG_LINK}?sub_id_1=${clickId2}&ymid=${clickId2}`;
  return res.json({ success: true, adUrl });
});

// 9. API Nhận Thưởng
app.post('/api/claim-reward-double', (req, res) => {
  const { initData, sessionId } = req.body;
  if (!verifyTelegram(initData)) return res.status(403).json({ error: 'Auth failed' });

  const params = new URLSearchParams(initData);
  const tgUser = JSON.parse(params.get('user'));
  const tgId = String(tgUser.id);

  const db = loadDB();
  const sess = db.sessions[sessionId];

  if (!sess || sess.telegram_id !== tgId) return res.status(404).json({ success: false, message: 'Phiên không hợp lệ!' });
  if (sess.status === 'COMPLETED') return res.status(400).json({ success: false, message: 'Đã nhận thưởng rồi!' });
  if (sess.step !== 2) return res.status(400).json({ success: false, message: 'Chưa xem xong quảng cáo thứ 2!' });

  const elapsed2 = Date.now() - sess.ad2_start;
  if (elapsed2 < MIN_WATCH_TIME_MS) {
    return res.status(400).json({ success: false, message: 'Bạn chưa xem đủ 15 giây quảng cáo 2!' });
  }

  sess.status = 'COMPLETED';
  const user = db.users[tgId];

  let returnMsg = "";
  if (user) {
    const now = Math.floor(Date.now() / 1000);
    calculateBalance(user);

    if (sess.reward_type === 'CASH') {
      user.balance += 2.0;
      returnMsg = "🎉 Chúc mừng! Bạn đã nhận trực tiếp +2.00 VNĐ vào số dư!";
    } else {
      if (user.fuel_expires_at > now) {
        user.fuel_expires_at += 600;
      } else {
        user.fuel_expires_at = now + 600;
        user.last_collected_at = now;
      }
      returnMsg = "🎉 Đã cộng +10 phút nhiên liệu in tiền!";
    }
  }

  saveDB(db);
  return res.json({ success: true, message: returnMsg, rewardType: sess.reward_type });
});

app.get('/api/postback', (req, res) => res.send('OK'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server chạy tại cổng: ${PORT}`));
