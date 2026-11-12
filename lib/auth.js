const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);
// Vercel no permite escribir dentro del proyecto. Sin Redis usamos /tmp como
// respaldo de ejecución para que la API siga respondiendo; Redis continúa
// siendo el almacenamiento persistente cuando está configurado.
const DATA_FILE = process.env.ALPHATRADE_AUTH_FILE || (process.env.VERCEL
  ? path.join('/tmp', 'alphatrade-auth.json')
  : path.join(__dirname, '..', 'database_auth.json'));
const SESSION_COOKIE = 'alpha_session';
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const RESET_TTL_SECONDS = 30 * 60;
const MAX_BODY_BYTES = 2_000_000;
const LOGIN_ATTEMPTS_TTL_MS = 15 * 60 * 1000;
const localLoginAttempts = new Map();

function sendJson(res, status, payload, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(payload));
}

function isRedisConfigured() {
  return Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
}

async function redisCommand(...command) {
  try {
    const response = await fetch(process.env.UPSTASH_REDIS_REST_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(command)
    });
    const result = await response.json();
    if (!response.ok || result.error) throw new Error('No se pudo acceder al almacenamiento persistente. Verifica la configuración de Upstash.');
    return result.result;
  } catch (error) {
    if (error.message.includes('almacenamiento persistente')) throw error;
    throw new Error('No se pudo conectar con el almacenamiento persistente. Verifica la conexión y las credenciales de Upstash.');
  }
}

function readLocalData() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid local auth store');
    return parsed;
  } catch (error) {
    if (error.code === 'ENOENT') return { users: {}, usernames: {}, ids: {}, sessions: {}, resets: {}, trades: {} };
    throw new Error('No se pudo leer el almacenamiento local de cuentas.');
  }
}

