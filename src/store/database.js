const fs = require('fs');
const path = require('path');
const { DateTime } = require('luxon');
const config = require('../config');
const supabaseService = require('../services/supabase.service');

const DB_FILE = path.join(__dirname, '../../data/database.json');

class DatabaseStore {
  constructor() {
    this.data = {
      appointments: [],
      alerts: [],
      chats: {},
      settings: {
        subscription_active: config.SUBSCRIPTION_ACTIVE,
      },
    };
    this.init();
  }

  async init() {
    const dir = path.dirname(DB_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // 1. Carga inicial local
    if (fs.existsSync(DB_FILE)) {
      try {
        const raw = fs.readFileSync(DB_FILE, 'utf-8');
        this.data = JSON.parse(raw);
      } catch (err) {
        console.error('Error leyendo base de datos local:', err);
        this.seedInitialData();
      }
    } else {
      this.seedInitialData();
    }

    // 2. Si Supabase está configurado, hidratar desde la nube
    if (supabaseService.isEnabled) {
      try {
        await supabaseService.ensureTables();
        const cloudData = await supabaseService.loadClinicState();
        if (cloudData && Array.isArray(cloudData.appointments)) {
          this.data = cloudData;
          fs.writeFileSync(DB_FILE, JSON.stringify(this.data, null, 2), 'utf-8');
          console.log(`✅ [SUPABASE STATE LOADED] ${this.data.appointments.length} citas cargadas desde Supabase.`);
        } else {
          // Primera vez: subir los datos locales a Supabase
          await supabaseService.saveClinicState(this.data);
        }
      } catch (err) {
        console.warn('⚠️ [SUPABASE SYNC WARN] No se pudo sincronizar estado con Supabase al inicio:', err.message);
      }
    }
  }

  save() {
    try {
      fs.writeFileSync(DB_FILE, JSON.stringify(this.data, null, 2), 'utf-8');
      if (supabaseService.isEnabled) {
        supabaseService.saveClinicState(this.data).catch((e) => {
          console.warn('[SUPABASE ASYNC SAVE WARN]', e.message);
        });
      }
    } catch (err) {
      console.error('Error guardando base de datos:', err);
    }
  }

  seedInitialData() {
    const nowMadrid = DateTime.now().setZone(config.TIMEZONE);

    this.data.appointments = [
      {
        id: 'appt-zaragoza-001',
        patient_name: 'Elena Navarro',
        patient_phone: '+34611223344',
        appointment_datetime: nowMadrid.plus({ days: 1, hours: 2 }).toFormat('yyyy-MM-dd HH:mm'),
        specialist: 'Dr. Zaragozá (Implantes 🦷)',
        treatment: 'Implante Dental',
        duration_minutes: 30,
        status: 'PENDING',
        notes: 'Revisión implante primer cuadrante',
        created_at: nowMadrid.toISO(),
      },
      {
        id: 'appt-zaragoza-002',
        patient_name: 'Carlos Ruiz',
        patient_phone: '+34655443322',
        appointment_datetime: nowMadrid.plus({ days: 1, hours: 4 }).toFormat('yyyy-MM-dd HH:mm'),
        specialist: 'Dra. Martínez (Ortodoncia)',
        treatment: 'Ortodoncia Invisible',
        duration_minutes: 30,
        status: 'REMINDER_SENT',
        notes: 'Ajuste de alineadores mensual',
        created_at: nowMadrid.toISO(),
      },
      {
        id: 'appt-zaragoza-003',
        patient_name: 'Laura Gómez',
        patient_phone: '+34699887766',
        appointment_datetime: nowMadrid.plus({ days: 2, hours: 6 }).toFormat('yyyy-MM-dd HH:mm'),
        specialist: 'Dra. Vicente (Higiene Dental)',
        treatment: 'Limpieza y Fluorización',
        duration_minutes: 30,
        status: 'CONFIRMED',
        notes: 'Limpieza anual',
        created_at: nowMadrid.toISO(),
      },
    ];

    this.data.chats['+34655443322'] = [
      {
        sender: 'bot',
        text: `Hola Carlos Ruiz, tu cita en la *${config.CLINIC_NAME}* ha sido programada para el ${nowMadrid.plus({ days: 1, hours: 4 }).toFormat('dd/MM/yyyy')} a las ${nowMadrid.plus({ days: 1, hours: 4 }).toFormat('HH:mm')} con Dra. Martínez (Ortodoncia) 🦷. ¡Te esperamos!`,
        time: nowMadrid.toFormat('HH:mm'),
      },
      {
        sender: 'bot',
        text: `Hola Carlos Ruiz, te recordamos que mañana ${nowMadrid.plus({ days: 1, hours: 4 }).toFormat('dd/MM/yyyy')} a las ${nowMadrid.plus({ days: 1, hours: 4 }).toFormat('HH:mm')} tienes tu consulta en la *${config.CLINIC_NAME}* 📲.\n\nPor favor, responde a este mensaje para gestionar tu turno:\n1️⃣ Escribe *CONFIRMAR* para asegurar tu asistencia.\n2️⃣ Escribe *CANCELAR* si deseas liberar el hueco.`,
        time: nowMadrid.plus({ minutes: 1 }).toFormat('HH:mm'),
      }
    ];

    this.save();
  }

  // --- MÉTODOS DE CITAS ---
  getAppointments() {
    return this.data.appointments;
  }

  findAppointmentById(id) {
    return this.data.appointments.find((a) => a.id === id);
  }

  findAppointmentByPhone(phone) {
    const searchDigits = String(phone || '').replace(/\D/g, '');
    if (!searchDigits) return null;
    return this.data.appointments.find((a) => {
      const apptDigits = String(a.patient_phone || '').replace(/\D/g, '');
      if (apptDigits === searchDigits) return true;
      // Coincidencia por los últimos 9 dígitos (número local español)
      if (apptDigits.length >= 9 && searchDigits.length >= 9) {
        return apptDigits.slice(-9) === searchDigits.slice(-9);
      }
      return false;
    });
  }

  createAppointment(appt) {
    this.data.appointments.push(appt);
    this.save();
    return appt;
  }

  updateAppointment(id, updates) {
    const appt = this.findAppointmentById(id);
    if (appt) {
      Object.assign(appt, updates);
      this.save();
      return appt;
    }
    return null;
  }

  deleteAppointment(id) {
    const prevLen = this.data.appointments.length;
    this.data.appointments = this.data.appointments.filter((a) => a.id !== id);
    if (this.data.appointments.length < prevLen) {
      this.save();
      return true;
    }
    return false;
  }

  // --- MÉTODOS DE CHAT ---
  getChat(phone) {
    const clean = phone.startsWith('+') ? phone : `+${phone}`;
    return this.data.chats[clean] || [];
  }

  recordMessage(phone, sender, text) {
    const clean = phone.startsWith('+') ? phone : `+${phone}`;
    if (!this.data.chats[clean]) {
      this.data.chats[clean] = [];
    }
    const time = DateTime.now().setZone(config.TIMEZONE).toFormat('HH:mm');
    this.data.chats[clean].push({ sender, text, time });
    this.save();
  }

  // --- MÉTODOS DE ALERTAS ---
  getAlerts() {
    return this.data.alerts || [];
  }

  addAlert(alert) {
    const newAlert = {
      id: `alert_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
      ...alert,
      timestamp: DateTime.now().setZone(config.TIMEZONE).toFormat('HH:mm:ss - dd/MM/yyyy'),
    };
    if (!this.data.alerts) this.data.alerts = [];
    this.data.alerts.unshift(newAlert);
    if (this.data.alerts.length > 50) this.data.alerts.pop();
    this.save();
    return newAlert;
  }

  removeAlert(alertId) {
    if (!this.data.alerts) return false;
    const prevLen = this.data.alerts.length;
    this.data.alerts = this.data.alerts.filter((a) => a.id !== alertId);
    if (this.data.alerts.length < prevLen) {
      this.save();
      return true;
    }
    return false;
  }

  clearAlerts() {
    this.data.alerts = [];
    this.save();
  }

  // --- MÉTODOS DE SETTINGS / SAAS ---
  getSettings() {
    return this.data.settings;
  }

  updateSettings(updates) {
    Object.assign(this.data.settings, updates);
    this.save();
    return this.data.settings;
  }
}

module.exports = new DatabaseStore();
