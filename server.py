#!/usr/bin/env python3
"""
Servidor Local Opcional para Diario de Trading Pro en Python 3
Permite abrir la app y sincronizar en PC y Celular en la misma red Wi-Fi
"""
import os
import sys
import json
import socket
import re
import datetime
from http.server import HTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse, parse_qs, urlencode
from urllib.request import urlopen
from urllib.error import HTTPError, URLError

PORT = int(os.environ.get("PORT", 3000))
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_FILE = os.path.join(BASE_DIR, "database_sync.json")
MARKET_INTERVALS = {"1min", "5min", "15min", "30min", "60min"}
MACRO_FUNCTIONS = {"FEDERAL_FUNDS_RATE", "CPI", "INFLATION", "UNEMPLOYMENT", "NONFARM_PAYROLL", "REAL_GDP", "TREASURY_YIELD"}
COMMODITY_FUNCTIONS = {"WTI", "BRENT", "NATURAL_GAS", "COPPER", "ALUMINUM", "WHEAT", "CORN", "COTTON", "SUGAR", "COFFEE"}

if not os.path.exists(DB_FILE):
    with open(DB_FILE, "w", encoding="utf-8") as f:
        json.dump({"users": {}, "vaults": {}}, f, indent=2)

def get_local_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "localhost"

def build_market_request(query):
    asset_type = query.get("assetType", [""])[0]
    analysis = query.get("analysis", [""])[0]
    symbol = query.get("symbol", [""])[0].strip().upper()
    interval = query.get("interval", ["5min"])[0]
    params = {}

    if asset_type not in {"equity", "index", "forex", "crypto", "commodity", "macro"}:
        raise ValueError("Tipo de activo no admitido.")
    if analysis not in {"technical", "fundamentals", "news"}:
        raise ValueError("Tipo de análisis no admitido.")

    if analysis == "technical":
        if interval not in MARKET_INTERVALS:
            raise ValueError("Temporalidad no admitida.")
        if asset_type in {"equity", "index"}:
            if not re.fullmatch(r"[A-Z0-9.^_-]{1,20}", symbol):
                raise ValueError("Indica un símbolo válido.")
            params.update({
                "function": "TIME_SERIES_INTRADAY" if asset_type == "equity" else "INDEX_DATA",
                "symbol": symbol,
                "interval": interval,
                "outputsize": "compact"
            })
        elif asset_type == "forex":
            pair = symbol.split("/")
            if len(pair) != 2 or not all(re.fullmatch(r"[A-Z]{3}", code) for code in pair):
                raise ValueError("Usa el formato de divisa AAA/BBB, por ejemplo EUR/USD.")
            params.update({"function": "FX_INTRADAY", "from_symbol": pair[0], "to_symbol": pair[1], "interval": interval, "outputsize": "compact"})
        elif asset_type == "crypto":
            pair = symbol.split("/")
            base, quote = pair[0], pair[1] if len(pair) == 2 else "USD"
            if not re.fullmatch(r"[A-Z0-9]{2,12}", base) or not re.fullmatch(r"[A-Z]{3,5}", quote):
                raise ValueError("Usa un símbolo cripto como BTC o BTC/USD.")
            params.update({"function": "CRYPTO_INTRADAY", "symbol": base, "market": quote, "interval": interval, "outputsize": "compact"})
        elif asset_type == "commodity":
            if symbol not in COMMODITY_FUNCTIONS:
                raise ValueError(f"Materia prima no admitida. Opciones: {', '.join(sorted(COMMODITY_FUNCTIONS))}.")
            params.update({"function": symbol, "interval": "daily"})
        else:
            raise ValueError("El análisis técnico de indicadores macro no está disponible; selecciona una serie temporal de mercado.")
    elif analysis == "fundamentals":
        if asset_type == "equity":
            if not re.fullmatch(r"[A-Z0-9.^_-]{1,20}", symbol):
                raise ValueError("Indica un símbolo bursátil válido.")
            params.update({"function": "OVERVIEW", "symbol": symbol})
        elif asset_type == "macro":
            if symbol not in MACRO_FUNCTIONS:
                raise ValueError(f"Indicador no admitido. Opciones: {', '.join(sorted(MACRO_FUNCTIONS))}.")
            params["function"] = symbol
            if symbol == "TREASURY_YIELD":
                params.update({"interval": "monthly", "maturity": "10year"})
            elif symbol not in {"INFLATION", "UNEMPLOYMENT", "NONFARM_PAYROLL", "REAL_GDP"}:
                params["interval"] = "monthly"
        else:
            raise ValueError("Alpha Vantage ofrece fundamentales corporativos para acciones e indicadores macro. Esta clase de activo no tiene esos campos disponibles.")
    else:
        params.update({"function": "NEWS_SENTIMENT", "sort": "LATEST", "limit": "5"})
        if asset_type == "equity":
            if not re.fullmatch(r"[A-Z0-9.^_-]{1,20}", symbol):
                raise ValueError("Indica un símbolo válido para filtrar noticias.")
            params["tickers"] = symbol
        else:
            params["topics"] = {
                "index": "financial_markets",
                "forex": "economy_macro",
                "crypto": "blockchain",
                "commodity": "energy_transportation",
                "macro": "economy_macro"
            }[asset_type]

    return {"assetType": asset_type, "analysis": analysis, "symbol": symbol, "params": params}

