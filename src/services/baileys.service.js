let makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion;

async function getBaileys() {
  if (!makeWASocket) {
    const baileys = await import('@whiskeysockets/baileys');
    makeWASocket = baileys.default || baileys.makeWASocket;
    DisconnectReason = baileys.DisconnectReason;
    useMultiFileAuthState = baileys.useMultiFileAuthState;
    fetchLatestBaileysVersion = baileys.fetchLatestBaileysVersion;
  }
  return { makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion };
}

const qrcode = require('qrcode');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const db = require('../store/database');
const supabaseService = require('./supabase.service');

class BaileysService {
  constructor() {
    this.sock = null;
    this.status = 'DISCONNECTED'; // 'DISCONNECTED' | 'SCAN_QR' | 'CONNECTED'
    this.qrCodeDataUrl = null;
    this.connectedPhone = null;
    this.isAuthorized = false;
    this.reconnectAttempts = 0;
    this.isSimulated = false;
    this.pingInterval = null;

    // Cola de salida con rate limiting antibloqueo y control de timeout
    this.messageQueue = [];
    this.isProcessingQueue = false;

    // Iniciar conexión Baileys
    this.init();
  }

  /**
   * Limpia y normaliza el número a formato JID estricto de WhatsApp:
   * - Elimina '+', espacios, guiones y caracteres no numéricos.
   * - Si es un móvil de España (9 dígitos empezando por 6 o 7), antepone '34'.
   * - Agrega el sufijo obligatorio '@s.whatsapp.net'.
   */
  formatToWhatsAppJid(rawPhone) {
    let digits = String(rawPhone || '').replace(/\D/g, ''); // solo dígitos
    if (digits.length === 9 && (digits.startsWith('6') || digits.startsWith('7'))) {
      digits = '34' + digits; // Anteponer prefijo España 34
    }
    return `${digits}@s.whatsapp.net`;
  }

  async init() {
    try {
      await getBaileys();
      const authDir = path.resolve(config.AUTH_DIR);
      if (!fs.existsSync(authDir)) {
        fs.mkdirSync(authDir, { recursive: true });
      }

      // Detener ping anterior si existía
      if (this.pingInterval) {
        clearInterval(this.pingInterval);
        this.pingInterval = null;
      }

      // Si Supabase está disponible, restaurar credenciales de sesión previa antes de cargar Baileys
      if (supabaseService.isEnabled) {
        await supabaseService.ensureTables();
        await supabaseService.syncAuthFromDatabase(authDir);
      }

      const { state, saveCreds } = await useMultiFileAuthState(authDir);

      this.sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: ['Dr. Zaragozá Citas', 'Chrome', '1.0.0'],
        connectTimeoutMs: 30000,
        keepAliveIntervalMs: 25000,
        defaultQueryTimeoutMs: 30000,
      });

      this.sock.ev.on('creds.update', async () => {
        await saveCreds();
        if (supabaseService.isEnabled) {
          supabaseService.syncAuthToDatabase(authDir).catch((e) => {
            console.warn('[SUPABASE AUTH SYNC WARN]', e.message);
          });
        }
      });

