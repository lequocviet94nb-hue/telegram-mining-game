const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json());

// Tắt hoàn toàn cache trình duyệt để cập nhật tức thì
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// Mã phiên bản máy chủ (Tự động cập nhật cho người chơi)
const SERVER_BUILD_ID = 'maint_' + Date.now().toString();

const BOT_TOKEN = process.env.BOT_TOKEN;
const MONETAG_LINK = process.env.MONETAG_LINK || 'https://alwingulla.com/4/8634884';
const SECRET_KEY = process.env.SECRET_KEY || 'mysecret123';
const APP_URL = 'https://mayintien-tele.onrender.com';

const RATE_PER_SEC_VND = 0.01;
const MIN_WATCH_TIME_MS = 15000;
const MIN_WITHDRAW_VND = 5000; // Min rút chuẩn 5.000 VNĐ

// === DATABASE LƯU TRỮ VĨNH VIỄN ===
const DB_FILE = path.join(__dirname, 'database.json');

function loadDB() {
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({
      users: {}, sessions: {}, devices: {}, withdrawals: [], admin_id: null, is_maintenance: true
    }, null, 2));
  }
  try {
    const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    if (!data.withdrawals) data.withdrawals = [];
    if (!data.devices) data.devices = {};
    if (data.is_maintenance === undefined) data.is_maintenance = true;

    // Tự động giải phóng các mã cũ hw_ bị trùng lặp phần cứng để mở khóa cho người chơi bị chặn oan
    let cleaned = false;
    for (const k of Object.keys(data.devices)) {
      if (k.startsWith('hw_')) {
        delete data.devices[k];
        cleaned = true;
      }
    }
    if (cleaned) {
      fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
    }

    return data;
  } catch (e) {
    return { users: {}, sessions: {}, devices: {}, withdrawals: [], admin_id: null, is_maintenance: true };
  }
}

function saveDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// Bắn thông báo an toàn về Telegram
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

  if (text === '/baotri on') {
    const db = loadDB();
    db.is_maintenance = true;
    saveDB(db);
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: '⚙️ <b>ĐÃ BẬT CHẾ ĐỘ BẢO TRÌ!</b>\n\nTất cả người chơi mở game sẽ thấy thông báo bảo trì. Dữ liệu được bảo toàn 100%.',
        parse_mode: 'HTML'
      })
    });
    return res.sendStatus(200);
  }

  if (text === '/baotri off') {
    const db = loadDB();
    db.is_maintenance = false;
    saveDB(db);
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: '✅ <b>ĐÃ TẮT BẢO TRÌ!</b>\n\nGame đã mở cửa trở lại cho mọi người chơi bình thường.',
        parse_mode: 'HTML'
      })
    });
    return res.sendStatus(200);
  }

  if (text === '/admin') {
    const db = loadDB();
    db.admin_id = chatId;
    saveDB(db);
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: `✅ <b>ĐÃ XÁC NHẬN BẠN LÀ ADMIN!</b>\n\n- Gõ <code>/baotri on</code> để bật bảo trì.\n- Gõ <code>/baotri off</code> để tắt bảo trì.\n- Đơn đổi thưởng và thông báo bạn bè sẽ gửi về đây.`,
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

// 1. ĐĂNG KÝ TÀI KHOẢN (KHÓA 1 MÁY = 1 TÀI KHOẢN DUY NHẤT)
app.post('/api/register', (req, res) => {
  const { initData, username, pin, deviceId, hardwareFingerprint, refCode } = req.body;
  const finalDeviceId = deviceId || hardwareFingerprint;
  if (!verifyTelegram(initData)) return res.status(403).json({ error: 'Auth failed' });

  if (!finalDeviceId || finalDeviceId.length < 5) {
    return res.status(400).json({ error: 'Lỗi nhận diện thiết bị!' });
  }
  if (!username || username.trim().length < 3) return res.status(400).json({ error: 'Tên phải từ 3 ký tự!' });
  if (!pin || pin.trim().length < 4) return res.status(400).json({ error: 'Mã PIN từ 4 số trở lên!' });

  const params = new URLSearchParams(initData);
  const tgUser = JSON.parse(params.get('user'));
  const tgId = String(tgUser.id);

  const db = loadDB();

  // KIỂM TRA THIẾT BỊ: Nếu chiếc máy này đã từng đăng ký tài khoản khác
  if (db.devices && db.devices[finalDeviceId] && db.devices[finalDeviceId].telegram_id !== tgId) {
    const ownerName = db.devices[finalDeviceId].username || 'khác';
    return res.status(400).json({
      error: `⛔ THIẾT BỊ NÀY ĐÃ ĐĂNG KÝ TÀI KHOẢN: [${ownerName}]! Mỗi máy chỉ được phép sử dụng duy nhất 1 tài khoản.`
    });
  }

  // KIỂM TRA NICK TELEGRAM: 1 nick Telegram chỉ được tạo 1 tài khoản game
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
    hardware_fingerprint: finalDeviceId,
    device_id: finalDeviceId,
    balance: 0,
    fuel_expires_at: now,
    last_collected_at: now,
    rate_per_sec: RATE_PER_SEC_VND,
    invited_by: inviterId,
    ads_watched: 0,
    created_at: now
  };

  if (!db.devices) db.devices = {};
  db.devices[finalDeviceId] = { telegram_id: tgId, username: username.trim() };

  saveDB(db);
  return res.json({ success: true });
});

