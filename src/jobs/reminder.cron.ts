import { DateTime } from 'luxon';
import { config } from '../config';
import { CalendarService } from '../services/calendar.service';
import { WhatsAppService } from '../services/whatsapp.service';
import { logger } from '../utils/logger';

export class ReminderJob {
  private static isRunning = false;

  /**
   * Ejecuta la rutina de verificación y envío de recordatorios 24h antes.
   */
  public static async execute(): Promise<{ processedCount: number; errors: number }> {
    if (this.isRunning) {
      logger.warn('El cron de recordatorios ya está en ejecución. Omitiendo ciclo simultáneo.');
      return { processedCount: 0, errors: 0 };
    }

    this.isRunning = true;
    let processedCount = 0;
    let errors = 0;

    try {
      logger.info('Iniciando escaneo de citas para recordatorios 24h (Dr. Zaragozá)...');

      const appointments = await CalendarService.getAppointmentsForReminderWindow(
        config.REMINDER_HOURS_BEFORE,
        config.REMINDER_WINDOW_TOLERANCE_MINUTES
      );

      logger.info({ count: appointments.length }, 'Citas a procesar encontradas');

      for (const appointment of appointments) {
        try {
          // Asegurar que la hora se formatea explícitamente en Europe/Madrid
          const dtInMadrid = DateTime.fromISO(appointment.appointment_datetime, { zone: config.TIMEZONE });
          const formattedTime = dtInMadrid.toFormat('HH:mm');

          const messageText = WhatsAppService.buildReminderMessage(appointment, formattedTime);

          // Enviar WhatsApp
          const sendResult = await WhatsAppService.sendMessage(appointment.patient_phone, messageText);

          if (sendResult.success) {
            // Actualizar estado a REMINDER_SENT para evitar reenviar en la siguiente pasada
            await CalendarService.updateAppointmentStatus(
              appointment.id,
              'REMINDER_SENT',
              `Recordatorio 24h enviado exitosamente a las ${DateTime.now().setZone(config.TIMEZONE).toISO()}`
            );
            processedCount++;
            logger.info(
              { appointmentId: appointment.id, patient: appointment.patient_name, phone: appointment.patient_phone },
              'Recordatorio enviado con éxito'
            );
          } else {
            errors++;
            logger.error(
              { appointmentId: appointment.id, error: sendResult.error },
              'Fallo al enviar el mensaje de WhatsApp'
            );
          }
        } catch (itemErr: any) {
          errors++;
          logger.error({ appointmentId: appointment.id, err: itemErr.message }, 'Error procesando cita individual');
        }
      }

      logger.info(
        { processedCount, errors, totalEvaluated: appointments.length },
        'Ciclo de recordatorios completado'
      );
    } catch (err: any) {
      logger.error({ err: err.message }, 'Error crítico durante la ejecución del job de recordatorios');
    } finally {
      this.isRunning = false;
    }

    return { processedCount, errors };
  }
}
