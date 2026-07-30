# Vocal Nexus v2 — Documentación Completa

**Fecha**: 2026-07-29
**Sistema**: LOC06 — CachyOS Linux (192.168.1.85)
**Puerto**: 3777 (TCP)
**GitHub**: https://github.com/superdandi/vocal-nexus

---

## 1. Arquitectura General

```
┌─────────────────────────────────────────────────────────┐
│                    VOCAL NEXUS SERVER                    │
│                    (Node.js :3777)                       │
│                                                         │
│  ┌──────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │ REST API │  │   WebSocket  │  │   Registry       │  │
│  │ Express  │  │     (ws)     │  │ data/registry.json│  │
│  └────┬─────┘  └──────┬───────┘  └─────────┬────────┘  │
│       │               │                    │           │
│  ┌────▼───────────────▼────────────────────▼─────────┐  │
│  │            Core Engine                             │  │
│  │  - Client Registry (persistente)                   │  │
│  │  - Event Bus (pub/sub)                             │  │
│  │  - Voice Target Manager                            │  │
│  │  - TTS Engine (espeak → Kokoro)                    │  │
│  └──────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
         ▲                       ▲
         │ HTTP/WS               │ HTTP
┌────────┴────────┐    ┌─────────┴──────────┐
│   Browser SPA   │    │  opencode MCP       │
│  (TTS + Voice)  │    │  (vocal-nexus.js)   │
│  (Chat + Mic)   │    │  + Plugin            │
└─────────────────┘    └────────────────────┘
         ▲
         │
┌────────┴────────┐
│  Other devices  │
│  (LOC03, LOC05, │
│   phones, etc)  │
└─────────────────┘
```

### Componentes

| Componente | Archivo | Función |
|---|---|---|
| **Servidor** | `server.js` | HTTP + WebSocket, persistencia, TTS |
| **Frontend** | `index.html` | SPA con chat, voz, registro |
| **MCP Bridge** | `~/.config/opencode/mcp/vocal-nexus.js` | Traduce MCP → HTTP |
| **Plugin** | `~/.config/opencode/plugins/vocal-nexus.ts` | Hooks de ciclo de vida |
| **Registry** | `data/registry.json` | Registro persistente de terminales |

---

## 2. Persistencia de Terminales (v2)

### Registro Persistente (`data/registry.json`)

```json
{
  "terminals": {
    "loc03": {
      "name": "loc03",
      "firstSeen": 1234567890,
      "lastSeen": 1234567890,
      "voiceEnabled": true,
      "status": "online",
      "metadata": { "ip": "192.168.1.94", "transport": "ws" }
    }
  }
}
```

### Ciclo de vida de un terminal

1. **Registro** — Al primer contacto, se guarda en `registry.json` (nunca se borra automáticamente)
2. **Conexión** — Se marca `status: "online"`, se actualiza `lastSeen`
3. **Desconexión** — Se marca `status: "offline"` (no se borra, no se pierde configuración)
4. **Reconexión** — Se restaura desde el registro con toda su configuración
5. **Eliminación** — Solo vía API explícita (`DELETE /api/terminal/:name`)

### Cleanup

- Cada 60 segundos, se revisan terminales con más de 5 minutos sin actividad
- Si no están conectados por WS ni poll, se marcan `offline`
- **Nunca se borran** del registro

---

## 3. Transporte: Dual (WebSocket + Long-Polling)

### WebSocket (principal)

- Conexión al host del servidor con el mismo puerto
- Registro: enviar `{ type: "register", name: "nombre" }`
- Eventos recibidos: `{ type: "event", event: {...} }`
- Chat: enviar `{ type: "chat", to: "destino", text: "mensaje" }`
- Ping/pong para mantener conexión

### Long-Polling (fallback)

- `GET /api/poll?name=nombre&since=timestamp`
- Responde inmediatamente si hay eventos pendientes
- Espera hasta 30 segundos si no hay nada
- Usado por browsers sin soporte WS

---

## 4. API Endpoints

### Endpoints existentes (backward-compatible)

| Endpoint | Método | Descripción |
|---|---|---|
| `/api/health` | GET | Estado del servidor: online count, voice targets |
| `/api/clients` | GET | Lista de clientes con estado y voz |
| `/api/poll` | GET | Long-polling para eventos |
| `/api/voice-target` | POST | Activar/desactivar voz para un terminal |
| `/api/notify` | POST | Enviar notificación (text + speak) |
| `/api/tts` | POST/GET | Generar audio TTS (GET con query `?text=`) |

