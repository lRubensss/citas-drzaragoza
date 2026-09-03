import { Request, Response } from 'express';
import { DateTime } from 'luxon';
import { config } from '../config';
import { AlertService } from '../services/alert.service';
import { CalendarService } from '../services/calendar.service';
import { NlpService } from '../services/nlp.service';
import { StateService } from '../services/state.service';
import { WhatsAppService } from '../services/whatsapp.service';
import { IncomingWhatsAppMessage } from '../types/appointment';
import { logger } from '../utils/logger';

export class WebhookController {
  /**
   * Extrae el mensaje normalizado tanto si proviene de Twilio como de Meta Cloud API o simulación
   */
  public static extractMessage(req: Request): IncomingWhatsAppMessage | null {
    // 1. Formato Twilio (application/x-www-form-urlencoded o JSON)
    if (req.body && (req.body.From || req.body.Body)) {
      const from = (req.body.From || '').replace('whatsapp:', '').trim();
      const body = (req.body.Body || '').trim();
      const messageId = req.body.MessageSid || req.body.SmsMessageSid || `tw_${Date.now()}`;
      return {
        from,
        body,
        messageId,
        provider: 'twilio',
      };
    }

    // 2. Formato Meta Cloud API (JSON estructurado)
    if (req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]) {
      const msg = req.body.entry[0].changes[0].value.messages[0];
      const from = `+${msg.from}`;
      let body = '';

      if (msg.type === 'text') {
        body = msg.text.body;
      } else if (msg.type === 'button') {
        body = msg.button.text || msg.button.payload;
      } else if (msg.type === 'interactive') {
        body =
          msg.interactive.button_reply?.title ||
          msg.interactive.list_reply?.title ||
          '';
      }

      return {
        from,
        body,
        messageId: msg.id || `meta_${Date.now()}`,
        provider: 'meta',
        timestamp: msg.timestamp,
      };
    }

    // 3. Formato JSON genérico directo (usado en tests y llamadas internas)
    if (req.body?.phone && req.body?.message) {
      return {
        from: req.body.phone,
        body: req.body.message,
        messageId: req.body.messageId || `direct_${Date.now()}`,
        provider: 'mock',
      };
    }