function writeLocalData(data) {
  const tempFile = `${DATA_FILE}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tempFile, JSON.stringify(data), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tempFile, DATA_FILE);
  } catch (error) {
    try { fs.unlinkSync(tempFile); } catch (cleanupError) {}
    throw new Error('No se pudo guardar el almacenamiento local de cuentas.');
  }
}

function storageMode() {
  if (isRedisConfigured()) return 'redis';
  return 'local';
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function normalizedIdentity(value) {
  return value.trim().toLocaleLowerCase('en-US');
}

function safeUser(user) {
  return { id: user.id, email: user.email, username: user.username };
}

async function hashPassword(password, salt) {
  const derived = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return derived.toString('hex');
}

async function readBody(req) {
  if (req.body !== undefined) {
    const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) throw new Error('El contenido supera el tamaño permitido.');
    try { return JSON.parse(body); } catch { throw new Error('El contenido JSON no es válido.'); }
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > MAX_BODY_BYTES) throw new Error('El contenido supera el tamaño permitido.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('El contenido JSON no es válido.'); }
}

function getCookie(req, name) {
  const cookies = (req.headers.cookie || '').split(';');
  const pair = cookies.map(cookie => cookie.trim()).find(cookie => cookie.startsWith(`${name}=`));
  return pair ? decodeURIComponent(pair.slice(name.length + 1)) : '';
}

function sessionCookie(req, token, maxAge) {
  const secure = process.env.VERCEL || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

async function createUser(user) {
  if (storageMode() === 'redis') {
    const userKey = `alphatrade:user:${sha256(user.email)}`;
    const usernameKey = `alphatrade:username:${sha256(user.username)}`;
    const idKey = `alphatrade:id:${user.id}`;
    const tradesKey = `alphatrade:trades:${user.id}`;
    const script = [
      "if redis.call('EXISTS', KEYS[1]) == 1 then return 'EMAIL_EXISTS' end",
      "if redis.call('EXISTS', KEYS[2]) == 1 then return 'USERNAME_EXISTS' end",
      "redis.call('SET', KEYS[1], ARGV[1])",
      "redis.call('SET', KEYS[2], ARGV[2])",
      "redis.call('SET', KEYS[3], KEYS[1])",
      "redis.call('SET', KEYS[4], '[]')",
      "return 'OK'"
    ].join('; ');
    const result = await redisCommand('EVAL', script, '4', userKey, usernameKey, idKey, tradesKey, JSON.stringify(user), user.email);
    if (result !== 'OK') return result;
    return 'OK';
  }

  const data = readLocalData();
  data.users = data.users || {};
  data.usernames = data.usernames || {};
  data.ids = data.ids || {};
  const emailKey = sha256(user.email);
  const usernameKey = sha256(user.username);
  if (data.users[emailKey]) return 'EMAIL_EXISTS';
  if (data.usernames[usernameKey]) return 'USERNAME_EXISTS';
  data.users[emailKey] = user;
  data.usernames[usernameKey] = emailKey;
  data.ids[user.id] = emailKey;
  data.trades = data.trades || {};
  data.trades[user.id] = [];
  writeLocalData(data);
  return 'OK';
}

async function findUser(identity) {
  const value = normalizedIdentity(identity);
  if (storageMode() === 'redis') {
    let email = value;
    if (!value.includes('@')) {
      const emailKey = await redisCommand('GET', `alphatrade:username:${sha256(value)}`);
      if (!emailKey) return null;
      email = emailKey;
    }
    const user = await redisCommand('GET', `alphatrade:user:${sha256(email)}`);
    return user ? JSON.parse(user) : null;
  }

  const data = readLocalData();
  const emailKey = value.includes('@') ? sha256(value) : (data.usernames || {})[sha256(value)];
  return emailKey ? (data.users || {})[emailKey] || null : null;
}

async function findUserById(id) {
  if (storageMode() === 'redis') {
    const userKey = await redisCommand('GET', `alphatrade:id:${id}`);
    if (!userKey) return null;
    const user = await redisCommand('GET', userKey);
    return user ? JSON.parse(user) : null;
  }
  const data = readLocalData();
  const emailKey = (data.ids || {})[id];
  return emailKey ? (data.users || {})[emailKey] || null : null;
}

async function updateUser(user) {
  if (storageMode() === 'redis') {
    await redisCommand('SET', `alphatrade:user:${sha256(user.email)}`, JSON.stringify(user));
    return;
  }
  const data = readLocalData();
  data.users[sha256(user.email)] = user;
  writeLocalData(data);
}

async function saveSession(token, user) {
  const key = sha256(token);
  const value = JSON.stringify({ id: user.id, version: user.sessionVersion });
  if (storageMode() === 'redis') {
    await redisCommand('SET', `alphatrade:session:${key}`, value, 'EX', String(SESSION_TTL_SECONDS));
    return;
  }
  const data = readLocalData();
  data.sessions = data.sessions || {};
  data.sessions[key] = { id: user.id, version: user.sessionVersion, expiresAt: Date.now() + SESSION_TTL_SECONDS * 1000 };
  writeLocalData(data);
}

async function deleteSession(token) {
  if (!token) return;
  const key = sha256(token);
  if (storageMode() === 'redis') {
    await redisCommand('DEL', `alphatrade:session:${key}`);
    return;
  }
  const data = readLocalData();
  delete (data.sessions || {})[key];
  writeLocalData(data);
}

async function getSessionUser(req) {
  const token = getCookie(req, SESSION_COOKIE);
  if (!token) return null;
  const key = sha256(token);
  let session;
  if (storageMode() === 'redis') {
    const value = await redisCommand('GET', `alphatrade:session:${key}`);
    session = value ? JSON.parse(value) : null;
  } else {
    const data = readLocalData();
    session = (data.sessions || {})[key] || null;
    if (session && session.expiresAt < Date.now()) {
      delete data.sessions[key];
      writeLocalData(data);
      session = null;
    }
  }
  if (!session) return null;
  const user = await findUserById(session.id);
  return user && user.sessionVersion === session.version ? user : null;
}

async function saveTrades(userId, trades) {
  if (storageMode() === 'redis') {
    await redisCommand('SET', `alphatrade:trades:${userId}`, JSON.stringify(trades));
    return;
  }
  const data = readLocalData();
  data.trades = data.trades || {};
  data.trades[userId] = trades;
  writeLocalData(data);
}

async function loadTrades(userId) {
  if (storageMode() === 'redis') {
    const value = await redisCommand('GET', `alphatrade:trades:${userId}`);
    if (!value) return [];
    try {
      const trades = JSON.parse(value);
      return Array.isArray(trades) ? trades : [];
    } catch {
      throw new Error('Los datos guardados de esta cuenta están dañados.');
    }
  }
  const data = readLocalData();
  const trades = (data.trades || {})[userId] || [];
  if (!Array.isArray(trades)) throw new Error('Los datos guardados de esta cuenta están dañados.');
  return trades;
}

async function createResetToken(userId, token) {
  const key = sha256(token);
  if (storageMode() === 'redis') {
    await redisCommand('SET', `alphatrade:reset:${key}`, userId, 'EX', String(RESET_TTL_SECONDS));
    return;
  }
  const data = readLocalData();
  data.resets = data.resets || {};
  data.resets[key] = { id: userId, expiresAt: Date.now() + RESET_TTL_SECONDS * 1000 };
  writeLocalData(data);
}

async function consumeResetToken(token) {
  const key = sha256(token);
  if (storageMode() === 'redis') {
    const redisKey = `alphatrade:reset:${key}`;
    const userId = await redisCommand('GET', redisKey);
    if (userId) await redisCommand('DEL', redisKey);
    return userId || null;
  }
  const data = readLocalData();
  const entry = (data.resets || {})[key];
  if (entry) {
    delete data.resets[key];
    writeLocalData(data);
  }
  return entry && entry.expiresAt > Date.now() ? entry.id : null;
}

function getOrigin(req) {
  const protocol = req.headers['x-forwarded-proto'] || (req.socket && req.socket.encrypted ? 'https' : 'http');
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  if (!host) throw new Error('No se pudo determinar el dominio de esta aplicación.');
  return `${protocol}://${host}`;
}

