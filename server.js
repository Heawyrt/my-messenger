const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'database.json');
const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');

if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

let db = { 
  chats: [{ id: 'global', name: '📢 Общий Канал', type: 'channel' }], 
  messages: [], 
  users: {} 
};

if (fs.existsSync(DB_FILE)) {
  try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) {}
}

function saveDB() {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Регистрация
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  const cleanName = username ? username.trim() : '';

  if (!cleanName || !password) {
    return res.status(400).json({ error: 'Заполните логин и пароль' });
  }
  if (db.users[cleanName]) {
    return res.status(400).json({ error: 'Пользователь уже существует' });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  db.users[cleanName] = { passwordHash, avatar: null, createdAt: new Date().toISOString() };
  saveDB();

  res.json({ ok: true, username: cleanName, avatar: null });
});

// Авторизация
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const cleanName = username ? username.trim() : '';
  const user = db.users[cleanName];

  if (!user || !user.passwordHash) {
    return res.status(400).json({ error: 'Пользователь не найден' });
  }

  const isValid = await bcrypt.compare(password, user.passwordHash);
  if (!isValid) {
    return res.status(400).json({ error: 'Неверный пароль' });
  }

  res.json({ ok: true, username: cleanName, avatar: user.avatar || null });
});

// Общий эндпоинт загрузки файлов (фотографии из памяти устройства)
app.post('/api/upload', (req, res) => {
  const { image, filename } = req.body;
  if (!image) return res.status(400).json({ error: 'Файл не выбран' });

  try {
    const base64Data = image.replace(/^data:image\/\w+;base64,/, '');
    const ext = filename ? path.extname(filename) : '.png';
    const newFileName = `avatar_${Date.now()}_${Math.random().toString(36).substr(2, 5)}${ext}`;
    const filePath = path.join(UPLOADS_DIR, newFileName);

    fs.writeFile(filePath, base64Data, 'base64', (err) => {
      if (err) return res.status(500).json({ error: 'Ошибка сохранения файла на диске' });
      res.json({ url: `/uploads/${newFileName}` });
    });
  } catch (e) {
    res.status(500).json({ error: 'Некорректный формат файла' });
  }
});

// Загрузка аватарки напрямую из памяти устройства
app.post('/api/update-avatar', (req, res) => {
  const { username, avatarUrl } = req.body;
  if (!username || !db.users[username]) {
    return res.status(400).json({ error: 'Пользователь не найден' });
  }

  db.users[username].avatar = avatarUrl;
  saveDB();

  // Рассылка новым фото всем подключенным веб-сокетам
  broadcast({ type: 'user_updated', data: { username, avatar: avatarUrl } });

  res.json({ ok: true, avatar: avatarUrl });
});

const clients = new Map();

wss.on('connection', (ws) => {
  let currentUser = null;

  ws.on('message', (raw) => {
    try {
      const { type, data } = JSON.parse(raw);

      if (type === 'auth') {
        currentUser = data.username.trim();
        clients.set(ws, currentUser);

        const userSavedChat = { id: `saved_${currentUser}`, name: '🔖 Избранное', type: 'saved' };
        const userChats = [userSavedChat, ...db.chats];

        const userMessages = db.messages.filter(m => {
          if (m.chatId.startsWith('saved_')) return m.chatId === `saved_${currentUser}`;
          return true;
        });

        const usersMap = {};
        for (let u in db.users) {
          usersMap[u] = { avatar: db.users[u].avatar };
        }

        ws.send(JSON.stringify({
          type: 'init',
          data: {
            chats: userChats,
            messages: userMessages,
            users: usersMap,
            user: { username: currentUser, avatar: db.users[currentUser]?.avatar || null }
          }
        }));

        broadcastUsers();
      }

      if (type === 'message' && currentUser) {
        const chatId = data.chatId || 'global';
        if (chatId.startsWith('saved_') && chatId !== `saved_${currentUser}`) return;

        const msg = {
          id: 'msg_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
          chatId: chatId,
          sender: currentUser,
          text: data.text || '',
          media: data.media || null,
          time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          date: new Date().toISOString()
        };

        db.messages.push(msg);
        saveDB();

        if (chatId.startsWith('saved_')) {
          ws.send(JSON.stringify({ type: 'new_message', data: msg }));
        } else {
          broadcast({ type: 'new_message', data: msg });
        }
      }

      if (type === 'create_chat' && currentUser) {
        const newChat = {
          id: 'chat_' + Date.now(),
          name: data.name,
          type: 'group'
        };
        db.chats.push(newChat);
        saveDB();
        broadcast({ type: 'new_chat', data: newChat });
      }
    } catch (e) { console.error(e); }
  });

  ws.on('close', () => {
    if (currentUser) {
      clients.delete(ws);
      broadcastUsers();
    }
  });
});

function broadcast(payload) {
  const str = JSON.stringify(payload);
  for (const [ws] of clients.keys()) {
    if (ws.readyState === WebSocket.OPEN) ws.send(str);
  }
}

function broadcastUsers() {
  const online = Array.from(clients.values());
  broadcast({ type: 'online_users', data: online });
}

server.listen(PORT, () => {
  console.log(`\n==================================================`);
  console.log(`🚀 Wallchat запущен на http://localhost:${PORT}`);
  console.log(`==================================================\n`);
});