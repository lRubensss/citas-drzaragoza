import { calendar_v3, google } from 'googleapis';
import { DateTime } from 'luxon';
import { CALENDAR_COLORS, config } from '../config';
import { Appointment, AppointmentStatus } from '../types/appointment';
import { logger } from '../utils/logger';

export class CalendarService {
  private static calendarClient: calendar_v3.Calendar | null = null;
  // Mock store para pruebas unitarias / desarrollo local sin API key real
  private static mockAppointments: Appointment[] = [];

  private static getCalendarClient(): calendar_v3.Calendar | null {
    if (this.calendarClient) return this.calendarClient;

    if (config.GOOGLE_SERVICE_ACCOUNT_EMAIL && config.GOOGLE_PRIVATE_KEY) {
      try {
        const auth = new google.auth.JWT({
          email: config.GOOGLE_SERVICE_ACCOUNT_EMAIL,
          key: config.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
          scopes: ['https://www.googleapis.com/auth/calendar'],
        });
        this.calendarClient = google.calendar({ version: 'v3', auth });
        logger.info('Cliente de Google Calendar autenticado con Service Account');
        return this.calendarClient;
      } catch (err: any) {
        logger.error({ err: err.message }, 'Error autenticando con Google Calendar');
        return null;
      }
    }

    return null;
  }

  /**
   * Helper para sanitizar y extraer metadatos de un evento de Google Calendar
   */
  private static parseEventToAppointment(event: calendar_v3.Schema$Event): Appointment | null {
    if (!event.id || !event.start?.dateTime) return null;

    const description = event.description || '';
    const summary = event.summary || '';

    // Extraer campos estructurados de la descripción o extendedProperties
    // Formato sugerido en descripción:
    // Paciente: Juan Pérez
    // Teléfono: +34612345678
    // Especialista: Dr. Zaragozá
    // Estado: PENDING
    const phoneMatch = description.match(/(?:Teléfono|Telefono|Phone|Tel):\s*(\+?[0-9\s-]+)/i);
    const patientMatch = description.match(/(?:Paciente|Patient|Nombre):\s*([^\n\r]+)/i);
    const specialistMatch = description.match(/(?:Especialista|Doctor|Dentista|Odontologo):\s*([^\n\r]+)/i);
    const statusMatch = description.match(/(?:Estado|Status):\s*([A-Z_]+)/i);

    let status: AppointmentStatus = 'PENDING';
    if (summary.includes('[CONFIRMADO]') || event.colorId === CALENDAR_COLORS.CONFIRMED) {
      status = 'CONFIRMED';
    } else if (summary.includes('[CANCELADO]') || event.colorId === CALENDAR_COLORS.CANCELLED) {
      status = 'CANCELLED';
    } else if (summary.includes('[RECORDATORIO ENVIADO]') || event.colorId === CALENDAR_COLORS.REMINDER_SENT) {
      status = 'REMINDER_SENT';
    } else if (summary.includes('[REVISIÓN MANUAL]') || event.colorId === CALENDAR_COLORS.MANUAL_REVIEW) {
      status = 'MANUAL_REVIEW';
    } else if (statusMatch && ['PENDING', 'REMINDER_SENT', 'CONFIRMED', 'CANCELLED', 'MANUAL_REVIEW'].includes(statusMatch[1])) {
      status = statusMatch[1] as AppointmentStatus;
    }

    // Teléfono: normalizar a formato E.164
    let rawPhone = phoneMatch ? phoneMatch[1].replace(/[\s-]/g, '') : '';
    if (rawPhone && !rawPhone.startsWith('+')) {
      rawPhone = `+${rawPhone}`;
    }

    if (!rawPhone) {
      // Si el evento no tiene teléfono de contacto registrado, no se puede enviar WhatsApp
      return null;
    }

    const patientName = patientMatch ? patientMatch[1].trim() : summary.replace(/\[.*?\]/g, '').trim() || 'Paciente';
    const specialist = specialistMatch ? specialistMatch[1].trim() : 'Dr. Zaragozá';

    // Fecha en timezone Europe/Madrid
    const apptDate = DateTime.fromISO(event.start.dateTime, { zone: config.TIMEZONE }).toISO() || event.start.dateTime;

    return {
      id: event.id,
      patient_name: patientName,
      patient_phone: rawPhone,
      appointment_datetime: apptDate,
      specialist,
      status,
      calendarEventId: event.id,
      notes: description,
      rawSummary: summary,
    };
  }