async function sendResetEmail(req, user, token) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL;
  if (!apiKey || !from) throw new Error('Para enviar recuperación por correo configura RESEND_API_KEY y RESEND_FROM_EMAIL.');
  const link = `${getOrigin(req)}/?reset=${encodeURIComponent(token)}`;
  let response;
  try {
    response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from,
        to: [user.email],
        subject: 'Restablece tu contraseña de AlphaTrade',
        text: `Hola ${user.username},\n\nPara restablecer tu contraseña, abre este enlace en los próximos 30 minutos:\n${link}\n\nSi no solicitaste este cambio, ignora este correo.`,
        html: `<p>Hola ${user.username},</p><p>Para restablecer tu contraseña, usa este enlace válido durante 30 minutos:</p><p><a href="${link}">Restablecer contraseña</a></p><p>Si no solicitaste este cambio, ignora este correo.</p>`
      })
    });
  } catch {
    throw new Error('No se pudo conectar con el servicio de correo. Revisa su disponibilidad e inténtalo otra vez.');
  }
  if (!response.ok) throw new Error('No se pudo enviar el correo de recuperación. Revisa la configuración del servicio de correo.');
}

async function incrementLoginAttempts(key) {
  if (storageMode() === 'redis') {
    const redisKey = `alphatrade:login-limit:${sha256(key)}`;
    const attempts = Number(await redisCommand('INCR', redisKey));
    if (attempts === 1) await redisCommand('EXPIRE', redisKey, String(LOGIN_ATTEMPTS_TTL_MS / 1000));
    return attempts;
  }
  const now = Date.now();
  const current = localLoginAttempts.get(key);
  const entry = current && current.expiresAt > now
    ? current
    : { count: 0, expiresAt: now + LOGIN_ATTEMPTS_TTL_MS };
  entry.count++;
  localLoginAttempts.set(key, entry);
  return entry.count;
}

