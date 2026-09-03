process.env.TZ = 'Europe/Madrid';
const express = require('express');
const cors = require('cors');
const path = require('path');
const { DateTime } = require('luxon');
const config = require('./config');
const db = require('./store/database');
const baileysService = require('./services/baileys.service');
const schedulerService = require('./services/scheduler.service');

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '../public')));

// Middleware de verificación de Licencia SaaS
const checkLicense = (req, res, next) => {
  const settings = db.getSettings();
  if (settings.subscription_active === false && !req.path.startsWith('/api/settings') && req.path !== '/health') {
    return res.status(403).json({
      error: 'LICENCIA_SUSPENDIDA',
      message: 'La suscripción SaaS para la Clínica Dental Dr. Zaragozá se encuentra inactiva o suspendida.',
    });
  }
  next();
};

// ==========================================
// 1. ENDPOINT KEEP-ALIVE (ZERO-COST HOSTING)
// ==========================================
app.get('/health', (req, res) => {
  const mem = process.memoryUsage();
  const settings = db.getSettings();
  const whatsappStatus = baileysService.getStatus();

  res.json({
    status: 'ok',
    clinic: config.CLINIC_NAME,
    official_phone: config.OFFICIAL_PHONE_FORMATTED,
    timezone: config.TIMEZONE,
    timestamp: DateTime.now().setZone(config.TIMEZONE).toISO(),
    subscription_active: settings.subscription_active,
    whatsapp_status: whatsappStatus.status,
    whatsapp_connected_phone: whatsappStatus.connectedPhone,
    whatsapp_authorized: whatsappStatus.isAuthorized,
    whatsapp_queue_length: whatsappStatus.queueLength,
    active_appointments: db.getAppointments().length,
    active_timers: Object.keys(schedulerService.getActiveTimers()).length,
    memory_usage_mb: Math.round(mem.rss / 1024 / 1024),
    uptime_seconds: Math.round(process.uptime()),
  });
});

// ==========================================
// 2. VINCULACIÓN WHATSAPP QR (BAILEYS)
// ==========================================
app.get('/api/whatsapp/status', (req, res) => {
  res.json(baileysService.getStatus());
});

app.post('/api/whatsapp/simulate-connect', (req, res) => {
  baileysService.simulateConnect();
  res.json({ status: 'success', message: 'Simulación de WhatsApp activada para ' + config.OFFICIAL_PHONE_FORMATTED });
});

app.post('/api/whatsapp/disconnect', async (req, res) => {
  await baileysService.disconnect();
  res.json({ status: 'success', message: 'Sesión de WhatsApp desconectada' });
});

