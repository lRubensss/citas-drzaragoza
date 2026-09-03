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
   * Programa el recordatorio informativo oficial:
   * Se programa para enviarse automáticamente 24 horas antes del inicio de la cita.
   */
  scheduleReminder(appointment) {
    this.cancelTimer(appointment.id);

    const nowMadrid = DateTime.now().setZone(config.TIMEZONE);
    let apptDateTime = DateTime.fromISO(appointment.appointment_datetime, { zone: config.TIMEZONE });
    if (!apptDateTime.isValid) {
      apptDateTime = DateTime.fromFormat(appointment.appointment_datetime, 'yyyy-MM-dd HH:mm', {
        zone: config.TIMEZONE,
      });
    }

    if (!apptDateTime.isValid) {
      console.warn(`[SCHEDULER] Fecha de cita no válida: ${appointment.appointment_datetime}`);
      return;
    }

    const diffSeconds = apptDateTime.diff(nowMadrid, 'seconds').seconds;
    const secondsUntil24h = diffSeconds - 24 * 3600;

    if (secondsUntil24h > 0) {
      console.log(`📅 [RECORDATORIO OFICIAL] Programado para ${appointment.patient_name} en ${Math.round(secondsUntil24h / 3600)}h (24h antes de la consulta).`);
      const timer = setTimeout(async () => {
        await this.fireReminder(appointment.id);
      }, secondsUntil24h * 1000);

      this.activeTimers.set(appointment.id, {
        timer,
        fireTimestamp: Date.now() + secondsUntil24h * 1000,
        appointmentId: appointment.id,
      });
    } else {
      console.log(`ℹ️ [SCHEDULER] La cita de ${appointment.patient_name} es en menos de 24h. Confirmada informativamente al crear.`);
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