### Nuevos endpoints (v2)

| Endpoint | Método | Descripción |
|---|---|---|
| `/api/registry` | GET | Todos los terminales conocidos (online/offline) |
| `/api/terminal/:name` | GET | Info detallada de un terminal |
| `/api/terminal/:name` | DELETE | Eliminar terminal del registro |
| `/api/message` | POST | Enviar mensaje de chat a un terminal |
| `/api/messages/:name` | GET | Últimos 50 mensajes de un terminal |
| `/api/cache` | GET | Estadísticas de caché (archivos, tamaño, corruptos, errores) |
| `/api/cache?text=...` | DELETE | Eliminar entrada de caché para un texto específico |
| `/api/cache` | DELETE | Vaciar toda la caché |

### Ejemplos

```bash
# Verificar salud
curl http://192.168.1.85:3777/api/health

# Ver todos los terminales conocidos
curl http://192.168.1.85:3777/api/registry

# Info de un terminal
curl http://192.168.1.85:3777/api/terminal/loc03

# Enviar mensaje
curl -X POST http://192.168.1.85:3777/api/message \
  -H "Content-Type: application/json" \
  -d '{"from":"opencode","to":"loc03","text":"Hola desde opencode"}'

# Activar voz para un terminal
curl -X POST http://192.168.1.85:3777/api/voice-target \
  -H "Content-Type: application/json" \
  -d '{"name":"loc03","enabled":true}'

# Eliminar terminal
curl -X DELETE http://192.168.1.85:3777/api/terminal/loc03

# Ver estadísticas de caché
curl http://192.168.1.85:3777/api/cache

# Eliminar entrada de caché por texto
curl -X DELETE "http://192.168.1.85:3777/api/cache?text=Hola%20mundo"

# Vaciar toda la caché
curl -X DELETE http://192.168.1.85:3777/api/cache
```

---

## 5. TTS (Text-to-Speech) — Flujo Completo

### Arquitectura en capas

```
Evento "speak" del servidor
         │
         ▼
┌─────────────────────────────┐
│  speakText(text)            │
│  → beep de alerta           │
│  → encola en ttsQueue       │
│  → processTTSQueue()        │
└──────────┬──────────────────┘
           │
           ▼
┌─────────────────────────────┐
│  trySpeechFirst(text)       │  ← LADO CLIENTE (browser)
│                             │
│  ¿window.speechSynthesis    │
│  disponible y con voces?    │
│         │                   │
│    ┌────┴────┐              │
│    │ NO      │ SÍ           │
│    ▼         ▼              │
│  server  SpeechSynthesis    │
│  TTS    .speak(utterance)   │
│           con lang="es-MX"  │
│           timeout 5s        │
│           ┌────┴────┐       │
│           │ éxito   │ falla │
│           │         ▼       │
│           │     server TTS  │
│           └─────────────────┘
└─────────────────────────────┘
           │ (fetch /api/tts?text=...)
           ▼
┌─────────────────────────────┐
│  GET /api/tts?text=...       │  ← LADO SERVIDOR
│                             │
│  ┌─ ¿Cache hit? ───────┐   │
│  │   MD5(text).wav      │   │
│  │   existe en cache/   │───┤──→ Responde WAV cacheado
│  └──────────────────────┘   │
│           │ NO              │
│           ▼                 │
│  ┌─ Kokoro (Python) ───┐   │
│  │  venv/bin/python     │   │
│  │  tts_kokoro.py       │   │
│  │  timeout: 120s       │   │
│  │  modelo: ef_dora     │   │
│  │  calidad: NATURAL    │   │
│  │  peso: ~75KB/WAV     │   │
│  │  ┌────┴────┐         │   │
│  │  │ éxito   │ falla    │   │
│  │  │ cachea  │          │   │
│  │  │ responde│  ▼       │   │
│  │  └─────────┘ espeak   │   │
│  └──────────────────────┘   │
│           │                 │
│  ┌─ espeak-ng ─────────┐   │
│  │  espeak-ng -v es-mx  │   │
│  │  timeout: 5s         │   │
│  │  calidad: ROBÓTICA   │   │
│  │  peso: ~5-15KB/WAV   │   │
│  │  ┌────┴────┐         │   │
│  │  │ éxito   │ falla    │   │
│  │  │ cachea  │  → 500   │   │
│  │  │ responde│   ERROR  │   │
│  │  └─────────┘          │   │
│  └──────────────────────┘   │
└─────────────────────────────┘
```