  /**
   * Obtiene las citas pendientes que ocurrirán en la ventana exacta de 24 horas
   * considerando estrictamente la zona horaria 'Europe/Madrid'.
   */
  public static async getAppointmentsForReminderWindow(
    targetHoursAhead = config.REMINDER_HOURS_BEFORE,
    toleranceMinutes = config.REMINDER_WINDOW_TOLERANCE_MINUTES
  ): Promise<Appointment[]> {
    const nowInMadrid = DateTime.now().setZone(config.TIMEZONE);

    // Ventana temporal objetivo: now + targetHoursAhead +/- toleranceMinutes
    const targetTime = nowInMadrid.plus({ hours: targetHoursAhead });
    const windowStart = targetTime.minus({ minutes: toleranceMinutes });
    const windowEnd = targetTime.plus({ minutes: toleranceMinutes });

    logger.info(
      {
        now: nowInMadrid.toISO(),
        windowStart: windowStart.toISO(),
        windowEnd: windowEnd.toISO(),
        timezone: config.TIMEZONE,
      },
      `Buscando citas en la ventana de recordatorio (~${targetHoursAhead}h antes)`
    );

    const client = this.getCalendarClient();

    // 1. Si no hay conexión real a Google Calendar, usar Mock Store
    if (!client || !config.GOOGLE_CALENDAR_ID) {
      logger.warn('Google Calendar no configurado. Consultando citas desde Mock Store en memoria.');
      return this.mockAppointments.filter((appt) => {
        const apptDate = DateTime.fromISO(appt.appointment_datetime, { zone: config.TIMEZONE });
        const inWindow = apptDate >= windowStart && apptDate <= windowEnd;
        return inWindow && appt.status === 'PENDING';
      });
    }

    // 2. Consulta a Google Calendar API
    try {
      const res = await client.events.list({
        calendarId: config.GOOGLE_CALENDAR_ID,
        timeMin: windowStart.toISO()!,
        timeMax: windowEnd.toISO()!,
        singleEvents: true,
        orderBy: 'startTime',
      });

      const events = res.data.items || [];
      const appointments: Appointment[] = [];

      for (const event of events) {
        const appt = this.parseEventToAppointment(event);
        if (appt && appt.status === 'PENDING') {
          appointments.push(appt);
        }
      }

      logger.info({ count: appointments.length }, 'Citas pendientes encontradas para recordatorio');
      return appointments;
    } catch (err: any) {
      logger.error({ err: err.message }, 'Error listando eventos de Google Calendar');
      return [];
    }
  }

  /**
   * Busca la cita activa más próxima asociada a un número de teléfono de paciente.
   */
  public static async findActiveAppointmentByPhone(phone: string): Promise<Appointment | null> {
    const cleanPhone = phone.startsWith('+') ? phone : `+${phone}`;
    const nowInMadrid = DateTime.now().setZone(config.TIMEZONE);

    logger.info({ phone: cleanPhone }, 'Buscando cita activa para el paciente');

    const client = this.getCalendarClient();

    // 1. MOCK STORE
    if (!client || !config.GOOGLE_CALENDAR_ID) {
      const matches = this.mockAppointments
        .filter((a) => a.patient_phone === cleanPhone)
        .sort((a, b) => (a.appointment_datetime > b.appointment_datetime ? 1 : -1));
      return matches[0] || null;
    }

    // 2. GOOGLE CALENDAR
    try {
      // Buscar citas desde ahora hasta 14 días en el futuro
      const res = await client.events.list({
        calendarId: config.GOOGLE_CALENDAR_ID,
        timeMin: nowInMadrid.toISO()!,
        timeMax: nowInMadrid.plus({ days: 14 }).toISO()!,
        q: cleanPhone, // Búsqueda textual del teléfono en summary o description
        singleEvents: true,
        orderBy: 'startTime',
      });

      const events = res.data.items || [];
      for (const event of events) {
        const appt = this.parseEventToAppointment(event);
        if (appt && appt.patient_phone === cleanPhone) {
          return appt;
        }
      }

      return null;
    } catch (err: any) {
      logger.error({ err: err.message, phone: cleanPhone }, 'Error buscando cita en Google Calendar');
      return null;
    }
  }

