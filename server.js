// Servidor Local Opcional para Diario de Trading Pro
// Permite sincronizar PC y Celular en la misma red Wi-Fi de forma directa
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');

const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'database_sync.json');
const MARKET_INTERVALS = new Set(['1min', '5min', '15min', '30min', '60min']);
const MACRO_FUNCTIONS = new Set(['FEDERAL_FUNDS_RATE', 'CPI', 'INFLATION', 'UNEMPLOYMENT', 'NONFARM_PAYROLL', 'REAL_GDP', 'TREASURY_YIELD']);
const COMMODITY_FUNCTIONS = new Set(['WTI', 'BRENT', 'NATURAL_GAS', 'COPPER', 'ALUMINUM', 'WHEAT', 'CORN', 'COTTON', 'SUGAR', 'COFFEE']);

// Inicializar archivo de base de datos si no existe
if (!fs.existsSync(DB_FILE)) {
  fs.writeFileSync(DB_FILE, JSON.stringify({ users: {}, vaults: {}, updatedAt: Date.now() }, null, 2), 'utf8');
}

function getLocalIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function buildMarketRequest(params) {
  const assetType = params.get('assetType');
  const analysis = params.get('analysis');
  const symbol = (params.get('symbol') || '').trim().toUpperCase();
  const interval = params.get('interval') || '5min';
  const alphaParams = new URLSearchParams();

  if (!['equity', 'index', 'forex', 'crypto', 'commodity', 'macro'].includes(assetType)) {
    return { error: 'Tipo de activo no admitido.' };
  }
  if (!['technical', 'fundamentals', 'news'].includes(analysis)) {
    return { error: 'Tipo de análisis no admitido.' };
  }

  if (analysis === 'technical') {
    if (!MARKET_INTERVALS.has(interval)) return { error: 'Temporalidad no admitida.' };
    if (assetType === 'equity' || assetType === 'index') {
      if (!/^[A-Z0-9.^_-]{1,20}$/.test(symbol)) return { error: 'Indica un símbolo válido.' };
      alphaParams.set('function', assetType === 'equity' ? 'TIME_SERIES_INTRADAY' : 'INDEX_DATA');
      alphaParams.set('symbol', symbol);
      alphaParams.set('interval', interval);
      alphaParams.set('outputsize', 'compact');
    } else if (assetType === 'forex') {
      const pair = symbol.split('/');
      if (pair.length !== 2 || !pair.every(code => /^[A-Z]{3}$/.test(code))) return { error: 'Usa el formato de divisa AAA/BBB, por ejemplo EUR/USD.' };
      alphaParams.set('function', 'FX_INTRADAY');
      alphaParams.set('from_symbol', pair[0]);
      alphaParams.set('to_symbol', pair[1]);
      alphaParams.set('interval', interval);
      alphaParams.set('outputsize', 'compact');
    } else if (assetType === 'crypto') {
      const pair = symbol.split('/');
      const base = pair[0];
      const quote = pair[1] || 'USD';
      if (!/^[A-Z0-9]{2,12}$/.test(base) || !/^[A-Z]{3,5}$/.test(quote)) return { error: 'Usa un símbolo cripto como BTC o BTC/USD.' };
      alphaParams.set('function', 'CRYPTO_INTRADAY');
      alphaParams.set('symbol', base);
      alphaParams.set('market', quote);
      alphaParams.set('interval', interval);
      alphaParams.set('outputsize', 'compact');
    } else if (assetType === 'commodity') {
      if (!COMMODITY_FUNCTIONS.has(symbol)) return { error: `Materia prima no admitida. Opciones: ${[...COMMODITY_FUNCTIONS].join(', ')}.` };
      alphaParams.set('function', symbol);
      alphaParams.set('interval', 'daily');
    } else {
      return { error: 'El análisis técnico de indicadores macro no está disponible; selecciona una serie temporal de mercado.' };
    }
  } else if (analysis === 'fundamentals') {
    if (assetType === 'equity') {
      if (!/^[A-Z0-9.^_-]{1,20}$/.test(symbol)) return { error: 'Indica un símbolo bursátil válido.' };
      alphaParams.set('function', 'OVERVIEW');
      alphaParams.set('symbol', symbol);
    } else if (assetType === 'macro') {
      if (!MACRO_FUNCTIONS.has(symbol)) return { error: `Indicador no admitido. Opciones: ${[...MACRO_FUNCTIONS].join(', ')}.` };
      alphaParams.set('function', symbol);
      if (symbol === 'TREASURY_YIELD') {
        alphaParams.set('interval', 'monthly');
        alphaParams.set('maturity', '10year');
      } else if (symbol !== 'INFLATION' && symbol !== 'UNEMPLOYMENT' && symbol !== 'NONFARM_PAYROLL' && symbol !== 'REAL_GDP') {
        alphaParams.set('interval', 'monthly');
      }
    } else {
      return { error: 'Alpha Vantage ofrece fundamentales corporativos para acciones e indicadores macro. Esta clase de activo no tiene esos campos disponibles.' };
    }
  } else {
    alphaParams.set('function', 'NEWS_SENTIMENT');
    alphaParams.set('sort', 'LATEST');
    alphaParams.set('limit', '5');
    if (assetType === 'equity') {
      if (!/^[A-Z0-9.^_-]{1,20}$/.test(symbol)) return { error: 'Indica un símbolo válido para filtrar noticias.' };
      alphaParams.set('tickers', symbol);
    } else {
      const topics = {
        index: 'financial_markets',
        forex: 'economy_macro',
        crypto: 'blockchain',
        commodity: 'energy_transportation',
        macro: 'economy_macro'
      };
      alphaParams.set('topics', topics[assetType]);
    }
  }

  return { assetType, analysis, symbol, alphaParams };
}

