import twilio from 'twilio';
import { CLINIC_NAME, config } from '../config';
import { Appointment, WhatsAppSendResult } from '../types/appointment';
import { logger } from '../utils/logger';

export class WhatsAppService {
  private static twilioClient: twilio.Twilio | null = null;

  private static getTwilioClient(): twilio.Twilio | null {
    if (!this.twilioClient && config.TWILIO_ACCOUNT_SID && config.TWILIO_AUTH_TOKEN) {
      this.twilioClient = twilio(config.TWILIO_ACCOUNT_SID, config.TWILIO_AUTH_TOKEN);
    }
    return this.twilioClient;
  }

  /**
   * Genera el texto oficial del recordatorio 24h
   */
  public static buildReminderMessage(appointment: Appointment, formattedTime: string): string {
    return (
      `Hola ${appointment.patient_name}, te recordamos tu cita mañana a las ${formattedTime} en la **${CLINIC_NAME}** con ${appointment.specialist} 🦷.\n\n` +
      `Por favor, responde a este mensaje para gestionar tu turno:\n` +
      `1️⃣ Escribe *CONFIRMAR* para asegurar tu cita.\n` +
      `2️⃣ Escribe *CANCELAR* si no vas a poder asistir.`
    );
  }

  /**
   * Genera la respuesta ante confirmación exitosa
   */
  public static buildConfirmationMessage(patientName: string): string {
    return `¡Perfecto, ${patientName}! Tu cita en ${CLINIC_NAME} queda confirmada. ¡Te esperamos!`;
  }

  /**
   * Genera la respuesta ante cancelación
   */
  public static buildCancellationMessage(): string {
    return `Entendido. Hemos cancelado tu cita. Si deseas reagendar, escríbenos o llámanos. ¡Que tengas buen día!`;
  }

  /**
   * Genera la respuesta para fallback humano
   */
  public static buildFallbackMessage(): string {
    return `No hemos entendido tu respuesta. Un agente de la ${CLINIC_NAME} se pondrá en contacto contigo a la brevedad.`;
  }

  /**
   * Genera la respuesta si la cita ya estaba confirmada previamente
   */
  public static buildAlreadyConfirmedMessage(patientName: string): string {
    return `Hola ${patientName}, tu cita en ${CLINIC_NAME} ya se encontraba confirmada previamente. ¡Muchas gracias!`;
  }

  /**
   * Genera la respuesta si la cita ya estaba cancelada previamente
   */
  public static buildAlreadyCancelledMessage(): string {
    return `Tu cita ya había sido cancelada previamente. Para concertar una nueva cita, por favor contacta con nosotros.`;
  }

  /**
   * Envía un mensaje de WhatsApp al paciente utilizando el proveedor configurado
   */
  public static async sendMessage(toPhone: string, messageText: string): Promise<WhatsAppSendResult> {
    // Asegurar formato E.164
    const cleanPhone = toPhone.startsWith('+') ? toPhone : `+${toPhone}`;

    logger.info({ provider: config.WHATSAPP_PROVIDER, to: cleanPhone }, 'Enviando mensaje WhatsApp');

    // 1. MOCK MODE (Para desarrollo, pruebas automáticas y test locales)
    if (config.WHATSAPP_PROVIDER === 'mock' || !config.TWILIO_ACCOUNT_SID) {
      logger.info(`[MOCK WHATSAPP OUTBOUND to ${cleanPhone}]:\n"${messageText}"`);
      return {
        success: true,
        messageId: `mock_msg_${Date.now()}_${Math.random().toString(36).substring(7)}`,
      };
    }

    // 2. TWILIO
    if (config.WHATSAPP_PROVIDER === 'twilio') {
      try {
        const client = this.getTwilioClient();
        if (!client) {
          throw new Error('Twilio client no inicializado (faltan credenciales)');
        }

        const from = `whatsapp:${config.TWILIO_WHATSAPP_NUMBER}`;
        const to = `whatsapp:${cleanPhone}`;

        const res = await client.messages.create({
          from,
          to,
          body: messageText,
        });

        logger.info({ sid: res.sid, status: res.status }, 'Mensaje Twilio enviado con éxito');
        return { success: true, messageId: res.sid };
      } catch (err: any) {
        logger.error({ err: err.message, to: cleanPhone }, 'Error enviando mensaje vía Twilio');
        return { success: false, error: err.message };
      }
    }

    // 3. META CLOUD API (WhatsApp Business API)
    if (config.WHATSAPP_PROVIDER === 'meta') {
      try {
        const phoneNumberId = config.META_PHONE_NUMBER_ID;
        const token = config.META_WHATSAPP_TOKEN;

        if (!phoneNumberId || !token) {
          throw new Error('Faltan META_PHONE_NUMBER_ID o META_WHATSAPP_TOKEN');
        }

        const url = `https://graph.facebook.com/v19.0/${phoneNumberId}/messages`;
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: cleanPhone.replace('+', ''),
            type: 'text',
            text: { body: messageText },
          }),
        });

        const data = (await res.json()) as any;
        if (!res.ok) {
          throw new Error(`Meta API error: ${JSON.stringify(data)}`);
        }

        const messageId = data?.messages?.[0]?.id || 'meta_sent';
        logger.info({ messageId }, 'Mensaje Meta Cloud API enviado con éxito');
        return { success: true, messageId };
      } catch (err: any) {
        logger.error({ err: err.message, to: cleanPhone }, 'Error enviando mensaje vía Meta');
        return { success: false, error: err.message };
      }
    }

    return { success: false, error: 'Proveedor no soportado' };
  }
}
