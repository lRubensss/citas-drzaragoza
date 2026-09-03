# 🦷 Sistema Automatizado de Citas por WhatsApp - Clínica Dental Dr. Zaragozá

Solución para recordatorios automáticos de citas (24 horas antes) y gestión bidireccional de confirmaciones, cancelaciones y derivación humana vía WhatsApp, integrado con **Google Calendar** / CRM médico.

---

## 🚀 Características y Lecciones Aprendidas Incorporadas

1. **Prevención de Bucles Infinitos:** 
   - Máquina de estados estricta (`PENDING` ➔ `REMINDER_SENT` ➔ `CONFIRMED` / `CANCELLED` / `MANUAL_REVIEW`).
   - El sistema no re-notifica ni vuelve a disparar mutaciones ante mensajes repetidos en estados terminales.
2. **Zona Horaria Estricta (`Europe/Madrid`):**
   - Procesamiento horario explícito con `luxon`, previniendo desfasajes por UTC o cambios estacionales de horario (CET / CEST).
3. **Normalización NLP Tolerante a Fallos:**
   - Limpieza de cadenas: minúsculas, eliminación de diacríticos y tildes (`"sí"` ➔ `"si"`, `"anulación"` ➔ `"anulacion"`), equivalencias directas para dígitos (`1`, `1️⃣`, `2`, `2️⃣`, `"confirmo"`, `"no puedo ir"`, etc.).
4. **Idempotencia y Anti-Race Conditions:**
   - Deduplicación por `MessageSid` / `wamid` de WhatsApp.
   - Bloqueo atómico por teléfono mientras se procesa una petición entrante.
5. **Fallback Humano Obligatorio:**
   - Si el mensaje no se ajusta a confirmación ni cancelación, el evento pasa a `MANUAL_REVIEW` y se genera una alerta inmediata a recepción para atención telefónica/manual.

---

## 📁 Estructura del Proyecto

```text
├── .env.example                # Plantilla de configuración documentada
├── package.json                # Dependencias y scripts
├── tsconfig.json               # Configuración TypeScript
├── src/
│   ├── config/                 # Validación de variables con Zod y constantes
│   ├── controllers/
│   │   └── webhook.controller.ts # Inbound Webhook de WhatsApp (Twilio / Meta / API)
│   ├── jobs/
│   │   └── reminder.cron.ts    # Escaneo de citas 24h y despacho de mensajes
│   ├── services/
│   │   ├── alert.service.ts    # Alertas urgentes a recepción (Webhook / Slack / Email)
│   │   ├── calendar.service.ts # Conexión a Google Calendar API y Mock Store
│   │   ├── nlp.service.ts      # Parser semántico con normalización de tildes y números
│   │   ├── state.service.ts    # Manejo de estados, idempotencia y anti-bloqueos
│   │   └── whatsapp.service.ts # Proveedor WhatsApp (Twilio, Meta Cloud API, Mock)
│   ├── types/
│   │   └── appointment.ts      # Interfaces TypeScript
│   ├── utils/
│   │   └── logger.ts           # Logging estructurado con Pino
│   └── server.ts               # Servidor Express y programación de tareas
└── tests/
    └── test-flow.ts            # Suite completa de pruebas end-to-end automatizadas
```

---

## 🛠️ Instalación y Puesta en Marcha

### 1. Clonar e instalar dependencias
```bash
npm install
```

### 2. Configurar variables de entorno
Copia `.env.example` a `.env` y completa los valores:
```bash
cp .env.example .env
```

### 3. Ejecutar las Pruebas Automatizadas
Ejecuta la suite que valida el parser NLP, la zona horaria `Europe/Madrid`, el cron de 24h, la idempotencia y el fallback humano:
```bash
npm test
```

### 4. Modo Desarrollo
```bash
npm run dev
```

### 5. Compilación y Producción
```bash
npm run build
npm start
```

---

## 📅 Estructura de Citas en Google Calendar

Para que el bot reconozca automáticamente las citas de la agenda de la clínica, los eventos en Google Calendar deben incluir los siguientes datos (en el título o en la descripción):

- **Título del Evento:** `Cita: [Nombre del Paciente] - Dr. Zaragozá`
- **Descripción del Evento:**
```text
Paciente: Juan Pérez
Teléfono: +34612345678
Especialista: Dr. Zaragozá
Estado: PENDING
```

### Actualizaciones automáticas realizadas por el Bot:
* **Al enviar recordatorio:** Cambia estado a `REMINDER_SENT` y color amarillo.
* **Al confirmar:** Agrega prefijo `[CONFIRMADO]`, cambia color a verde (`Basil`) y añade timestamp.
* **Al cancelar:** Agrega prefijo `[CANCELADO]`, cambia color a rojo (`Flamingo`), libera el hueco y notifica a recepción.
* **Respuesta no entendida:** Agrega prefijo `[REVISIÓN MANUAL]` y envía alerta a recepción.

---

## 🌐 Endpoints Disponibles

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/health` | Estado del servicio, timezone activa y proveedor |
| `POST` | `/webhook/whatsapp` | Webhook de entrada de WhatsApp (Twilio / Meta / Mock) |
| `GET` | `/webhook/whatsapp` | Verificación de Webhook para Meta Cloud API |
| `POST` | `/api/cron/trigger-reminders` | Disparo manual del cron de recordatorios 24h |