### Orden de prioridad (refactorizado v2)

**Antes (v1):** espeak-ng primero → Kokoro fallback (voz robótica siempre)
**Ahora (v2):** Kokoro primero → espeak-ng fallback (voz natural siempre que Kokoro esté disponible)

| Capa | Prioridad | Dónde corre | Calidad | Latencia | Tamaño WAV |
|---|---|---|---|---|---|
| Browser speechSynthesis | 1ª (cliente) | Browser del terminal | Natural (depende del SO) | 0ms | N/A (streaming) |
| Kokoro TTS | 2ª (servidor) | `venv/bin/python tts_kokoro.py` | **Natural** (modelo ML) | ~1-2s (cargado) / ~60s (1ª vez) | ~75KB |
| espeak-ng | 3ª (servidor) | `espeak-ng -v es-mx` | Robótica | ~0.1s | ~5-15KB |
| Cache | 0ª (servidor) | `cache/<md5>.wav` | = Kokoro o espeak | ~0ms | = generado |

### ¿Cuándo se usa cada una?

| Escenario | ¿Qué se usa? | ¿Por qué? |
|---|---|---|
| **Windows 10/11** (loc03, loc05) | Browser speechSynthesis | Windows tiene voces nativas españolas (`Microsoft Sabina`, etc.) |
| **Linux sin voces** (LOC06) | Kokoro → espeak-ng | Linux normalmente no tiene voces nativas; cae al servidor |
| **Smart TV / Android** (hall) | Kokoro (o speechSynthesis si el browser lo soporta) | Depende del navegador |
| **Texto repetido** (cualquier OS) | Cache (Kokoro o espeak del hit anterior) | MD5 match evita regenerar |
| **Kokoro falla** (modelo no descargado, OOM) | espeak-ng | Fallback de último recurso |
| **Kokoro + espeak fallan** | Error 500 | No hay TTS disponible |

### Cache

- Clave: `MD5(texto).wav`
- Directorio: `cache/`
- Se cachea tanto Kokoro como espeak-ng
- Los archivos grandes (~52-95KB) son Kokoro; los pequeños (~5-15KB) son espeak-ng

### Auto-gestión de caché

La caché se gestiona automáticamente para evitar crecimiento infinito:

| Mecanismo | Detalle |
|---|---|
| **Límite de archivos** | Máximo 500 archivos `.wav` |
| **Límite de tamaño** | Máximo 200 MB totales |
| **Política de evicción** | LRU (Least Recently Used): cuando se excede algún límite, se elimina el **10% más antiguo** por `mtime` |
| **Validación de WAV** | Todo archivo en `cache/` se valida con cabecera `RIFF` + `WAVE` al leerlo o escanearlo. Archivos corruptos se eliminan automáticamente |
| **Mantenimiento programado** | Cada **10 minutos** via `cacheMaintenance()`: limpia corruptos, aplica LRU y limpia colas de eventos viejos |
| **Cache hit** | Se revisa antes de generar TTS — si existe `cache/<md5>.wav` válido, se responde inmediatamente sin ejecutar Kokoro ni espeak-ng |
| **Cache miss** | Se genera TTS (Kokoro → espeak fallback) y se guarda en `cache/` antes de responder |
| **Errores** | Todos los errores de caché se registran en `cacheErrors[]` (máximo 50 entradas) y se exponen via `GET /api/cache` |
| **Evicción en escritura** | `cacheTTS()` ejecuta `enforceCacheLimits()` **antes** de escribir, asegurando que nunca se excedan los límites |
| **Limpieza manual** | `DELETE /api/cache` sin query vacía toda la caché; `DELETE /api/cache?text=...` elimina una entrada específica |

**Flujo completo:**
```
GET /api/tts?text=...
  → ¿cache/<md5>.wav existe y es válido?
    → Sí: responde WAV (0ms)
    → No:
      → Kokoro genera → ¿éxito?
        → Sí: cachea WAV, responde
        → No: espeak-ng genera
          → Sí: cachea WAV, responde
          → No: error 500
```

### Mecanismo anti-doble reproducción

El cliente usa `trySpeechFirst()` que sigue este orden para evitar duplicados:

1. **Browser speechSynthesis** — si hay voces disponibles, se intenta primero
   - `onend` limpia el timeout de fallback
   - `onerror` dispara el fallback al servidor