// ==========================================
// 3. GESTIÓN DE CITAS (CALENDARIO MANUAL)
// ==========================================
app.get('/api/appointments', checkLicense, (req, res) => {
  try {
    const appointments = db.getAppointments();
    const timers = schedulerService.getActiveTimers();

    const enriched = appointments.map((a) => ({
      ...a,
      remaining_seconds: timers[a.id] || 0,
    }));

    res.json(enriched);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Endpoint formateado para FullCalendar v6 con los colores de doctorzaragoza.com
app.get('/api/appointments/calendar', checkLicense, (req, res) => {
  try {
    const appointments = db.getAppointments();
    const events = appointments.map((a) => {
      let startDt = DateTime.fromISO(a.appointment_datetime, { zone: config.TIMEZONE });
      if (!startDt.isValid) {
        startDt = DateTime.fromFormat(a.appointment_datetime, 'yyyy-MM-dd HH:mm', { zone: config.TIMEZONE });
      }

      const duration = a.duration_minutes || 30;
      const endDt = startDt.plus({ minutes: duration });
      const theme = config.THEME || { primary: '#F36279' };

      return {
        id: a.id,
        title: `${a.patient_name} · ${a.treatment || 'Consulta'}`,
        start: startDt.toISO(),
        end: endDt.toISO(),
        backgroundColor: '#FFFFFF',
        borderColor: '#E2E8F0',
        textColor: '#2D3748',
        extendedProps: {
          id: a.id,
          patient_name: a.patient_name,
          patient_phone: a.patient_phone,
          specialist: a.specialist,
          treatment: a.treatment || 'Revisión General',
          notes: a.notes || '',
          color: theme.primary,
        },
      };
    });

    res.json(events);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Crear nueva cita manual
app.post('/api/appointments', checkLicense, (req, res) => {
  try {
    const { patient_name, patient_phone, appointment_datetime, specialist, treatment, notes } = req.body;

    if (!patient_name || !patient_phone || !appointment_datetime) {
      return res.status(400).json({ error: 'Faltan campos obligatorios (nombre, teléfono, fecha y hora)' });
    }

    const id = `appt_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 6)}`;
    const newAppt = {
      id,
      patient_name: patient_name.trim(),
      patient_phone: patient_phone.trim(),
      appointment_datetime: appointment_datetime.trim(),
      specialist: (specialist || 'Dr. Zaragozá').trim(),
      treatment: (treatment || 'Revisión General').trim(),
      duration_minutes: 30,
      status: 'PENDING',
      notes: (notes || '').trim(),
      created_at: DateTime.now().setZone(config.TIMEZONE).toISO(),
    };

    // 1. Guardar de forma atómica en el almacenamiento
    db.createAppointment(newAppt);

    // 2. DISPARO INMEDIATO: Mensaje 1 de Confirmación de Agendamiento desde +34610812835
    let dt = DateTime.fromISO(newAppt.appointment_datetime, { zone: config.TIMEZONE });
    if (!dt.isValid) {
      dt = DateTime.fromFormat(newAppt.appointment_datetime, 'yyyy-MM-dd HH:mm', { zone: config.TIMEZONE });
    }
    const fDate = dt.isValid ? dt.toFormat('dd/MM/yyyy') : 'fecha acordada';
    const fTime = dt.isValid ? dt.toFormat('HH:mm') : 'hora acordada';

    // Plantilla Oficial MENSAJE 1
    const courtesyMessage = `Hola ${newAppt.patient_name}, tu cita en la *${config.CLINIC_NAME}* ha sido agendada para el ${fDate} a las ${fTime} con ${newAppt.specialist} 🦷. ¡Te esperamos!`;

    try {
      baileysService.enqueueMessage(newAppt.patient_phone, courtesyMessage, newAppt.id);
    } catch (msgErr) {
      console.error('Advertencia controlada al encolar mensaje 1:', msgErr);
    }

    // 3. PROGRAMACIÓN DE MENSAJE 2 (Recordatorio Informativo 24h antes de la cita)
    try {
      schedulerService.scheduleReminder(newAppt);
    } catch (schedErr) {
      console.error('Advertencia controlada al programar recordatorio:', schedErr);
    }

    res.status(201).json({
      status: 'created',
      message: 'Cita guardada en el calendario exitosamente',
      appointment: newAppt,
      courtesy_enqueued: true,
    });
  } catch (err) {
    console.error('Error al crear cita:', err);
    res.status(500).json({ error: `Error al crear la cita: ${err.message}` });
  }
});

// Actualizar cita (Drag & drop)
app.put('/api/appointments/:id', checkLicense, (req, res) => {
  try {
    const { id } = req.params;
    const { appointment_datetime } = req.body;

    if (!appointment_datetime) {
      return res.status(400).json({ error: 'appointment_datetime es requerido' });
    }

    const updated = db.updateAppointment(id, { appointment_datetime });
    if (!updated) {
      return res.status(404).json({ error: 'Cita no encontrada' });
    }

    // Re-programar recordatorio (24h antes)
    schedulerService.scheduleReminder(updated);

    // Notificar reprogramación por WhatsApp
    let dt = DateTime.fromISO(updated.appointment_datetime, { zone: config.TIMEZONE });
    if (!dt.isValid) {
      dt = DateTime.fromFormat(updated.appointment_datetime, 'yyyy-MM-dd HH:mm', { zone: config.TIMEZONE });
    }
    const fDate = dt.isValid ? dt.toFormat('dd/MM/yyyy') : 'nueva fecha';
    const fTime = dt.isValid ? dt.toFormat('HH:mm') : 'nueva hora';

    const rescheduleMsg = `Hola ${updated.patient_name}, te informamos que tu cita en la *${config.CLINIC_NAME}* ha sido reprogramada para el ${fDate} a las ${fTime} 🦷.`;
    baileysService.enqueueMessage(updated.patient_phone, rescheduleMsg, updated.id);

    res.json({ status: 'updated', appointment: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Eliminar cita
app.delete('/api/appointments/:id', checkLicense, (req, res) => {
  try {
    const { id } = req.params;
    schedulerService.cancelTimer(id);
    const deleted = db.deleteAppointment(id);
    if (deleted) {
      return res.json({ status: 'deleted', id });
    }
    return res.status(404).json({ error: 'Cita no encontrada' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Disparar recordatorio inmediatamente
// ==========================================
// 4. CHAT Y ALERTAS A RECEPCIÓN
// ==========================================
app.get('/api/chat', (req, res) => {
  const phone = req.query.phone || '';
  res.json(db.getChat(phone));
});

app.post('/api/webhook/simulate-patient', async (req, res) => {
  try {
    const { phone, message } = req.body;
    if (!phone || !message) {
      return res.status(400).json({ error: 'phone y message son obligatorios' });
    }
    await baileysService.handleInboundResponse(phone, message);
    res.json({ status: 'received', phone, message });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/alerts', (req, res) => {
  let alerts = db.getAlerts();
  // Regla estricta de limpieza: No mostrar ninguna alerta si el estado actual es CONNECTED
  if (baileysService.status === 'CONNECTED') {
    alerts = alerts.filter((a) => a.type !== 'WHATSAPP_DESCONECTADO');
  }
  res.json(alerts);
});

app.delete('/api/alerts/:id', (req, res) => {
  const { id } = req.params;
  const success = db.removeAlert(id);
  res.json({ status: success ? 'deleted' : 'not_found', id });
});

app.delete('/api/alerts', (req, res) => {
  db.clearAlerts();
  res.json({ status: 'cleared' });
});

// ==========================================
// 5. CONFIGURACIÓN Y CONTROL SAAS
// ==========================================
app.get('/api/settings', (req, res) => {
  const settings = db.getSettings();
  res.json({
    ...settings,
    clinic_name: config.CLINIC_NAME,
    official_phone: config.OFFICIAL_PHONE_FORMATTED,
    timezone: config.TIMEZONE,
    active_timers: schedulerService.getActiveTimers(),
  });
});

app.post('/api/settings/toggle-license', (req, res) => {
  const settings = db.getSettings();
  const newActive = !settings.subscription_active;
  db.updateSettings({ subscription_active: newActive });
  res.json({
    subscription_active: newActive,
    message: `Suscripción SaaS ${newActive ? 'ACTIVA' : 'SUSPENDIDA'}`,
  });
});

// Página principal
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('🚨 Error no controlado capturado por el servidor:', err);
  res.status(500).json({
    status: 'error',
    message: 'Error interno controlado',
    details: err.message,
  });
});

process.on('unhandledRejection', (reason) => {
  console.warn('⚠️ [UNHANDLED REJECTION CAUGHT]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('🚨 [UNCAUGHT EXCEPTION CAUGHT]', err);
});

const PORT = process.env.PORT || config.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n======================================================`);
  console.log(`🦷 CLÍNICA DENTAL DR. ZARAGOZÁ - SERVIDOR MAESTRO ACTIVO`);
  console.log(`📡 Puerto: http://0.0.0.0:${PORT}`);
  console.log(`📱 Número Emisor Oficial Autorizado: ${config.OFFICIAL_PHONE_FORMATTED}`);
  console.log(`🛡️ Protección Antibloqueo: Pausas de 3-5s activadas`);
  console.log(`☁️ Arquitectura Zero-Cost: Persistencia Local & Keep-Alive`);
  console.log(`======================================================\n`);
});
