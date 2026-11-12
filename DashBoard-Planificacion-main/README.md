# AlphaTrade Pro · Plataforma de Inteligencia Cuantitativa y Trading

**AlphaTrade Pro** es una aplicación web para registrar y analizar operaciones de trading, con asistente contextual, importación de archivos, panel de métricas y consultas opcionales a proveedores de IA y datos de mercado. El acceso de usuario es local al navegador; la sincronización opcional es una función experimental, no un servicio seguro de cuentas ni almacenamiento en la nube.

---

## 🚀 Arquitectura y Funcionalidades Principales

### 1. 🧠 Asistente contextual y métricas auditables
- **Separación Técnica Estricta**:
  - **Base de Datos Viva (`S[]`)**: Registro íntegro de operaciones con fecha, hora, resultado, activo, dirección, comisiones y broker.
  - **Motor de Consulta Temporal**: Aislamiento estricto de períodos matemáticos:
    1. **Todo el historial**: Datos acumulados completos.
    2. **Este mes**: Desde el 1 del mes en curso hasta hoy.
    3. **Últimos 30 días**: Ventana móvil de los últimos 30 días.
    4. **Esta semana**: Desde el lunes actual hasta hoy.
    5. **Hoy**: Únicamente las operaciones del día presente.
  - **Memoria Conversacional**: Gemini recibe los mensajes recientes para responder con continuidad; los mensajes nunca modifican las operaciones.
- **Consultas en Lenguaje Natural Soportadas**:
  - *"¿Cuánto gané este mes?"*
  - *"¿Cómo fueron mis últimos 30 días?"*
  - *"¿Qué cambios hubo respecto al mes anterior?"*
  - *"¿Cuál fue mi mejor semana?"*
  - *"¿Cuáles fueron mis mayores pérdidas y ganancias?"*
  - *"¿Qué tendencias detectás en mis operaciones?"*
- **Integración Híbrida**: Motor cuantitativo local y conexión opcional con la API de Gemini, con un resumen de métricas verificadas como contexto.
- **Datos de mercado bajo demanda**: El panel puede consultar Alpha Vantage desde el servidor para series técnicas, fundamentales corporativos, indicadores macro y noticias. La aplicación no verifica la latencia ni los permisos de bolsa del plan contratado; por eso no etiqueta los datos como tiempo real. Índices y varias series intradía pueden requerir un plan de pago. Los cálculos de SMA/RSI son descriptivos, no señales ni predicciones.

---

### 2. 📥 Sistema de Importación Universal de Brokers
- **Compatibilidad**:
  - **Capital.com**: Detección nativa de reportes de actividad (`Reference`, `Time (UTC)`, `Instrument`, `Direction`, `Net P&L`, `Swap`, `Commission`).
  - **MetaTrader 4 / MetaTrader 5**: Reconocimiento de tickets, tipos, swaps y beneficios.
  - **Binance / Crypto Futures**: Soporte para reportes con `Realized Profit` y comisiones.
  - **Archivos Estructurados**: `.CSV`, `.XLSX`, `.XLS` y `.JSON`.
- **Validación y Pre-Importación**:
  - Cuadro modal con **vista previa de los primeros registros** mapeados.
  - **Detección automática de duplicados** por ID de broker o firma compuesta (`fecha + hora + activo + resultado`).
  - Cálculo previo de comisiones y balance neto total antes de confirmar.

---

### 3. ⭐ Funcionalidades Diferenciales

#### A. 🧠 AI Insights Center
Centro de inteligencia analítica que audita automáticamente los registros reales:
- **Patrón Semanal**: Identifica tu día de mayor y menor rendimiento porcentual y monetario.
- **Detección de Fugas de Capital**: Calcula si un pequeño grupo de operaciones impulsivas explica la mayoría de tus pérdidas.
- **Eficiencia de Sesión**: Compara resultados por franjas horarias (Londres, Nueva York, Asia).
- **Expectativa Matemática**: Calcula el retorno esperado monetario por cada operación ejecutada.

#### B. ⚖️ Comparador Inteligente
- Compara períodos cara a cara:
  - *Este Mes vs. Mes Anterior*
  - *Últimos 30 Días vs. 30 Días Previos*
  - *Esta Semana vs. Semana Anterior*
  - *Todo el Historial vs. Período Seleccionado*
- Visualización de **deltas porcentuales y monetarios** (P&L, Win Rate %, Profit Factor, Trades, Drawdown).
- **Explicación analítica narrativa** generada con los cálculos matemáticos reales.

---

### 4. 📱 Código QR y Acceso Móvil Real
- **Detección de Red Local**: El servidor (`server.js` / `server.py`) expone `/api/info` para que el código QR contenga la IP real de tu red Wi-Fi local (`http://192.168.x.x:3000`).
- **Uso restringido**: El servidor de sincronización no implementa autenticación ni autorización robustas y escucha en interfaces de red. Úsalo solo en localhost o una red de confianza; no lo expongas mediante un dominio público, hosting o túnel.
- **Sincronización opcional**: Compatible con navegadores móviles, pero los datos se escriben en un archivo JSON del servidor sin cifrado de extremo a extremo.

---

### 5. 📑 Exportación e Informes
- **Excel (.xlsx)**: Libro multi-hoja con Resumen Ejecutivo, Operaciones detalladas, Desglose por Mercado y Rendimiento Diario.
- **PDF Vectorial**: Informe corporativo con KPIs, Curva de Equidad en alta resolución, tablas paginadas y numeración automática.
- **Borrado con confirmación**: Verificación interactiva con opción de respaldo previo en Excel y botón "Deshacer" (7 segundos de gracia).

---

## 🏃‍♂️ Cómo Ejecutar la Plataforma

### Opción 1: Con 1 solo clic (Recomendado)
Haz doble clic en **`iniciar.bat`**. Abrirá el servidor local y tu navegador en `http://localhost:3000`.

### Opción 2: Con Node.js o Python
```bash
node server.js
# o
python server.py
```
Abre tu navegador en `http://localhost:3000` (o la IP indicada en tu celular).

### Opción 3: Directo en el Navegador
Abre directamente **`index.html`** en cualquier navegador web moderno.

### Configurar el feed de mercado (opcional)

El feed requiere el servidor local; abrir el HTML directamente no habilita `/api/market`. Obtén tu propia clave de Alpha Vantage y configúrala solo en el entorno del servidor. No la pegues en el HTML, en el navegador ni en el chat, y no la subas al repositorio.

En PowerShell, define la variable y ejecuta el servidor en la misma ventana:

```powershell
$env:ALPHAVANTAGE_API_KEY = "TU_CLAVE"
node server.js
# o, en lugar de Node:
python server.py
```

La variable opcional `ALPHAVANTAGE_MARKET_DATA_MODE` admite `realtime` o `delayed` como indicación configurada por el operador; no valida el plan ni los permisos bursátiles. Si no se define, el modo se muestra como desconocido. Las cuotas y funciones disponibles dependen del proveedor y del plan; el servidor comunica los errores de cuota o de acceso sin sustituirlos por datos inventados.

### Privacidad y términos

Consulta [la política de privacidad](../politica-privacidad.html) y [los términos de uso](../terminos-uso.html). Antes de publicar una instancia, el operador debe completar su identidad, contacto y jurisdicción, revisar las integraciones habilitadas y adaptar esos documentos a la legislación y configuración reales.