2. **Timeout de seguridad (30s)** — si speechSynthesis se cuelga sin disparar `onend` ni `onerror`, se cae al servidor
   - Mientras `speechSynthesis.speaking` sea true, el timeout se re-programa cada 3s
3. **Server TTS** — solo se usa si el browser no tiene voces o falla definitivamente

Esto evita que el mismo mensaje se reproduzca dos veces (browser + servidor), que era el bug original con el timeout fijo de 5s.

### Feedback inmediato (Opción A — implementada)

Cuando el servidor envía un evento `speak`, el cliente reproduce un **beep local** (880Hz, 0.3s) instantáneo antes de iniciar el TTS. Esto asegura que el usuario siempre reciba feedback auditivo inmediato, incluso si el TTS del servidor no está en caché (Kokoro tarda 1-60s, espeak ~0.1s).

```
Evento "speak"
  → playBeep() ← 0ms, local, sin red
  → ¿Cache hit?
    → Sí: servidor responde WAV en ~0ms → audio real
    → No: servidor genera (Kokoro→espeak) → audio real al terminar
```

El beep usa Web Audio API con fallback a base64 WAV. Si el AudioContext está suspendido (autoplay policy), se reanuda automáticamente.

**Upgrade futuro (Opción B):** Reemplazar el beep genérico por un "procesando.wav" pregrabado servido desde el servidor en los casos de cache miss, y que el servidor envíe el WAV real asíncronamente cuando termine de generar. Así el feedback es más informativo ("procesando" en lugar de un beep) y solo se escucha cuando realmente hay demora.

---

## 6. Seguridad

### Modelo actual (v2)

opencode solo tiene acceso **outbound** a la red:

- ✅ **Envía** notificaciones a terminales
- ✅ **Envía** mensajes de texto a terminales
- ✅ **Consulta** estado de terminales (read-only)
- ❌ **No recibe** mensajes entrantes de la red

Esto es intencional: opencode tiene capacidad de ejecutar código. Permitir que cualquier terminal envíe mensajes a la sesión de opencode sería un vector de ataque.

### Upgrade futuro: Inbound a opencode

Se documenta como posibilidad futura con estas restricciones:

1. **Whitelist de terminales** — Solo terminales autorizados pueden enviar a opencode
2. **Firma HMAC** — Los mensajes deben tener firma verificable
3. **Rate limiting** — Máximo N mensajes por minuto
4. **Sandbox** — Los mensajes se procesan en contexto aislado
5. **Audit log** — Registro de todos los mensajes recibidos

Para implementar, agregaría un nuevo tool MCP `receive_message` con validación estricta.

---

## 7. MCP Tools (opencode)

| Tool | Descripción | Tipo |
|---|---|---|
| `notify` | Enviar notificación de texto + voz | Outbound |
| `broadcast` | Notificación urgente a TODOS los terminales | Outbound |
| `voice_target` | Activar/desactivar voz para un terminal | Outbound |
| `clients` | Listar clientes conectados | Query |
| `server_status` | Verificar salud del servidor | Query |
| `list_terminals` | Listar todos los terminales conocidos | Query |
| `terminal_info` | Info detallada de un terminal | Query |
| `send_message` | Enviar mensaje de chat a un terminal | Outbound |

---

## 8. Chat entre terminales

El chat permite que los terminales se envíen mensajes de texto entre sí en tiempo real.

### Interfaz

- **Dropdown** — seleccionar el terminal destino o `* broadcast a todos`
- **Input** — escribir el mensaje
- **Enter / Botón ENVIAR** — enviar

### Alcance del broadcast

Cuando se selecciona `* broadcast a todos` en el dropdown:

1. El mensaje se envía a **todos los terminales excepto el emisor**
2. El emisor ve su mensaje en el chat local como `self` (color magenta)
3. Los demás terminales lo reciben y muestran como `from: <nombre-emisor>` (color cyan)
4. La exclusión del emisor evita duplicados

### Mecanismo

| Transporte | Broadcast | Unicast |
|---|---|---|
| **WebSocket** | `ws.send({ type: "chat", to: "*", text })` → `broadcastAllExcept()` | `ws.send({ type: "chat", to: "loc03", text })` → `queueEvent + sendViaWS` |
| **HTTP fallback** | `POST /api/notify` con `broadcast: true` | `POST /api/message` con `{ from, to, text }` |

### Código del servidor

