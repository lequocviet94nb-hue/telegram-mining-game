const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

const SERVER_BUILD_ID = Date.now().toString();

const BOT_TOKEN = process.env.BOT_TOKEN;
const MONETAG_LINK = process.env.MONETAG_LINK;
const SECRET_KEY = process.env.SECRET_KEY || 'mysecret123';
const APP_URL = 'https://mayintien-tele.onrender.com';

const RATE_PER_SEC_VND = 0.01;
const MIN_WATCH_TIME_MS = 15000;
const MIN_WITHDRAW_VND = 5000; // MIN RÚT MỚI: 5.000 VNĐ

// === DATABASE LƯU TRỮ VĨNH VIỄN ===
const DB_FILE = path.join(__dirname, 'database.json');

function loadDB() {
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({
      users: {}, sessions: {}, devices: {}, withdrawals: [], admin_id: null
    }, null, 2));
  }
  try {
    const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    if (!data.withdrawals) data.withdrawals = [];
    if (!data.devices) data.devices = {};
    return data;
  } catch (e) {
    return { users: {}, sessions: {}, devices: {}, withdrawals: [], admin_id: null };
  }
}

function saveDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

async function notifyAdmin(text) {
  const db = loadDB();
  if (!db.admin_id || !BOT_TOKEN) return;
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: db.admin_id, text: text, parse_mode: 'HTML' })
    });
  } catch (err) {}
}

async function setupTelegramBot() {
  if (!BOT_TOKEN) return;
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook?url=${APP_URL}/api/telegram-webhook`);
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setChatMenuButton`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        menu_button: { type: 'web_app', text: '🎮 Chơi Game', web_app: { url: APP_URL } }
      })
    });
  } catch (err) {}
}
setupTelegramBot();

app.get('/api/version', (req, res) => res.json({ version: SERVER_BUILD_ID }));

app.post('/api/telegram-webhook', async (req, res) => {
  const { message } = req.body;
  if (!message || !message.text) return res.sendStatus(200);

  const chatId = message.chat.id;
  const text = message.text.trim();

  if (text === '/admin') {
    const db = loadDB();
    db.admin_id = chatId;
    saveDB(db);
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: `✅ <b>ĐÃ XÁC NHẬN BẠN LÀ ADMIN!</b>\n\nTừ nay đơn đổi thưởng và bạn bè đạt 5.000 ads sẽ thông báo về đây.`,
        parse_mode: 'HTML'
      })
    });
    return res.sendStatus(200);
  }

  if (text.startsWith('/start')) {
    const firstName = message.from ? message.from.first_name : 'bạn';
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: `👋 Chào mừng <b>${firstName}</b> đến với <b>Máy In Tiền Tự Động</b>!\n\n⚡ Cày tiền VNĐ thụ động 24/7 không giới hạn.\n👇 Bấm nút bên dưới để mở ứng dụng:`,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: "⚡ MỞ MÁY IN TIỀN NGAY ⚡", web_app: { url: APP_URL } }]
          ]
        }
      })
    });
  }
  res.sendStatus(200);
});

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

// 1. ĐĂNG KÝ TÀI KHOẢN (KHÓA CỨNG 1 MÁY PHẦN CỨNG = 1 ACC DUY NHẤT)
app.post('/api/register', (req, res) => {
  const { initData, username, pin, hardwareFingerprint, refCode } = req.body;
  if (!verifyTelegram(initData)) return res.status(403).json({ error: 'Auth failed' });

  if (!hardwareFingerprint || hardwareFingerprint.length < 5) {
    return res.status(400).json({ error: 'Lỗi nhận diện phần cứng thiết bị!' });
  }
  if (!username || username.trim().length < 3) return res.status(400).json({ error: 'Tên phải từ 3 ký tự!' });
  if (!pin || pin.trim().length < 4) return res.status(400).json({ error: 'Mã PIN từ 4 số trở lên!' });

  const params = new URLSearchParams(initData);
  const tgUser = JSON.parse(params.get('user'));
  const tgId = String(tgUser.id);

  const db = loadDB();

  // KIỂM TRA PHẦN CỨNG: Nếu thiết bị này đã từng liên kết với tài khoản Telegram khác
  if (db.devices && db.devices[hardwareFingerprint] && db.devices[hardwareFingerprint].telegram_id !== tgId) {
    const ownerName = db.devices[hardwareFingerprint].username || 'khác';
    return res.status(400).json({
      error: `⛔ THIẾT BỊ NÀY ĐÃ ĐĂNG KÝ TÀI KHOẢN: [${ownerName}]! Mỗi thiết bị phần cứng chỉ được phép sử dụng duy nhất 1 tài khoản.`
    });
  }

  if (db.users[tgId]) return res.status(400).json({ error: 'Tài khoản Telegram này đã có tài khoản game!' });

  const isNameTaken = Object.values(db.users).some(u => u.username.toLowerCase() === username.trim().toLowerCase());
  if (isNameTaken) return res.status(400).json({ error: 'Tên tài khoản này đã có người dùng!' });

  let inviterId = null;
  if (refCode && refCode.startsWith('ref_')) {
    const rawInviterId = refCode.replace('ref_', '').trim();
    if (rawInviterId !== tgId && db.users[rawInviterId]) {
      inviterId = rawInviterId;
    }
  }

  const now = Math.floor(Date.now() / 1000);
  db.users[tgId] = {
    telegram_id: tgId,
    username: username.trim(),
    pin: pin.trim(),
    hardware_fingerprint: hardwareFingerprint,
    balance: 0,
    fuel_expires_at: now,
    last_collected_at: now,
    rate_per_sec: RATE_PER_SEC_VND,
    invited_by: inviterId,
    ads_watched: 0,
    created_at: now
  };

  if (!db.devices) db.devices = {};
  db.devices[hardwareFingerprint] = { telegram_id: tgId, username: username.trim() };

  saveDB(db);
  return res.json({ success: true });
});