function handleMarketRequest(req, res) {
  const params = new URL(req.url, `http://${req.headers.host}`).searchParams;
  const request = buildMarketRequest(params);
  if (request.error) {
    sendJson(res, 400, { error: request.error });
    return;
  }

  const apiKey = process.env.ALPHAVANTAGE_API_KEY;
  if (!apiKey) {
    sendJson(res, 503, { error: 'Datos de mercado no configurados. Define ALPHAVANTAGE_API_KEY en el entorno del servidor.' });
    return;
  }

  request.alphaParams.set('apikey', apiKey);
  const upstreamUrl = new URL('https://www.alphavantage.co/query');
  upstreamUrl.search = request.alphaParams.toString();
  const upstreamRequest = https.get(upstreamUrl, { timeout: 15000 }, upstreamResponse => {
    let body = '';
    upstreamResponse.setEncoding('utf8');
    upstreamResponse.on('data', chunk => {
      body += chunk;
      if (body.length > 2_000_000) upstreamRequest.destroy(new Error('La respuesta del proveedor supera el límite permitido.'));
    });
    upstreamResponse.on('end', () => {
      let data;
      try {
        data = JSON.parse(body);
      } catch {
        sendJson(res, 502, { error: 'El proveedor devolvió una respuesta no válida.' });
        return;
      }

      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        sendJson(res, 502, { error: 'El proveedor devolvió un formato de datos no admitido.' });
        return;
      }

      const providerError = data['Error Message'] || data.Information || data.Note;
      if (providerError) {
        const status = data.Note || /rate limit|call frequency/i.test(providerError) ? 429 : 502;
        sendJson(res, status, { error: providerError });
        return;
      }

      const configuredMode = process.env.ALPHAVANTAGE_MARKET_DATA_MODE;
      const marketDataMode = configuredMode === 'realtime' || configuredMode === 'delayed' ? configuredMode : 'unknown';
      sendJson(res, 200, {
        provider: 'Alpha Vantage',
        assetType: request.assetType,
        analysis: request.analysis,
        symbol: request.symbol,
        retrievedAt: new Date().toISOString(),
        marketDataMode,
        entitlementVerified: false,
        data
      });
    });
  });

  upstreamRequest.on('timeout', () => upstreamRequest.destroy(new Error('Tiempo de espera agotado al consultar Alpha Vantage.')));
  upstreamRequest.on('error', error => {
    if (!res.headersSent) sendJson(res, 502, { error: `No se pudo consultar Alpha Vantage: ${error.message}` });
  });
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

const server = http.createServer((req, res) => {
  // Configurar CORS para permitir peticiones desde cualquier origen (móvil o web)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // API de información del servidor (IP local para Código QR)
  if (req.url === '/api/info') {
    const ip = getLocalIp();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'online',
      ip: ip,
      port: PORT,
      lanUrl: `http://${ip}:${PORT}`,
      time: Date.now()
    }));
    return;
  }

  if (req.url.startsWith('/api/market')) {
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'Este endpoint solo admite GET.' });
      return;
    }
    handleMarketRequest(req, res);
    return;
  }

  // API de Sincronización entre dispositivos
  if (req.url.startsWith('/api/sync')) {
    if (req.method === 'GET') {
      const urlParams = new URL(req.url, `http://${req.headers.host}`);
      const vaultId = urlParams.searchParams.get('vaultId');
      try {
        const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        if (vaultId) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(data.vaults[vaultId] || null));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok', time: Date.now() }));
        }
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const payload = JSON.parse(body);
          const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
          if (payload.vaultId && payload.data) {
            data.vaults[payload.vaultId] = {
              data: payload.data,
              updatedAt: Date.now()
            };
            fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, savedAt: Date.now() }));
          } else {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Faltan parámetros vaultId o data' }));
          }
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }
  }

  // Servir archivos estáticos
  let reqPath = req.url.split('?')[0];
  if (reqPath === '/' || reqPath === '' || reqPath === '/DashBoard-Planificacion-main' || reqPath.startsWith('/DashBoard-Planificacion-main/')) {
    reqPath = '/index.html';
  }

  let filePath = path.join(__dirname, reqPath);
  if (!fs.existsSync(filePath)) {
    filePath = path.join(__dirname, 'DashBoard-Planificacion-main', reqPath);
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      const fallbackPath = path.join(__dirname, 'index.html');
      if (fs.existsSync(fallbackPath)) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        fs.createReadStream(fallbackPath).pipe(res);
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 No Encontrado');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  const ip = getLocalIp();
  console.log('================================================================');
  console.log('  🚀 Servidor Diario de Trading Pro Activo');
  console.log('================================================================');
  console.log(`  💻 Acceso en tu PC:      http://localhost:${PORT}`);
  console.log(`  📱 Acceso en tu Celular: http://${ip}:${PORT}`);
  console.log('================================================================');
  console.log('  (Conecta ambos dispositivos a la misma red Wi-Fi)');
  console.log('================================================================\n');
});
