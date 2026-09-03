/**
 * Definición de tipos y modelos para el sistema de citas de la Clínica Dr. Zaragozá
 */

export type AppointmentStatus =
  | 'PENDING'          // Cita programada, aún no se ha enviado el recordatorio
  | 'REMINDER_SENT'    // Recordatorio 24h enviado, esperando respuesta del paciente
  | 'CONFIRMED'        // Cita confirmada por el paciente
  | 'CANCELLED'        // Cita cancelada por el paciente
  | 'MANUAL_REVIEW';   // Respuesta ambigua o mensaje no reconocido -> Requiere intervención de recepción

export interface Appointment {
  id: string;
  patient_name: string;
  patient_phone: string;            // Formato E.164 (ej: +34612345678)
  appointment_datetime: string;     // ISO 8601 o YYYY-MM-DD HH:mm
  specialist: string;               // Nombre del odontólogo o especialista
  status: AppointmentStatus;
  calendarEventId?: string;         // ID del evento en Google Calendar
  notes?: string;
  reminderSentAt?: string;
  confirmedAt?: string;
  cancelledAt?: string;
  rawSummary?: string;
}

export type ParsedIntent = 'CONFIRM' | 'CANCEL' | 'UNKNOWN';

export interface IntentClassificationResult {
  intent: ParsedIntent;
  confidence: number;
  rawText: string;
  normalizedText: string;
}

export interface IncomingWhatsAppMessage {
  from: string;                     // Teléfono del remitente (+34...)
  body: string;                     // Texto del mensaje
  messageId: string;                // ID único del mensaje para garantizar idempotencia
  provider: 'twilio' | 'meta' | 'mock';
  timestamp?: number;
}

export interface WhatsAppSendResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

export interface ReceptionAlertPayload {
  type: 'CANCELLATION' | 'MANUAL_REVIEW_NEEDED' | 'MULTIPLE_APPOINTMENTS_CONFLICT';
  appointment?: Appointment;
  patientPhone: string;
  patientName?: string;
  patientMessage: string;
  reason: string;
  timestamp: string;
}