// 2. TỰ ĐỘNG ĐĂNG NHẬP / KHÔI PHỤC NẾU SERVER RESTART
app.post('/api/restore-account', (req, res) => {
  const { initData, backup } = req.body;
  if (!verifyTelegram(initData)) return res.status(403).json({ error: 'Auth failed' });

  const params = new URLSearchParams(initData);
  const tgUser = JSON.parse(params.get('user'));
  const tgId = String(tgUser.id);

  if (!backup || !backup.username) return res.json({ success: false });

  const db = loadDB();
  if (!db.users[tgId]) {
    db.users[tgId] = {
      telegram_id: tgId,
      username: backup.username,
      pin: backup.pin || '1234',
      hardware_fingerprint: backup.hardwareFingerprint || 'restored',
      balance: backup.balance || 0,
      fuel_expires_at: backup.fuel_expires_at || Math.floor(Date.now() / 1000),
      last_collected_at: backup.last_collected_at || Math.floor(Date.now() / 1000),
      rate_per_sec: RATE_PER_SEC_VND,
      invited_by: backup.invited_by || null,
      ads_watched: backup.ads_watched || 0,
      created_at: backup.created_at || Math.floor(Date.now() / 1000)
    };
    if (backup.hardwareFingerprint) {
      if (!db.devices) db.devices = {};
      db.devices[backup.hardwareFingerprint] = { telegram_id: tgId, username: backup.username };
    }
    saveDB(db);
  }
  return res.json({ success: true });
});

// 3. LẤY TRẠNG THÁI TÀI KHOẢN & KIỂM TRA KHÓA THIẾT BỊ
app.post('/api/user-status', (req, res) => {
  const { initData, hardwareFingerprint } = req.body;
  if (!verifyTelegram(initData)) return res.status(403).json({ error: 'Auth failed' });

  const params = new URLSearchParams(initData);
  const tgUser = JSON.parse(params.get('user'));
  const tgId = String(tgUser.id);

  const db = loadDB();

  // KIỂM TRA KHÓA PHẦN CỨNG CHẶT CHẼ
  if (hardwareFingerprint && db.devices && db.devices[hardwareFingerprint]) {
    const boundDevice = db.devices[hardwareFingerprint];
    if (boundDevice.telegram_id !== tgId) {
      return res.json({
        success: false,
        device_blocked: true,
        error: `⛔ THIẾT BỊ NÀY ĐÃ BỊ KHÓA VỚI TÀI KHOẢN [${boundDevice.username}]! Không thể sử dụng tài khoản khác trên máy này.`
      });
    }
  }

  const user = db.users[tgId];
  if (!user) return res.json({ success: true, is_registered: false });

  user.rate_per_sec = RATE_PER_SEC_VND;
  calculateBalance(user);

  const friends = [];
  for (const [fId, fUser] of Object.entries(db.users)) {
    if (fUser.invited_by === tgId) {
      friends.push({
        username: fUser.username,
        ads_watched: fUser.ads_watched || 0,
        is_completed: (fUser.ads_watched || 0) >= 5000
      });
    }
  }

  saveDB(db);

  return res.json({
    success: true,
    is_registered: true,
    is_admin: (db.admin_id && String(db.admin_id) === tgId),
    user: {
      telegram_id: user.telegram_id,
      username: user.username,
      pin: user.pin,
      balance: user.balance,
      fuel_expires_at: user.fuel_expires_at,
      last_collected_at: user.last_collected_at,
      rate_per_sec: user.rate_per_sec,
      hardwareFingerprint: user.hardware_fingerprint,
      invited_by: user.invited_by,
      ads_watched: user.ads_watched || 0,
      friends: friends
    }
  });
});