  /**
   * Actualiza el estado de una cita tanto en metadatos como en el evento de Google Calendar
   * (cambia color a verde/rojo y añade prefijo identificativo en el título).
   */
  public static async updateAppointmentStatus(
    appointmentId: string,
    newStatus: AppointmentStatus,
    extraNotes?: string
  ): Promise<boolean> {
    logger.info({ appointmentId, newStatus }, 'Actualizando estado de la cita');

    const client = this.getCalendarClient();

    // 1. MOCK STORE
    if (!client || !config.GOOGLE_CALENDAR_ID) {
      const appt = this.mockAppointments.find((a) => a.id === appointmentId);
      if (appt) {
        appt.status = newStatus;
        if (extraNotes) appt.notes = (appt.notes || '') + '\n' + extraNotes;
        logger.info({ id: appt.id, status: appt.status }, 'Cita en Mock Store actualizada');
        return true;
      }
      return false;
    }

    // 2. GOOGLE CALENDAR UPDATE
    try {
      const eventRes = await client.events.get({
        calendarId: config.GOOGLE_CALENDAR_ID,
        eventId: appointmentId,
      });

      const event = eventRes.data;
      if (!event) return false;

      // Limpiar prefijos existentes
      let cleanSummary = (event.summary || '')
        .replace(/^\[(CONFIRMADO|CANCELADO|RECORDATORIO ENVIADO|REVISIÓN MANUAL)\]\s*/i, '')
        .trim();

      let prefix = '';
      let colorId = event.colorId;

      switch (newStatus) {
        case 'CONFIRMED':
          prefix = '[CONFIRMADO] ';
          colorId = CALENDAR_COLORS.CONFIRMED; // Verde Basil
          break;
        case 'CANCELLED':
          prefix = '[CANCELADO] ';
          colorId = CALENDAR_COLORS.CANCELLED; // Rojo Flamingo
          break;
        case 'REMINDER_SENT':
          prefix = '[RECORDATORIO ENVIADO] ';
          colorId = CALENDAR_COLORS.REMINDER_SENT;
          break;
        case 'MANUAL_REVIEW':
          prefix = '[REVISIÓN MANUAL] ';
          colorId = CALENDAR_COLORS.MANUAL_REVIEW;
          break;
      }

      const updatedSummary = `${prefix}${cleanSummary}`;
      let updatedDesc = event.description || '';
      updatedDesc += `\n[${DateTime.now().setZone(config.TIMEZONE).toFormat('yyyy-MM-dd HH:mm')}] Estado actualizado a: ${newStatus}`;
      if (extraNotes) {
        updatedDesc += ` | ${extraNotes}`;
      }

      await client.events.patch({
        calendarId: config.GOOGLE_CALENDAR_ID,
        eventId: appointmentId,
        requestBody: {
          summary: updatedSummary,
          colorId,
          description: updatedDesc,
        },
      });

      logger.info({ appointmentId, newStatus, updatedSummary }, 'Evento en Google Calendar actualizado exitosamente');
      return true;
    } catch (err: any) {
      logger.error({ err: err.message, appointmentId }, 'Error actualizando evento en Google Calendar');
      return false;
    }
  }

  /**
   * Helper para poblar citas de prueba en el Mock Store (usado para tests)
   */
  public static addMockAppointment(appointment: Appointment): void {
    const existingIdx = this.mockAppointments.findIndex((a) => a.id === appointment.id);
    if (existingIdx >= 0) {
      this.mockAppointments[existingIdx] = appointment;
    } else {
      this.mockAppointments.push(appointment);
    }
  }

  public static getMockAppointments(): Appointment[] {
    return this.mockAppointments;
  }

  public static clearMockAppointments(): void {
    this.mockAppointments = [];
  }
}