async function handleRequest(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Allow': 'GET, POST, PUT, OPTIONS' });
    res.end();
    return;
  }

  const action = new URL(req.url, 'http://localhost').searchParams.get('action') || '';
  if (req.method === 'GET' && action === 'session') {
    const user = await getSessionUser(req);
    sendJson(res, 200, { user: user ? safeUser(user) : null });
    return;
  }
  if (req.method === 'GET' && action === 'trades') {
    const user = await getSessionUser(req);
    if (!user) return sendJson(res, 401, { error: 'Inicia sesión para ver las operaciones.' });
    sendJson(res, 200, { trades: await loadTrades(user.id) });
    return;
  }
  if (req.method === 'PUT' && action === 'trades') {
    const user = await getSessionUser(req);
    if (!user) return sendJson(res, 401, { error: 'La sesión venció. Inicia sesión otra vez.' });
    const body = await readBody(req);
    if (!Array.isArray(body.trades) || body.trades.length > 20000) {
      return sendJson(res, 400, { error: 'El formato o la cantidad de operaciones no son válidos.' });
    }
    await saveTrades(user.id, body.trades);
    sendJson(res, 200, { success: true, savedAt: new Date().toISOString() });
    return;
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST, PUT, OPTIONS');
    return sendJson(res, 405, { error: 'Método no admitido.' });
  }

  const body = await readBody(req);
  if (body.action === 'register') {
    const email = normalizedIdentity(String(body.email || ''));
    const username = normalizedIdentity(String(body.username || ''));
    const password = String(body.password || '');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
      return sendJson(res, 400, { error: 'Escribe un correo electrónico válido.' });
    }
    if (!/^[a-z0-9._-]{3,30}$/.test(username)) {
      return sendJson(res, 400, { error: 'El nombre debe tener entre 3 y 30 caracteres: letras, números, punto, guion o guion bajo.' });
    }
    if (password.length < 8 || password.length > 128) {
      return sendJson(res, 400, { error: 'La contraseña debe tener entre 8 y 128 caracteres.' });
    }
    const salt = crypto.randomBytes(16).toString('hex');
    const user = {
      id: crypto.randomUUID(),
      email,
      username,
      salt,
      passwordHash: await hashPassword(password, salt),
      sessionVersion: 0,
      createdAt: new Date().toISOString()
    };
    const result = await createUser(user);
    if (result === 'EMAIL_EXISTS') return sendJson(res, 409, { error: 'Ya existe una cuenta con ese correo.' });
    if (result === 'USERNAME_EXISTS') return sendJson(res, 409, { error: 'Ese nombre de usuario ya está ocupado.' });
    const token = crypto.randomBytes(32).toString('base64url');
    await saveSession(token, user);
    sendJson(res, 201, { user: safeUser(user) }, { 'Set-Cookie': sessionCookie(req, token, SESSION_TTL_SECONDS) });
    return;
  }

  if (body.action === 'login') {
    const identity = String(body.identity || '');
    const password = String(body.password || '');
    if (identity.length > 254 || !password || password.length > 128) {
      return sendJson(res, 400, { error: 'Indica tu correo o nombre de usuario y contraseña.' });
    }
    const sourceIp = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
    const attempts = await Promise.all([
      incrementLoginAttempts(`ip:${sourceIp}`),
      incrementLoginAttempts(`identity:${sourceIp}:${normalizedIdentity(identity)}`)
    ]);
    if (attempts[0] > 30 || attempts[1] > 10) {
      return sendJson(res, 429, { error: 'Demasiados intentos. Espera 15 minutos antes de volver a probar.' });
    }
    const user = await findUser(identity);
    const validHash = user ? await hashPassword(password, user.salt) : await hashPassword(password, 'invalid-user-salt');
    const expected = user ? user.passwordHash : '0'.repeat(128);
    const valid = crypto.timingSafeEqual(Buffer.from(validHash, 'hex'), Buffer.from(expected, 'hex'));
    if (!valid) return sendJson(res, 401, { error: 'Usuario o contraseña incorrectos.' });
    const token = crypto.randomBytes(32).toString('base64url');
    await saveSession(token, user);
    sendJson(res, 200, { user: safeUser(user) }, { 'Set-Cookie': sessionCookie(req, token, SESSION_TTL_SECONDS) });
    return;
  }

  if (body.action === 'logout') {
    await deleteSession(getCookie(req, SESSION_COOKIE));
    sendJson(res, 200, { success: true }, { 'Set-Cookie': sessionCookie(req, '', 0) });
    return;
  }

  if (body.action === 'request-reset') {
    const email = normalizedIdentity(String(body.email || ''));
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
      return sendJson(res, 400, { error: 'Escribe un correo electrónico válido.' });
    }
    if (!process.env.RESEND_API_KEY || !process.env.RESEND_FROM_EMAIL) {
      return sendJson(res, 503, { error: 'La recuperación por correo no está configurada. El operador debe configurar el envío de correo en el servidor.' });
    }
    const user = await findUser(email);
    if (user) {
      const token = crypto.randomBytes(32).toString('base64url');
      await createResetToken(user.id, token);
      try {
        await sendResetEmail(req, user, token);
      } catch (error) {
        return sendJson(res, 503, { error: error.message });
      }
    }
    sendJson(res, 200, { message: 'Si el correo corresponde a una cuenta, recibirás instrucciones para restablecer la contraseña.' });
    return;
  }

  if (body.action === 'reset-password') {
    const token = String(body.token || '');
    const password = String(body.password || '');
    if (password.length < 8 || password.length > 128) {
      return sendJson(res, 400, { error: 'La contraseña debe tener entre 8 y 128 caracteres.' });
    }
    const userId = await consumeResetToken(token);
    if (!userId) return sendJson(res, 400, { error: 'El enlace venció o ya fue utilizado. Solicita uno nuevo.' });
    const user = await findUserById(userId);
    if (!user) return sendJson(res, 400, { error: 'No se encontró la cuenta asociada al enlace.' });
    user.salt = crypto.randomBytes(16).toString('hex');
    user.passwordHash = await hashPassword(password, user.salt);
    user.sessionVersion++;
    await updateUser(user);
    sendJson(res, 200, { success: true });
    return;
  }

  sendJson(res, 400, { error: 'Acción de autenticación no admitida.' });
}

module.exports = async function auth(req, res) {
  try {
    await handleRequest(req, res);
  } catch (error) {
    const status = 500;
    sendJson(res, status, {
      error: error.message || 'No se pudo completar la solicitud. Inténtalo otra vez.'
    });
  }
};

