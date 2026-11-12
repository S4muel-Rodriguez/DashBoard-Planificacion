const MARKET_INTERVALS = new Set(['1min', '5min', '15min', '30min', '60min']);
const MACRO_FUNCTIONS = new Set(['FEDERAL_FUNDS_RATE', 'CPI', 'INFLATION', 'UNEMPLOYMENT', 'NONFARM_PAYROLL', 'REAL_GDP', 'TREASURY_YIELD']);
const COMMODITY_FUNCTIONS = new Set(['WTI', 'BRENT', 'NATURAL_GAS', 'COPPER', 'ALUMINUM', 'WHEAT', 'CORN', 'COTTON', 'SUGAR', 'COFFEE']);
const ASSET_TYPES = new Set(['equity', 'index', 'forex', 'crypto', 'commodity', 'macro']);
const ANALYSES = new Set(['technical', 'fundamentals', 'news']);

function buildMarketRequest(params) {
  const assetType = params.get('assetType');
  const analysis = params.get('analysis');
  const symbol = (params.get('symbol') || '').trim().toUpperCase();
  const interval = params.get('interval') || '5min';
  const alphaParams = new URLSearchParams();

  if (!ASSET_TYPES.has(assetType)) throw new Error('Tipo de activo no admitido.');
  if (!ANALYSES.has(analysis)) throw new Error('Tipo de análisis no admitido.');

  if (analysis === 'technical') {
    if (!MARKET_INTERVALS.has(interval)) throw new Error('Temporalidad no admitida.');
    if (assetType === 'equity' || assetType === 'index') {
      if (!/^[A-Z0-9.^_-]{1,20}$/.test(symbol)) throw new Error('Indica un símbolo válido.');
      alphaParams.set('function', assetType === 'equity' ? 'TIME_SERIES_INTRADAY' : 'INDEX_DATA');
      alphaParams.set('symbol', symbol);
      alphaParams.set('interval', interval);
      alphaParams.set('outputsize', 'compact');
    } else if (assetType === 'forex') {
      const pair = symbol.split('/');
      if (pair.length !== 2 || !pair.every(code => /^[A-Z]{3}$/.test(code))) {
        throw new Error('Usa el formato de divisa AAA/BBB, por ejemplo EUR/USD.');
      }
      alphaParams.set('function', 'FX_INTRADAY');
      alphaParams.set('from_symbol', pair[0]);
      alphaParams.set('to_symbol', pair[1]);
      alphaParams.set('interval', interval);
      alphaParams.set('outputsize', 'compact');
    } else if (assetType === 'crypto') {
      const pair = symbol.split('/');
      const base = pair[0];
      const quote = pair[1] || 'USD';
      if (!/^[A-Z0-9]{2,12}$/.test(base) || !/^[A-Z]{3,5}$/.test(quote)) {
        throw new Error('Usa un símbolo cripto como BTC o BTC/USD.');
      }
      alphaParams.set('function', 'CRYPTO_INTRADAY');
      alphaParams.set('symbol', base);
      alphaParams.set('market', quote);
      alphaParams.set('interval', interval);
      alphaParams.set('outputsize', 'compact');
    } else if (assetType === 'commodity') {
      if (!COMMODITY_FUNCTIONS.has(symbol)) {
        throw new Error(`Materia prima no admitida. Opciones: ${[...COMMODITY_FUNCTIONS].join(', ')}.`);
      }
      alphaParams.set('function', symbol);
      alphaParams.set('interval', 'daily');
    } else {
      throw new Error('El análisis técnico de indicadores macro no está disponible; selecciona una serie temporal de mercado.');
    }
  } else if (analysis === 'fundamentals') {
    if (assetType === 'equity') {
      if (!/^[A-Z0-9.^_-]{1,20}$/.test(symbol)) throw new Error('Indica un símbolo bursátil válido.');
      alphaParams.set('function', 'OVERVIEW');
      alphaParams.set('symbol', symbol);
    } else if (assetType === 'macro') {
      if (!MACRO_FUNCTIONS.has(symbol)) {
        throw new Error(`Indicador no admitido. Opciones: ${[...MACRO_FUNCTIONS].join(', ')}.`);
      }
      alphaParams.set('function', symbol);
      if (symbol === 'TREASURY_YIELD') {
        alphaParams.set('interval', 'monthly');
        alphaParams.set('maturity', '10year');
      } else if (!['INFLATION', 'UNEMPLOYMENT', 'NONFARM_PAYROLL', 'REAL_GDP'].includes(symbol)) {
        alphaParams.set('interval', 'monthly');
      }
    } else {
      throw new Error('Alpha Vantage ofrece fundamentales corporativos para acciones e indicadores macro.');
    }
  } else {
    alphaParams.set('function', 'NEWS_SENTIMENT');
    alphaParams.set('sort', 'LATEST');
    alphaParams.set('limit', '5');
    if (assetType === 'equity') {
      if (!/^[A-Z0-9.^_-]{1,20}$/.test(symbol)) throw new Error('Indica un símbolo válido para filtrar noticias.');
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

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

module.exports = async function market(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    sendJson(res, 405, { error: 'Este endpoint solo admite GET.' });
    return;
  }

  let request;
  try {
    const url = new URL(req.url, 'https://vercel.local');
    request = buildMarketRequest(url.searchParams);
  } catch (error) {
    sendJson(res, 400, { error: error.message });
    return;
  }

  const apiKey = process.env.ALPHAVANTAGE_API_KEY;
  if (!apiKey) {
    sendJson(res, 503, { error: 'Datos de mercado no configurados. Define ALPHAVANTAGE_API_KEY en las variables de entorno de Vercel.' });
    return;
  }

  request.alphaParams.set('apikey', apiKey);
  const upstreamUrl = new URL('https://www.alphavantage.co/query');
  upstreamUrl.search = request.alphaParams.toString();

  let upstreamResponse;
  let data;
  try {
    upstreamResponse = await fetch(upstreamUrl, { signal: AbortSignal.timeout(15000) });
    const body = await upstreamResponse.text();
    if (body.length > 2_000_000) {
      sendJson(res, 502, { error: 'La respuesta del proveedor supera el límite permitido.' });
      return;
    }
    try {
      data = JSON.parse(body);
    } catch {
      sendJson(res, 502, { error: 'El proveedor devolvió una respuesta no válida.' });
      return;
    }
  } catch (error) {
    const message = error.name === 'TimeoutError'
      ? 'Tiempo de espera agotado al consultar Alpha Vantage.'
      : `No se pudo consultar Alpha Vantage: ${error.message}`;
    sendJson(res, 502, { error: message });
    return;
  }

  if (!upstreamResponse.ok) {
    sendJson(res, 502, { error: `Alpha Vantage respondió HTTP ${upstreamResponse.status}.` });
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
};