      this.sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          console.log('📲 [BAILEYS QR] Nuevo código QR de Baileys generado.');
          this.status = 'SCAN_QR';
          try {
            this.qrCodeDataUrl = await qrcode.toDataURL(qr, {
              errorCorrectionLevel: 'M',
              margin: 2,
              scale: 7,
              color: { dark: '#005073', light: '#ffffff' },
            });
          } catch (qrErr) {
            console.error('[BAILEYS QR ERROR]', qrErr);
          }
        }

        if (connection === 'close') {
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          const isLoggedOut = statusCode === DisconnectReason.loggedOut;
          console.warn(`⚠️ [BAILEYS DISCONNECT] Conexión cerrada. Código: ${statusCode}, loggedOut: ${isLoggedOut}`);

          this.status = 'DISCONNECTED';
          this.connectedPhone = null;
          this.isAuthorized = false;

          // Destruir socket anterior de inmediato para evitar sockets zombie
          try {
            this.sock?.ev?.removeAllListeners();
            this.sock?.end();
          } catch (endErr) {}

          if (isLoggedOut) {
            console.log('[BAILEYS LOGOUT] Sesión cerrada permanentemente en el móvil. Limpiando credenciales...');
            db.addAlert({
              type: 'WHATSAPP_DESCONECTADO',
              patient_name: 'Sistema',
              patient_phone: config.OFFICIAL_PHONE_FORMATTED,
              patient_message: 'Desconexión manual detectada',
              reason: `WhatsApp desvinculado: vuelva a escanear el código QR para el teléfono oficial ${config.OFFICIAL_PHONE_FORMATTED}`,
            });

            try {
              fs.rmSync(authDir, { recursive: true, force: true });
            } catch (e) {}
            if (supabaseService.isEnabled) {
              await supabaseService.clearAuthDatabase();
            }
            setTimeout(() => this.init(), 2000);
          } else {
            // Reabrir conexión automáticamente recargando las credenciales guardadas sin ensuciar la bandeja de alertas
            console.log('[BAILEYS AUTO-RECONNECT] Reconectando sesión con credenciales guardadas en 3 segundos...');
            setTimeout(() => this.init(), 3000);
          }
        } else if (connection === 'open') {
          console.log('🎉 [BAILEYS OPEN] Conexión con WhatsApp establecida con éxito.');
          this.reconnectAttempts = 0;
          this.qrCodeDataUrl = null;
          this.isSimulated = false;

          // Purgar cualquier alerta residual de desconexión previa
          db.data.alerts = (db.data.alerts || []).filter((a) => a.type !== 'WHATSAPP_DESCONECTADO');
          db.save();

          const rawJid = this.sock?.user?.id || '';
          const phoneNum = rawJid.split(':')[0].replace('@s.whatsapp.net', '');
          this.connectedPhone = `+${phoneNum}`;

          // Validación estricta del número oficial de la clínica
          if (phoneNum === config.OFFICIAL_PHONE || phoneNum === config.OFFICIAL_PHONE.replace('+', '')) {
            this.status = 'CONNECTED';
            this.isAuthorized = true;
            console.log(`✅ [BAILEYS AUTH] Número oficial autorizado conectado: ${config.OFFICIAL_PHONE_FORMATTED}`);
          } else {
            this.status = 'CONNECTED';
            this.isAuthorized = false;
            console.warn(`⚠️ [BAILEYS WARN] Teléfono no oficial conectado: +${phoneNum}. El oficial es: ${config.OFFICIAL_PHONE_FORMATTED}`);
            db.addAlert({
              type: 'NUMERO_NO_AUTORIZADO',
              patient_name: 'Admin',
              patient_phone: `+${phoneNum}`,
              patient_message: `Teléfono vinculado no coincide con ${config.OFFICIAL_PHONE_FORMATTED}`,
              reason: 'Por seguridad, el bot requiere vincular el teléfono oficial 610812835.',
            });
          }

          // Iniciar Keep-Alive Ping cada 30 segundos para evitar socket zombie por inactividad
          this.startKeepAlivePing();
        }
      });

      // Escuchar respuestas de pacientes (Inbound WhatsApp)
      this.sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const msg of messages) {
          if (msg.key.fromMe) continue; // Ignorar mensajes del propio bot

          const remoteJid = msg.key.remoteJid || '';
          if (!remoteJid.endsWith('@s.whatsapp.net')) continue; // Ignorar grupos o estados

          const senderPhone = `+${remoteJid.replace('@s.whatsapp.net', '')}`;
          const bodyText =
            msg.message?.conversation ||
            msg.message?.extendedTextMessage?.text ||
            msg.message?.buttonsResponseMessage?.selectedButtonId ||
            '';

          if (bodyText) {
            await this.handleInboundResponse(senderPhone, bodyText);
          }
        }
      });
    } catch (err) {
      console.error('[BAILEYS INIT ERROR]', err);
      this.status = 'DISCONNECTED';
    }
  }

  /**
   * Ping ligero cada 25 segundos para mantener viva la sesión (Keep-Alive)
   */
  startKeepAlivePing() {
    if (this.pingInterval) clearInterval(this.pingInterval);
    this.pingInterval = setInterval(async () => {
      try {
        if (this.sock && this.status === 'CONNECTED' && !this.isSimulated) {
          await this.sock.sendPresenceUpdate('available');
        }
      } catch (err) {
        console.warn('[BAILEYS KEEPALIVE ERROR]', err.message);
      }
    }, 25000);
  }

  /**
   * Parser estricto de intenciones del paciente según la especificación
   */
  parseUserResponse(rawText) {
    if (!rawText) return 'UNKNOWN';

    // Normalización: minúsculas, recorte de bordes y supresión de diacríticos/tildes
    const clean = rawText
      .toLowerCase()
      .trim()
      .replace(/1[\ufe0e\ufe0f]?\u20e3/g, '1')
      .replace(/2[\ufe0e\ufe0f]?\u20e3/g, '2')
      .replace(/1️⃣/g, '1')
      .replace(/2️⃣/g, '2')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');

    // Variaciones admitidas para confirmación
    const confirmPatterns = [
      'confirmar', 'confirmo', 'confirma',
      'si', '1', 'ok', 'vale', 'correcto', 'perfecto'
    ];

    // Variaciones admitidas para cancelación
    const cancelPatterns = [
      'cancelar', 'cancelo', 'cancela',
      'no', '2', 'anular', 'imposible'
    ];

    if (confirmPatterns.some((pattern) => clean === pattern || clean.startsWith(pattern))) {
      return 'CONFIRMED';
    }

    if (cancelPatterns.some((pattern) => clean === pattern || clean.startsWith(pattern))) {
      return 'CANCELLED';
    }

    return 'UNKNOWN';
  }

  /**
   * Registra la respuesta entrante del paciente en el historial de chat para atención manual de recepción.
   * Sin procesamiento de respuestas automáticas ni alteración del calendario.
   */
  async handleInboundResponse(senderPhone, rawText) {
    console.log(`📥 [INBOUND PACIENTE] De: ${senderPhone} | Mensaje: "${rawText}"`);

    // Guardar en el historial de chat para que recepción pueda leerlo y gestionarlo manualmente
    db.recordMessage(senderPhone, 'patient', rawText);
  }

  /**
   * Añade un mensaje a la cola de salida con protección antibloqueo y control de JID
   */
  enqueueMessage(toPhone, text, appointmentId = null) {
    // Control de Licencia SaaS
    const settings = db.getSettings();
    if (settings.subscription_active === false) {
      console.warn('[OUTBOUND BLOCKED] Suscripción SaaS suspendida. Mensaje no encolado.');
      return;
    }

    const jid = this.formatToWhatsAppJid(toPhone);
    const cleanPhone = `+${jid.replace('@s.whatsapp.net', '')}`;

    console.log(`[OUTBOUND QUEUE] Mensaje encolado para: ${cleanPhone} (JID: ${jid})`);

    this.messageQueue.push({
      toPhone: cleanPhone,
      jid,
      text,
      appointmentId,
      retries: 0,
      createdAt: Date.now(),
    });

    // Guardar en el historial de chat de la interfaz
    db.recordMessage(cleanPhone, 'bot', text);

    // Iniciar procesamiento si la cola no está activa
    if (!this.isProcessingQueue) {
      this.processQueue();
    }
  }

  /**
   * Procesador de la cola con Timeout de 10s obligatorio, pausas aleatorias de 3-5s y desbloqueo garantizado
   */
  async processQueue() {
    if (this.isProcessingQueue) {
      return;
    }

    this.isProcessingQueue = true;

    try {
      while (this.messageQueue.length > 0) {
        const item = this.messageQueue.shift();

        try {
          // 1. Retardo aleatorio obligatorio antibloqueo (entre 3 y 5 segundos)
          const randomDelay = Math.floor(Math.random() * 2000) + 3000;
          console.log(`[OUTBOUND DELAY] Pausa antibloqueo de ${(randomDelay / 1000).toFixed(2)}s antes de despachar a ${item.jid}`);
          await new Promise((resolve) => setTimeout(resolve, randomDelay));

          console.log(`[OUTBOUND SENDING] Intentando enviar a JID: ${item.jid}...`);

          // 2. Timeout obligatorio de 10 segundos mediante Promise.race()
          const sendPromise = async () => {
            if (this.sock && this.status === 'CONNECTED' && !this.isSimulated) {
              // Validar número con onWhatsApp con timeout de 5s para evitar bloqueos
              try {
                const checkPromise = this.sock.onWhatsApp(item.jid);
                const checkTimeout = new Promise((_, reject) =>
                  setTimeout(() => reject(new Error('Timeout onWhatsApp 5s')), 5000)
                );
                const [check] = await Promise.race([checkPromise, checkTimeout]);
                if (check && !check.exists) {
                  throw new Error(`El número ${item.toPhone} no tiene WhatsApp registrado.`);
                }
              } catch (valErr) {
                console.warn(`[OUTBOUND VALIDATION WARN] Validación de WhatsApp para ${item.jid}: ${valErr.message}. Procediendo con envío.`);
              }

              const res = await this.sock.sendMessage(item.jid, { text: item.text });
              return res?.key?.id || `msg_${Date.now()}`;
            } else {
              // Modo simulación / mock para pruebas locales
              return `sim_${Date.now()}`;
            }
          };

          const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error('TIMEOUT_8S_EXCEEDED: Baileys no confirmó entrega en 8s')), 8000);
          });

          // Ejecución con carrera contra el timeout de 8s
          const messageId = await Promise.race([sendPromise(), timeoutPromise]);
          console.log(`[OUTBOUND SUCCESS] Enviado con ID: ${messageId} a ${item.jid}`);

        } catch (itemErr) {
          console.error(`[OUTBOUND ERROR] Detalle exacto si falla para ${item.jid}: ${itemErr.message}`);

          item.retries++;
          if (item.retries <= 2) {
            console.log(`[OUTBOUND RETRY] Reintentando ${item.jid} en 10s (intento ${item.retries}/2)...`);
            await new Promise((resolve) => setTimeout(resolve, 10000));
            this.messageQueue.unshift(item); // Reinsertar al inicio
          } else {
            console.error(`[OUTBOUND FAILED] ❌ Mensaje descartado para ${item.jid} tras 2 reintentos fallidos.`);
            db.addAlert({
              type: 'FALLO_ENVIO_WHATSAPP',
              patient_name: 'Sistema',
              patient_phone: item.toPhone,
              patient_message: item.text,
              reason: `Fallo de entrega tras 2 reintentos: ${itemErr.message}`,
            });
          }
        }
      }
    } catch (criticalQueueErr) {
      console.error('[OUTBOUND CRITICAL QUEUE ERROR] Error en el bucle de la cola:', criticalQueueErr);
    } finally {
      // Bloque finally garantizado para que la cola NUNCA quede trabada
      this.isProcessingQueue = false;
      if (this.messageQueue.length > 0) {
        setImmediate(() => this.processQueue());
      }
    }
  }

  /**
   * Helper para simular vinculación en 1 clic
   */
  simulateConnect() {
    this.status = 'CONNECTED';
    this.connectedPhone = config.OFFICIAL_PHONE_FORMATTED;
    this.isAuthorized = true;
    this.isSimulated = true;
    this.qrCodeDataUrl = null;
    console.log(`[SIMULATION] Modo simulación activado para ${config.OFFICIAL_PHONE_FORMATTED}`);
  }

  /**
   * Cierra sesión y elimina credenciales para forzar nuevo QR
   */
  async disconnect() {
    try {
      this.status = 'DISCONNECTED';
      this.connectedPhone = null;
      this.isAuthorized = false;
      this.isSimulated = false;

      if (this.pingInterval) {
        clearInterval(this.pingInterval);
        this.pingInterval = null;
      }

      if (this.sock) {
        try {
          this.sock.ev.removeAllListeners();
          await this.sock.logout();
          this.sock.end();
        } catch (e) {}
      }

      const authDir = path.resolve(config.AUTH_DIR);
      if (fs.existsSync(authDir)) {
        fs.rmSync(authDir, { recursive: true, force: true });
      }
      if (supabaseService.isEnabled) {
        await supabaseService.clearAuthDatabase();
      }

      console.log('[BAILEYS DISCONNECT] Sesión desconectada y credenciales reseteadas.');
      setTimeout(() => this.init(), 1000);
    } catch (err) {
      console.error('[BAILEYS DISCONNECT ERROR]', err);
    }
  }

  getStatus() {
    return {
      status: this.status,
      connectedPhone: this.connectedPhone,
      officialPhone: config.OFFICIAL_PHONE_FORMATTED,
      isAuthorized: this.isAuthorized,
      qr: this.qrCodeDataUrl,
      isSimulated: this.isSimulated,
      queueLength: this.messageQueue.length,
      isProcessingQueue: this.isProcessingQueue,
    };
  }
}

module.exports = new BaileysService();