def fetch_market_data(handler, query):
    try:
        request = build_market_request(query)
    except ValueError as error:
        handler.write_json(400, {"error": str(error)})
        return

    api_key = os.environ.get("ALPHAVANTAGE_API_KEY")
    if not api_key:
        handler.write_json(503, {"error": "Datos de mercado no configurados. Define ALPHAVANTAGE_API_KEY en el entorno del servidor."})
        return

    request["params"]["apikey"] = api_key
    url = "https://www.alphavantage.co/query?" + urlencode(request["params"])
    try:
        with urlopen(url, timeout=15) as response:
            body = response.read(2_000_001)
    except HTTPError as error:
        handler.write_json(502, {"error": f"Alpha Vantage respondió HTTP {error.code}."})
        return
    except URLError as error:
        handler.write_json(502, {"error": f"No se pudo consultar Alpha Vantage: {error.reason}"})
        return
    except TimeoutError:
        handler.write_json(502, {"error": "Tiempo de espera agotado al consultar Alpha Vantage."})
        return

    if len(body) > 2_000_000:
        handler.write_json(502, {"error": "La respuesta del proveedor supera el límite permitido."})
        return
    try:
        data = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        handler.write_json(502, {"error": "El proveedor devolvió una respuesta no válida."})
        return

    if not isinstance(data, dict):
        handler.write_json(502, {"error": "El proveedor devolvió un formato de datos no admitido."})
        return
    provider_error = data.get("Error Message") or data.get("Information") or data.get("Note")
    if provider_error:
        status = 429 if data.get("Note") or re.search(r"rate limit|call frequency", provider_error, re.IGNORECASE) else 502
        handler.write_json(status, {"error": provider_error})
        return

    configured_mode = os.environ.get("ALPHAVANTAGE_MARKET_DATA_MODE")
    market_data_mode = configured_mode if configured_mode in {"realtime", "delayed"} else "unknown"
    handler.write_json(200, {
        "provider": "Alpha Vantage",
        "assetType": request["assetType"],
        "analysis": request["analysis"],
        "symbol": request["symbol"],
        "retrievedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "marketDataMode": market_data_mode,
        "entitlementVerified": False,
        "data": data
    })

