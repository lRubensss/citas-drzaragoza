import express, { Request, Response } from 'express';
import { CLINIC_NAME, config } from './config';
import { WebhookController } from './controllers/webhook.controller';
import { ReminderJob } from './jobs/reminder.cron';
import { logger } from './utils/logger';

const app = express();

// Parsear tanto application/json como application/x-www-form-urlencoded (requerido por Twilio)
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 1. Health check & Info
app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'online',
    clinic: CLINIC_NAME,
    timezone: config.TIMEZONE,
    timestamp: new Date().toISOString(),
    whatsappProvider: config.WHATSAPP_PROVIDER,
  });
});

// 2. Webhooks de WhatsApp (Inbound)
app.post('/webhook/whatsapp', WebhookController.handleInboundMessage);
app.get('/webhook/whatsapp', WebhookController.verifyMetaWebhook);

// 3. Endpoint manual para disparar el Cron de recordatorios bajo demanda
app.post('/api/cron/trigger-reminders', async (_req: Request, res: Response) => {
  logger.info('Disparo manual de escaneo de citas 24h recibido vía API');
  const result = await ReminderJob.execute();
  res.json({
    status: 'completed',
    ...result,
  });
});

// 4. Iniciar servidor
const port = config.PORT;
const server = app.listen(port, () => {
  logger.info(`=======================================================`);
  logger.info(`🦷 Sistema de Citas WhatsApp - ${CLINIC_NAME}`);
  logger.info(`🚀 Servidor ejecutándose en http://localhost:${port}`);
  logger.info(`⏰ Zona Horaria Activa: ${config.TIMEZONE}`);
  logger.info(`📲 Proveedor de WhatsApp: ${config.WHATSAPP_PROVIDER}`);
  logger.info(`=======================================================`);

  // Programar ejecución periódica del cron de recordatorios (cada hora por defecto)
  const cronIntervalMs = 60 * 60 * 1000; // 1 hora
  setInterval(() => {
    ReminderJob.execute().catch((err) => {
      logger.error({ err: err.message }, 'Error no capturado en ejecución de cron programado');
    });
  }, cronIntervalMs);

  logger.info(`Tarea periódica de recordatorios 24h activada (frecuencia: cada 60 min)`);
});

// Manejo de apagado elegante
process.on('SIGTERM', () => {
  logger.info('Señal SIGTERM recibida. Cerrando servidor HTTP...');
  server.close(() => {
    logger.info('Servidor finalizado limpiamente.');
    process.exit(0);
  });
});

export { app, server };
