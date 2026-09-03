import { ReceptionAlertPayload } from '../types/appointment';
import { config } from '../config';
import { logger } from '../utils/logger';

export class AlertService {
  /**
   * Envía una notificación urgente a la recepción de la clínica Dr. Zaragozá.
   * Usado para cancelaciones (liberar o reasignar hueco) o mensajes ambiguos (MANUAL_REVIEW).
   */
  public static async notifyReception(alert: ReceptionAlertPayload): Promise<void> {
    logger.warn(
      {
        type: alert.type,
        patientPhone: alert.patientPhone,
        patientName: alert.patientName || 'Desconocido',
        patientMessage: alert.patientMessage,
        reason: alert.reason,
      },
      `🚨 ALERTA A RECEPCIÓN DR. ZARAGOZÁ: [${alert.type}]`
    );

    // Si hay un webhook de recepción configurado (ej: canal de Slack, Teams, webhook de CRM)
    if (config.RECEPTION_ALERT_WEBHOOK_URL) {
      try {
        const response = await fetch(config.RECEPTION_ALERT_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: `[Alerta Clínica Dr. Zaragozá] ${alert.type}`,
            patient: alert.patientName || alert.patientPhone,
            phone: alert.patientPhone,
            message: alert.patientMessage,
            reason: alert.reason,
            timestamp: alert.timestamp,
            appointmentDetails: alert.appointment
              ? {
                  dateTime: alert.appointment.appointment_datetime,
                  specialist: alert.appointment.specialist,
                  status: alert.appointment.status,
                }
              : null,
          }),
        });

        if (!response.ok) {
          logger.error({ status: response.status }, 'Fallo al enviar webhook a recepción');
        } else {
          logger.info('Notificación enviada exitosamente al webhook de recepción');
        }
      } catch (err: any) {
        logger.error({ err: err.message }, 'Error de red enviando alerta al webhook de recepción');
      }
    }

    // Aquí se puede integrar nodemailer / Resend / Twilio SMS interno si se activa RECEPTION_ALERT_EMAIL
    if (config.RECEPTION_ALERT_EMAIL) {
      logger.info({ email: config.RECEPTION_ALERT_EMAIL }, 'Simulando despacho de email a recepción');
    }
  }
}
