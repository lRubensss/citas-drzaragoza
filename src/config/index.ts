import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
  PORT: z.coerce.number().default(3000),
  TIMEZONE: z.string().default('Europe/Madrid'),
  CRON_SCHEDULE: z.string().default('0 * * * *'),
  REMINDER_HOURS_BEFORE: z.coerce.number().default(24),
  REMINDER_WINDOW_TOLERANCE_MINUTES: z.coerce.number().default(30),

  WHATSAPP_PROVIDER: z.enum(['twilio', 'meta', 'mock']).default('mock'),

  // Twilio
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_WHATSAPP_NUMBER: z.string().optional(),

  // Meta WhatsApp Cloud API
  META_WHATSAPP_TOKEN: z.string().optional(),
  META_PHONE_NUMBER_ID: z.string().optional(),
  META_BUSINESS_ACCOUNT_ID: z.string().optional(),

  // Google Calendar
  GOOGLE_CALENDAR_ID: z.string().optional(),
  GOOGLE_SERVICE_ACCOUNT_EMAIL: z.string().optional(),
  GOOGLE_PRIVATE_KEY: z.string().optional(),
  GOOGLE_APPLICATION_CREDENTIALS: z.string().optional(),

  // Recepción Alertas
  RECEPTION_ALERT_WEBHOOK_URL: z.string().optional(),
  RECEPTION_ALERT_EMAIL: z.string().optional(),
  RECEPTION_ALERT_PHONE: z.string().optional(),
});

const parsed = configSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Error de validación de variables de entorno:', parsed.error.format());
  // No lanzamos error fatal inmediato si estamos en test o desarrollo inicial para permitir mocks
  if (process.env.NODE_ENV === 'production') {
    process.exit(1);
  }
}

export const config = parsed.success ? parsed.data : configSchema.parse({});

export const CLINIC_NAME = 'Clínica Dental Dr. Zaragozá';

// Paleta de colores para Google Calendar Event Colors
export const CALENDAR_COLORS = {
  PENDING: '7',     // Peacock (Azul claro)
  REMINDER_SENT: '5', // Yellow (Banana)
  CONFIRMED: '10',  // Basil (Verde éxito)
  CANCELLED: '11',  // Flamingo / Red o Graphite ('8')
  MANUAL_REVIEW: '6', // Tangerine (Naranja alerta)
};