```js
function broadcastAllExcept(event, excludeName) {
  terminals.forEach((t, name) => {
    if (name === excludeName) return;  // salta al emisor
    queueEvent(name, event);
    wakePoller(name);
    sendViaWS(name, event);
  });
}
```

---

## 9. Plugin (opencode)

El plugin (`~/.config/opencode/plugins/vocal-nexus.ts`) se activa en eventos del ciclo de vida:

| Evento | Acción | Tool usado |
|---|---|---|
| `session.created` | Notificar "Sesión iniciada" | `notify` |
| `session.idle` | Notificar "Hecho" | `notify` |
| `session.error` | Notificar "Error" | `notify` |
| `permission.asked` | Notificar "Permisos build" o "Necesito input" | `notify` |
| `command.executed` (push) | Notificar "Push listo" | `notify` |
| `session.compacted` | Notificar "Procedimiento listo" | `notify` |

---

## 10. Red y Puertos

| Puerto | Servicio | Binding | Acceso |
|---|---|---|---|
| 22/TCP | SSH | 192.168.1.85:22 | Solo LAN, solo claves |
| 3777/TCP | Vocal Nexus | 0.0.0.0:3777 | LAN (via UFW) |

### Terminales conocidos

| Host | IP | OS | Estado |
|---|---|---|---|
| LOC06 (server) | 192.168.1.85 | CachyOS | Server |
| LOC03 | 192.168.1.82 | Win10 | Cliente |
| LOC05 | 192.168.1.83 | Win7 | Cliente |
| LOC07 | 192.168.1.86 | — | Cliente |
| vizcoso | 192.168.1.81 | — | Cliente |
| hall | DHCP | Smart TV | Cliente (puede requerir reconexión si cambió IP) |

---

## 11. Despliegue

### Iniciar servicio

```bash
# Habilitar y arrancar
sudo systemctl enable --now vocal-nexus.service

# Verificar
sudo systemctl status vocal-nexus.service
curl http://192.168.1.85:3777/api/health

# Logs
sudo journalctl -u vocal-nexus.service -f
```

### Configurar opencode

En `~/.config/opencode/opencode.jsonc`:

```json
{
  "mcp": {
    "vocal-nexus": {
      "type": "local",
      "command": ["node", "/home/dandi/.config/opencode/mcp/vocal-nexus.js"],
      "enabled": true
    }
  }
}
```

### Instrucciones para el AI

Ver `~/.config/opencode/instructions/notify.md` para las reglas de notificación.

---

---

## 12. Revisión Exhaustiva del Sistema

Estado de referencia verificado el 2026-07-29 con 5 terminales activos.

### Comprobación rápida

```bash
# 1. Salud del servidor
curl -s http://192.168.1.85:3777/api/health

# 2. Registro completo de terminales
curl -s http://192.168.1.85:3777/api/registry | python3 -m json.tool

# 3. Info de un terminal específico
curl -s http://192.168.1.85:3777/api/terminal/loc03

# 4. Test de TTS (voz natural Kokoro)
curl -s -o /dev/null -w "Status: %{http_code}, Size: %{size_download} bytes\n" \
  'http://192.168.1.85:3777/api/tts?text=prueba'

# 5. Enviar mensaje de prueba
curl -s -X POST http://192.168.1.85:3777/api/message \
  -H "Content-Type: application/json" \
  -d '{"from":"opencode","to":"loc03","text":"test"}'

# 6. Ver servicio systemd
sudo systemctl status vocal-nexus.service

# 7. Logs del servidor
sudo journalctl -u vocal-nexus.service -n 20 --no-pager
```

### Checklist de componentes