// 4. API RÚT TIỀN (MIN RÚT 5.000 VNĐ & TRỪ SỐ DƯ NGAY)
app.post('/api/withdraw', async (req, res) => {
  const { initData, amount, pin, method, bankName, accountNumber, accountName } = req.body;
  if (!verifyTelegram(initData)) return res.status(403).json({ error: 'Auth failed' });

  const params = new URLSearchParams(initData);
  const tgUser = JSON.parse(params.get('user'));
  const tgId = String(tgUser.id);

  const db = loadDB();
  const user = db.users[tgId];

  if (!user) return res.status(404).json({ error: 'Tài khoản không tồn tại!' });

  if (user.pin !== pin.trim()) {
    return res.status(400).json({ error: 'Mã PIN bảo mật không chính xác!' });
  }

  calculateBalance(user);

  const withdrawAmount = parseFloat(amount);
  if (isNaN(withdrawAmount) || withdrawAmount < MIN_WITHDRAW_VND) {
    return res.status(400).json({ error: `Số tiền đổi thưởng tối thiểu là ${MIN_WITHDRAW_VND.toLocaleString('vi-VN')} VNĐ!` });
  }

  if (user.balance < withdrawAmount) {
    return res.status(400).json({ error: 'Số dư khả dụng không đủ để rút!' });
  }

  // TRỪ TIỀN NGAY LẬP TỨC
  user.balance -= withdrawAmount;
  user.last_collected_at = Math.floor(Date.now() / 1000);

  const withdrawId = uuidv4().substring(0, 8).toUpperCase();
  const withdrawRecord = {
    id: withdrawId,
    telegram_id: tgId,
    username: user.username,
    amount: withdrawAmount,
    method: method,
    bankName: bankName || '',
    accountNumber: accountNumber.trim(),
    accountName: accountName.trim().toUpperCase(),
    created_at: new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }),
    status: 'PENDING'
  };

  db.withdrawals.push(withdrawRecord);
  saveDB(db);

  const rawAcc = accountNumber.trim();
  const maskedAcc = rawAcc.length > 4 ? rawAcc.substring(0, rawAcc.length - 4) + '****' : '****';
  const channelDisplay = method === 'NGAN_HANG' ? (bankName || 'Ngân hàng') : method;

  const notifyText = `📦 <b>ĐƠN ĐỔI THƯỞNG MỚI [#${withdrawId}]</b>\n\n` +
    `👤 <b>Tài khoản:</b> ${user.username}\n` +
    `🎁 <b>Giá trị:</b> <b>${withdrawAmount.toLocaleString('vi-VN')} VNĐ</b>\n` +
    `💳 <b>Kênh nhận:</b> ${channelDisplay} (${maskedAcc})\n` +
    `⏰ <b>Thời gian:</b> ${withdrawRecord.created_at}\n\n` +
    `👉 <i>Vui lòng mở Mini App ➔ Vào Tab [👑 Quản Trị] để xem chi tiết đầy đủ và xử lý!</i>`;

  notifyAdmin(notifyText);

  return res.json({
    success: true,
    message: `🎉 Yêu cầu đổi thưởng ${withdrawAmount.toLocaleString('vi-VN')} VNĐ thành công! Tiền đã được trừ khỏi số dư.`
  });
});

// 5. API ADMIN XEM ĐƠN
app.post('/api/admin/withdrawals', (req, res) => {
  const { initData } = req.body;
  if (!verifyTelegram(initData)) return res.status(403).json({ error: 'Auth failed' });

  const params = new URLSearchParams(initData);
  const tgUser = JSON.parse(params.get('user'));
  const tgId = String(tgUser.id);

  const db = loadDB();
  if (!db.admin_id || String(db.admin_id) !== tgId) {
    return res.status(403).json({ error: 'Không có quyền truy cập Quản trị!' });
  }

  return res.json({
    success: true,
    withdrawals: db.withdrawals.slice(-30).reverse()
  });
});

// 6. XEM QUẢNG CÁO 1/2
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

// 7. XEM QUẢNG CÁO 2/2
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

// 8. NHẬN THƯỞNG
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

    user.ads_watched = (user.ads_watched || 0) + 2;

    if (user.invited_by && db.users[user.invited_by]) {
      const inviter = db.users[user.invited_by];
      if (user.ads_watched >= 5000 && !user.notified_5000) {
        user.notified_5000 = true;
        const refAlert = `🎉 <b>HOÀN THÀNH NHIỆM VỤ GIỚI THIỆU (5.000 ADS)</b>\n\n` +
          `👤 <b>Người giới thiệu:</b> ${inviter.username}\n` +
          `👥 <b>Người được mời:</b> ${user.username}\n` +
          `🎯 <b>Tiến độ:</b> Đã hoàn tất 5.000 lượt tương tác!\n\n` +
          `🎁 <b>Phần thưởng: 10.000 VNĐ</b>\n` +
          `👉 <i>Vui lòng chuyển khoản thưởng 10.000 VNĐ cho người giới thiệu.</i>`;
        notifyAdmin(refAlert);
      }
    }

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
