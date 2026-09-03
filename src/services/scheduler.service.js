const { DateTime } = require('luxon');
const config = require('../config');
const db = require('../store/database');
const baileysService = require('./baileys.service');

class SchedulerService {
  constructor() {
    // appointmentId -> { timer, fireTimestamp, appointmentId }
    this.activeTimers = new Map();

    // Cron job interno cada 10 minutos para escanear ventana de 24h
    this.cronInterval = setInterval(() => this.cronScan(), 10 * 60 * 1000);
  }

  /**
   * Programa el recordatorio inteligente:
   * - En Modo Pruebas (o cita a <= 3 min) -> Se dispara a los 60 SEGUNDOS exactos.
   * - En Producción -> Se programa para 24 horas antes del inicio de la consulta.
   */
  scheduleReminder(appointment, isTestMode = true) {
    this.cancelTimer(appointment.id);

    const nowMadrid = DateTime.now().setZone(config.TIMEZONE);
    let apptDateTime = DateTime.fromISO(appointment.appointment_datetime, { zone: config.TIMEZONE });
    if (!apptDateTime.isValid) {
      apptDateTime = DateTime.fromFormat(appointment.appointment_datetime, 'yyyy-MM-dd HH:mm', {
        zone: config.TIMEZONE,
      });
    }

    const diffSeconds = apptDateTime.diff(nowMadrid, 'seconds').seconds;

    // Si es Modo Pruebas o la cita está programada para dentro de <= 3 minutos
    if (isTestMode || (diffSeconds > 0 && diffSeconds <= 180)) {
      const delayMs = 60 * 1000; // 60 segundos exactos
      const fireTimestamp = Date.now() + delayMs;

      console.log(`⏱️ [MODO PRUEBAS] Programando recordatorio para ${appointment.patient_name} en 60 segundos.`);

      const timer = setTimeout(async () => {
        await this.fireReminder(appointment.id);
      }, delayMs);

      this.activeTimers.set(appointment.id, { timer, fireTimestamp, appointmentId: appointment.id });
    } else {
      // Producción: 24 horas antes
      const secondsUntil24h = diffSeconds - 24 * 3600;
      if (secondsUntil24h > 0 && secondsUntil24h <= 7 * 86400) {
        console.log(`📅 [PRODUCCIÓN] Recordatorio para ${appointment.patient_name} programado en ${Math.round(secondsUntil24h)}s (24h antes).`);
        const timer = setTimeout(async () => {
          await this.fireReminder(appointment.id);
        }, secondsUntil24h * 1000);

        this.activeTimers.set(appointment.id, {
          timer,
          fireTimestamp: Date.now() + secondsUntil24h * 1000,
          appointmentId: appointment.id,
        });
      }
    }
  }

  /**
   * Dispara el Mensaje 2 (Recordatorio Informativo) oficial
   */
  async fireReminder(appointmentId) {
    this.activeTimers.delete(appointmentId);

    const appt = db.findAppointmentById(appointmentId);
    if (!appt || appt.reminder_sent) {
      return false;
    }

    let apptDateTime = DateTime.fromISO(appt.appointment_datetime, { zone: config.TIMEZONE });
    if (!apptDateTime.isValid) {
      apptDateTime = DateTime.fromFormat(appt.appointment_datetime, 'yyyy-MM-dd HH:mm', { zone: config.TIMEZONE });
    }

    const fDate = apptDateTime.isValid ? apptDateTime.toFormat('dd/MM/yyyy') : 'mañana';
    const fTime = apptDateTime.isValid ? apptDateTime.toFormat('HH:mm') : 'hora acordada';
    const specialist = appt.specialist || 'nuestro equipo';

    // Plantilla Oficial MENSAJE 2 (100% informativo, sin pedir respuesta)
    const reminderText = `Hola ${appt.patient_name}, te recordamos que mañana ${fDate} a las ${fTime} tienes tu consulta en la *${config.CLINIC_NAME}* con ${specialist} 🦷.\n\n📍 Te esperamos en la clínica. Si necesitas cualquier consulta o cambio de horario, puedes llamarnos o escribirnos por aquí.\n\n¡Que tengas un buen día!`;

    // Encolar mensaje en la cola con protección antibloqueo
    baileysService.enqueueMessage(appt.patient_phone, reminderText, appt.id);

    // Marcar recordatorio enviado
    db.updateAppointment(appt.id, {
      reminder_sent: true,
      notes: `${appt.notes || ''} | Recordatorio enviado a las ${DateTime.now().setZone(config.TIMEZONE).toFormat('HH:mm:ss')}`.trim(),
    });

    console.log(`✅ [MENSAJE 2 INFORMATIVO] Encolado para ${appt.patient_name} (${appt.patient_phone})`);
    return true;
  }

  /**
   * Dispara de inmediato sin esperar la cuenta atrás
   */
  async fireImmediately(appointmentId) {
    this.cancelTimer(appointmentId);
    return await this.fireReminder(appointmentId);
  }

  cancelTimer(appointmentId) {
    if (this.activeTimers.has(appointmentId)) {
      clearTimeout(this.activeTimers.get(appointmentId).timer);
      this.activeTimers.delete(appointmentId);
    }
  }

  getActiveTimers() {
    const result = {};
    const now = Date.now();
    for (const [id, data] of this.activeTimers.entries()) {
      const remainingSec = Math.max(0, Math.round((data.fireTimestamp - now) / 1000));
      result[id] = remainingSec;
    }
    return result;
  }

  /**
   * Cron interno para chequear citas en ventana de 24h
   */
  async cronScan() {
    const nowMadrid = DateTime.now().setZone(config.TIMEZONE);
    const appts = db.getAppointments();

    for (const appt of appts) {
      if (appt.reminder_sent) continue;

      let apptDT = DateTime.fromISO(appt.appointment_datetime, { zone: config.TIMEZONE });
      if (!apptDT.isValid) {
        apptDT = DateTime.fromFormat(appt.appointment_datetime, 'yyyy-MM-dd HH:mm', { zone: config.TIMEZONE });
      }

      if (!apptDT.isValid) continue;

      const hoursUntil = apptDT.diff(nowMadrid, 'hours').hours;
      // Si faltan entre 23 y 25 horas
      if (hoursUntil >= 23 && hoursUntil <= 25) {
        await this.fireReminder(appt.id);
      }
    }
  }
}

module.exports = new SchedulerService();