| # | Componente | Cómo verificarlo | Esperado |
|---|---|---|---|
| 1 | **Servidor Node.js** | `systemctl status` | `active (running)` |
| 2 | **systemd habilitado** | `systemctl is-enabled` | `enabled` |
| 3 | **Puerto 3777** | `ss -tlnp \| grep 3777` | `LISTEN 0.0.0.0:3777` |
| 4 | **API /health** | `curl /api/health` | `{"status":"ok",...}` |
| 5 | **API /registry** | `curl /api/registry` | Lista de terminales con estados |
| 6 | **API /terminal/:name** | `curl /api/terminal/loc03` | Info detallada del terminal |
| 7 | **API /clients** | `curl /api/clients` | Lista de clientes online |
| 8 | **API /messages/:name** | `curl /api/messages/loc03` | Array de mensajes (puede estar vacío) |
| 9 | **API /message (POST)** | `POST /api/message` | `{"status":"sent"}` |
| 10 | **API /voice-target** | `POST /api/voice-target` | `{"voiceEnabled":true\|false}` |
| 11 | **TTS con Kokoro** | `curl /api/tts?text=...` | HTTP 200 + WAV >60KB |
| 12 | **TTS con espeak-ng** | Kokoro falla | HTTP 200 + WAV <20KB |
| 13 | **Cache TTS** | `curl /api/cache` | `{"files":N,"sizeMB":M,"status":"ok"}` |
| 14 | **LRU evicción** | Llenar caché >500 archivos | Los más viejos se eliminan automáticamente |
| 15 | **Mantenimiento** | Esperar 10 min o reiniciar | `journalctl` muestra `[CACHE] Evicción LRU` |
| 16 | **DELETE /api/cache** | `curl -X DELETE /api/cache` | `{"removed":"N archivos eliminados"}` |
| 17 | **DELETE /api/cache?text=** | `curl -X DELETE "/api/cache?text=hola"` | `{"removed":"hola"}` |
| 18 | **Persistencia** | `cat data/registry.json` | Terminales guardados entre reinicios |
| 19 | **Frontend SPA** | `curl /index.html` | HTTP 200, HTML con JS |
| 20 | **JavaScript cliente** | `node -e "new Function(js)"` | Sin errores de sintaxis |
| 21 | **Service Worker** | `curl /sw.js` | HTTP 200 |
| 22 | **MCP Bridge** | Contar tools en `vocal-nexus.js` | 8 tools |
| 23 | **Plugin opencode** | Verificar `vocal-nexus.ts` | Hooks de ciclo de vida |
| 24 | **Instrucciones AI** | Verificar `notify.md` | Actualizadas con tools nuevas |
| 25 | **Conexión WebSocket** | Logs del servidor | `[WS] <nombre> registrado` |
| 26 | **Logs sin errores** | `journalctl -u vocal-nexus` | Sin `error`, `fail` o `exception` |

### Ejemplo de estado saludable

```
=== HEALTH ===
{"status":"ok","online":5,"total":6,"voiceTargets":["loc03","vizcoso","hall","loc05","loc07"]}

=== REGISTRY ===
  loc03   | online | voz: ON  | ws | 192.168.1.82
  vizcoso | online | voz: ON  | ws | 192.168.1.81
  hall    | offline| voz: ON  | ws | (requiere reconexión)
  loc05   | online | voz: ON  | ws | 192.168.1.83
  loc07   | online | voz: ON  | ws | 192.168.1.86
  loc06   | online | voz: OFF | ws | 192.168.1.85

=== SYSTEMD ===
  Active: active (running) since ...
  Main PID: 208513 (node-MainThread)

=== TTS ===
  Status: 200, Size: 38555 bytes  ← Kokoro (voz natural)

=== ENDPOINTS ===
  /api/health: 200
  /api/clients: 200
  /api/registry: 200
  /api/terminal/loc03: 200
  /api/messages/loc03: 200
  /api/cache: 200

=== CACHE ===
  42 archivos cacheados (2.4 MB, 0 corruptos)

=== CACHE API ===
  GET  /api/cache: 200  {"files":42,"sizeMB":2.4,"status":"ok","errors":[]}
  DELETE /api/cache?text=hola: 200  {"removed":"hola"}
```

### Posibles problemas

| Síntoma | Causa probable | Solución |
|---|---|---|
| Terminal "CONECTANDO..." para siempre | Doble WS/polling | Hard refresh (Ctrl+F5) |
| Voz se escucha 2 veces (robot + natural) | Timeout de 5s en trySpeechFirst disparaba fallback mientras el browser aún hablaba | Hard refresh — el fix ya usa 30s con limpieza de timeout y re-intento mientras speechSynthesis.speaking |
| Solo beep, sin voz | Browser sin speechSynthesis o bloqueo autoplay | Click en la página, o verificar cache TTS del servidor |
| Voz robótica | espeak-ng usado (Kokoro no disponible) | Verificar `venv/bin/python tts_kokoro.py" funciona |
| Kokoro tarda ~60s primera vez | Descarga del modelo desde HuggingFace | Normal — luego se cachea |
| Terminal no aparece en registry | Nunca se conectó o se eliminó | Abrir `http://192.168.1.85:3777` y asignar nombre |
| Badge con led verde pero "apagado" | Voz desactivada | `POST /api/voice-target {"name":"...","enabled":true}` |