    return null;
  }

  /**
   * Endpoint receptor de Webhooks de WhatsApp (Inbound)
   */
  public static async handleInboundMessage(req: Request, res: Response): Promise<void> {
    const parsed = WebhookController.extractMessage(req);

    if (!parsed || !parsed.from || !parsed.body) {
      logger.warn({ body: req.body }, 'Petición webhook descartada: payload no reconocido o vacío');
      res.status(400).json({ error: 'Payload de mensaje inválido' });
      return;
    }

    const { from: patientPhone, body: rawText, messageId } = parsed;

    logger.info({ patientPhone, rawText, messageId }, '📥 Mensaje de WhatsApp entrante recibido');

    // 1. REGLA ANTI-BUCLE / IDEMPOTENCIA: Verificar si el mensaje ya fue procesado
    if (StateService.isMessageAlreadyProcessed(messageId)) {
      logger.info({ messageId }, 'Mensaje ya procesado anteriormente. Respondiendo HTTP 200 idempotente.');
      res.status(200).send('<Response/>'); // Formato TwiML vacío o 200 OK
      return;
    }

    // 2. REGLA RACE CONDITION: Bloqueo atómico por teléfono del paciente
    const lockAcquired = await StateService.acquireLock(patientPhone);
    if (!lockAcquired) {
      logger.warn({ patientPhone }, 'Operación simultánea en curso para este paciente. Descartando colisión.');
      res.status(429).json({ error: 'Operación en curso para este paciente' });
      return;
    }

    try {
      // 3. Buscar cita activa del paciente
      const appointment = await CalendarService.findActiveAppointmentByPhone(patientPhone);

      if (!appointment) {
        logger.warn({ patientPhone }, 'No se encontró cita activa para este teléfono');
        // Notificar amablemente al usuario y enviar alerta leve a recepción
        await WhatsAppService.sendMessage(
          patientPhone,
          'Hola, no encontramos ninguna cita activa próxima asociada a este número en Clínica Dr. Zaragozá. Si necesitas gestionar un turno, por favor llámanos directamente.'
        );
        res.status(200).send('<Response/>');
        return;
      }

      // 4. REGLA ANTI-BUCLE: Si la cita ya está en estado terminal (CONFIRMED / CANCELLED)
      if (StateService.isTerminalStatus(appointment.status)) {
        const { isSpamLoop } = StateService.registerInteraction(patientPhone, appointment.status);
        if (isSpamLoop) {
          logger.warn({ patientPhone, status: appointment.status }, 'Usuario en spam loop: omitiendo respuesta para evitar bucle.');
          res.status(200).send('<Response/>');
          return;
        }

        if (appointment.status === 'CONFIRMED') {
          await WhatsAppService.sendMessage(
            patientPhone,
            WhatsAppService.buildAlreadyConfirmedMessage(appointment.patient_name)
          );
        } else if (appointment.status === 'CANCELLED') {
          await WhatsAppService.sendMessage(
            patientPhone,
            WhatsAppService.buildAlreadyCancelledMessage()
          );
        }
        res.status(200).send('<Response/>');
        return;
      }

      // 5. CLASIFICACIÓN DE INTENCIÓN NLP (Normalización de tildes, minúsculas, números 1/2)
      const classification = NlpService.classifyIntent(rawText);

      switch (classification.intent) {
        case 'CONFIRM': {
          logger.info({ appointmentId: appointment.id }, 'Paciente confirmó la cita');

          // Actualizar calendario a estado CONFIRMED (verde y prefijo [CONFIRMADO])
          await CalendarService.updateAppointmentStatus(
            appointment.id,
            'CONFIRMED',
            `Confirmada por WhatsApp por el paciente a las ${DateTime.now().setZone(config.TIMEZONE).toISO()}`
          );

          // Registrar interacción para control de bucles
          StateService.registerInteraction(patientPhone, 'CONFIRMED');

          // Responder al paciente
          await WhatsAppService.sendMessage(
            patientPhone,
            WhatsAppService.buildConfirmationMessage(appointment.patient_name)
          );
          break;
        }

        case 'CANCEL': {
          logger.info({ appointmentId: appointment.id }, 'Paciente canceló la cita');

          // Actualizar calendario a estado CANCELLED (rojo/liberar y prefijo [CANCELADO])
          await CalendarService.updateAppointmentStatus(
            appointment.id,
            'CANCELLED',
            `Cancelada por WhatsApp por el paciente a las ${DateTime.now().setZone(config.TIMEZONE).toISO()}`
          );

          // Registrar interacción para control de bucles
          StateService.registerInteraction(patientPhone, 'CANCELLED');

          // ALERTA INMEDIATA A RECEPCIÓN para cubrir el hueco
          await AlertService.notifyReception({
            type: 'CANCELLATION',
            appointment,
            patientPhone,
            patientName: appointment.patient_name,
            patientMessage: rawText,
            reason: 'El paciente canceló su cita por WhatsApp tras el recordatorio de 24h.',
            timestamp: DateTime.now().setZone(config.TIMEZONE).toISO()!,
          });

          // Responder al paciente
          await WhatsAppService.sendMessage(
            patientPhone,
            WhatsAppService.buildCancellationMessage()
          );
          break;
        }

        case 'UNKNOWN':
        default: {
          logger.warn(
            { appointmentId: appointment.id, rawText },
            'Respuesta no comprendida o ambigua -> Activando Fallback Humano'
          );

          // Actualizar calendario a estado MANUAL_REVIEW
          await CalendarService.updateAppointmentStatus(
            appointment.id,
            'MANUAL_REVIEW',
            `Mensaje no comprendido recibido: "${rawText}"`
          );

          // ALERTA OBLIGATORIA A RECEPCIÓN PARA REVISIÓN MANUAL
          await AlertService.notifyReception({
            type: 'MANUAL_REVIEW_NEEDED',
            appointment,
            patientPhone,
            patientName: appointment.patient_name,
            patientMessage: rawText,
            reason: 'El paciente respondió un texto complejo o no tipificado. Requiere contacto humano.',
            timestamp: DateTime.now().setZone(config.TIMEZONE).toISO()!,
          });

          // Responder al paciente con el mensaje oficial de fallback
          await WhatsAppService.sendMessage(
            patientPhone,
            WhatsAppService.buildFallbackMessage()
          );
          break;
        }
      }

      res.status(200).send('<Response/>');
    } catch (err: any) {
      logger.error({ err: err.message, stack: err.stack }, 'Error procesando webhook de WhatsApp');
      res.status(500).json({ error: 'Internal Server Error' });
    } finally {
      // Liberar el bloqueo del paciente siempre
      StateService.releaseLock(patientPhone);
    }
  }

  /**
   * Endpoint de verificación para webhook de Meta Cloud API (GET challenge)
   */
  public static verifyMetaWebhook(req: Request, res: Response): void {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === (process.env.META_VERIFY_TOKEN || 'dr_zaragoza_secret_token')) {
      logger.info('Webhook de Meta verificado satisfactoriamente');
      res.status(200).send(challenge);
    } else {
      res.status(403).send('Forbidden');
    }
  }
}