// 2. TỰ ĐỘNG ĐĂNG NHẬP / KHÔI PHỤC NẾU SERVER RESTART
app.post('/api/restore-account', (req, res) => {
  const { initData, backup, deviceId } = req.body;
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
      const devId = deviceId || backup.deviceId || backup.hardwareFingerprint;
      if (devId) db.devices[devId] = { telegram_id: tgId, username: backup.username };
    }
    saveDB(db);
  }
  return res.json({ success: true });
});

// 3. LẤY TRẠNG THÁI TÀI KHOẢN & KIỂM TRA BẢO TRÌ & KHÓA THIẾT BỊ
app.post('/api/user-status', (req, res) => {
  const { initData, deviceId, hardwareFingerprint } = req.body;
  const finalDeviceId = deviceId || hardwareFingerprint;
  if (!verifyTelegram(initData)) return res.status(403).json({ error: 'Auth failed' });

  const params = new URLSearchParams(initData);
  const tgUser = JSON.parse(params.get('user'));
  const tgId = String(tgUser.id);

  const db = loadDB();

  // KIỂM TRA BẢO TRÌ HỆ THỐNG (ADMIN ĐƯỢC PHÉP TRUY CẬP)
  const isAdmin = (db.admin_id && String(db.admin_id) === tgId);
  if (db.is_maintenance !== false && !isAdmin) {
    return res.json({
      success: false,
      maintenance: true,
      error: 'Hệ thống đang bảo trì nâng cấp'
    });
  }

  // KIỂM TRA KHÓA THIẾT BỊ: Nếu máy này đã bị tài khoản khác chiếm giữ
  if (finalDeviceId && db.devices && db.devices[finalDeviceId]) {
    const boundDevice = db.devices[finalDeviceId];
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

  // Tự động liên kết thiết bị cho tài khoản đã có sẵn nếu máy chưa lưu
  if (finalDeviceId && (!db.devices[finalDeviceId] || db.devices[finalDeviceId].telegram_id === tgId)) {
    if (!db.devices) db.devices = {};
    db.devices[finalDeviceId] = { telegram_id: tgId, username: user.username };
    saveDB(db);
  }

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
    is_admin: isAdmin,
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

// 6. KHỞI TẠO LƯỢT XEM QUẢNG CÁO 1/2
app.post('/api/start-ad-1', (req, res) => {
  const { initData, rewardType } = req.body;
  if (!verifyTelegram(initData)) return res.status(403).json({ error: 'Auth failed' });

  const params = new URLSearchParams(initData);
  const tgUser = JSON.parse(params.get('user'));
  const tgId = String(tgUser.id);

  const db = loadDB();
  if (!db.users[tgId]) return res.status(400).json({ error: 'Vui lòng đăng ký trước!' });

  const sessionId = uuidv4();

  db.sessions[sessionId] = {
    telegram_id: tgId,
    reward_type: rewardType || 'CASH',
    step: 1,
    ad1_start: Date.now(),
    status: 'WATCHING_1'
  };
  saveDB(db);

  return res.json({ success: true, sessionId });
});

// 7. KHỞI TẠO LƯỢT XEM QUẢNG CÁO 2/2
app.post('/api/start-ad-2', (req, res) => {
  const { initData, sessionId } = req.body;
  if (!verifyTelegram(initData)) return res.status(403).json({ error: 'Auth failed' });

  const db = loadDB();
  const sess = db.sessions[sessionId];
  if (!sess) return res.status(404).json({ error: 'Phiên không tồn tại!' });

  sess.step = 2;
  sess.ad2_start = Date.now();
  sess.status = 'WATCHING_2';
  saveDB(db);

  return res.json({ success: true });
});

// 8. CỘNG THƯỞNG SAU KHI MONETAG XÁC NHẬN HOÀN THÀNH
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