class TradingServerHandler(SimpleHTTPRequestHandler):
    def write_json(self, status, payload):
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.end_headers()
        self.wfile.write(json.dumps(payload).encode("utf-8"))

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)

        if parsed.path == "/api/info":
            ip = get_local_ip()
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(json.dumps({
                "status": "online",
                "ip": ip,
                "port": PORT,
                "lanUrl": f"http://{ip}:{PORT}"
            }).encode("utf-8"))
            return

        if parsed.path == "/api/market":
            fetch_market_data(self, parse_qs(parsed.query))
            return

        if parsed.path.startswith("/api/sync"):
            query = parse_qs(parsed.query)
            vault_id = query.get("vaultId", [None])[0]
            try:
                with open(DB_FILE, "r", encoding="utf-8") as f:
                    db = json.load(f)
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.end_headers()
                res_data = db.get("vaults", {}).get(vault_id, None) if vault_id else {"status": "ok"}
                self.wfile.write(json.dumps(res_data).encode("utf-8"))
            except Exception as e:
                self.send_response(500)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.end_headers()
                self.wfile.write(json.dumps({"error": str(e)}).encode("utf-8"))
            return

        # Serve static files
        req_path = parsed.path.lstrip("/")
        if not req_path or req_path == "DashBoard-Planificacion-main" or req_path.startswith("DashBoard-Planificacion-main/"):
            req_path = "index.html"

        candidate1 = os.path.join(BASE_DIR, req_path)
        candidate2 = os.path.join(BASE_DIR, "DashBoard-Planificacion-main", req_path)
        target = candidate1 if os.path.exists(candidate1) else (candidate2 if os.path.exists(candidate2) else None)

        if target and os.path.isfile(target):
            self.path = os.path.relpath(target, os.getcwd())
            return super().do_GET()

        fallback = os.path.join(BASE_DIR, "index.html")
        if os.path.exists(fallback):
            self.path = os.path.relpath(fallback, os.getcwd())
            return super().do_GET()

        return super().do_GET()

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/market":
            self.write_json(405, {"error": "Este endpoint solo admite GET."})
            return
        if parsed.path.startswith("/api/sync"):
            length = int(self.headers.get("Content-Length", 0))
            raw_body = self.rfile.read(length).decode("utf-8")
            try:
                payload = json.loads(raw_body)
                vault_id = payload.get("vaultId")
                data_val = payload.get("data")
                if vault_id and data_val:
                    with open(DB_FILE, "r", encoding="utf-8") as f:
                        db = json.load(f)
                    if "vaults" not in db:
                        db["vaults"] = {}
                    db["vaults"][vault_id] = {
                        "data": data_val,
                        "updatedAt": os.path.getmtime(DB_FILE)
                    }
                    with open(DB_FILE, "w", encoding="utf-8") as f:
                        json.dump(db, f, indent=2)
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json; charset=utf-8")
                    self.end_headers()
                    self.wfile.write(json.dumps({"success": True}).encode("utf-8"))
                else:
                    self.send_response(400)
                    self.send_header("Content-Type", "application/json; charset=utf-8")
                    self.end_headers()
                    self.wfile.write(json.dumps({"error": "Parametros invalidos"}).encode("utf-8"))
            except Exception as e:
                self.send_response(500)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.end_headers()
                self.wfile.write(json.dumps({"error": str(e)}).encode("utf-8"))
            return

def run():
    ip = get_local_ip()
    print("=" * 64)
    print("  🚀 Servidor Diario de Trading Pro Activo (Python)")
    print("=" * 64)
    print(f"  💻 Acceso en tu PC:      http://localhost:{PORT}")
    print(f"  📱 Acceso en tu Celular: http://{ip}:{PORT}")
    print("=" * 64)
    print("  (Conecta ambos dispositivos a la misma red Wi-Fi)")
    print("=" * 64 + "\n")
    server_address = ("0.0.0.0", PORT)
    httpd = HTTPServer(server_address, TradingServerHandler)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nServidor detenido.")
        sys.exit(0)

if __name__ == "__main__":
    run()
