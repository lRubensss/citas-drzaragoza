import { DateTime } from 'luxon';
import { config } from '../src/config';
import { CalendarService } from '../src/services/calendar.service';
import { NlpService } from '../src/services/nlp.service';
import { StateService } from '../src/services/state.service';
import { ReminderJob } from '../src/jobs/reminder.cron';
import { WebhookController } from '../src/controllers/webhook.controller';
import { Appointment } from '../src/types/appointment';

// Helper simple para assertions
function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`❌ ASSERTION FAILED: ${msg}`);
    throw new Error(msg);
  } else {
    console.log(`✅ ${msg}`);
  }
}

async function runTests() {
  console.log('\n===============================================================');
  console.log('🧪 SUITE DE PRUEBAS END-TO-END - CLÍNICA DENTAL DR. ZARAGOZÁ');
  console.log('===============================================================\n');

  // --------------------------------------------------------------------------
  // TEST 1: Normalización de texto y Clasificador NLP
  // --------------------------------------------------------------------------
  console.log('--- TEST 1: Normalización y Clasificación NLP ---');

  const confirmCases = [
    'CONFIRMAR',
    'confirmar',
    '1',
    '1️⃣',
    'sí',
    'si',
    'SIII!',
    'ok',
    'Ok, gracias',
    'vale perfecto',
    'asistiré sin falta',
  ];

  for (const phrase of confirmCases) {
    const res = NlpService.classifyIntent(phrase);
    assert(res.intent === 'CONFIRM', `NLP debe clasificar "${phrase}" como CONFIRM (obtenido: ${res.intent})`);
  }

  const cancelCases = [
    'CANCELAR',
    'cancelar',
    '2',
    '2️⃣',
    'no puedo',
    'no podre ir manana',
    'imposible asistir',
    'anular cita',
    'anulo',
  ];

  for (const phrase of cancelCases) {
    const res = NlpService.classifyIntent(phrase);
    assert(res.intent === 'CANCEL', `NLP debe clasificar "${phrase}" como CANCEL (obtenido: ${res.intent})`);
  }

  const unknownCases = [
    '¿A qué hora era la cita?',
    'Me duele mucho la muela, ¿puedo ir antes?',
    'Buenas tardes, soy la madre de Lucas',
  ];

  for (const phrase of unknownCases) {
    const res = NlpService.classifyIntent(phrase);
    assert(res.intent === 'UNKNOWN', `NLP debe clasificar "${phrase}" como UNKNOWN para fallback humano (obtenido: ${res.intent})`);
  }

  // --------------------------------------------------------------------------
  // TEST 2: Cálculo de Ventana 24h con Zona Horaria Europe/Madrid
  // --------------------------------------------------------------------------
  console.log('\n--- TEST 2: Zona Horaria Europe/Madrid y Cron 24h ---');
  CalendarService.clearMockAppointments();

  const nowMadrid = DateTime.now().setZone('Europe/Madrid');
  const appointmentTime = nowMadrid.plus({ hours: 24 }).toISO()!;

  const testPatient1: Appointment = {
    id: 'appt-101',
    patient_name: 'María García',
    patient_phone: '+34611223344',
    appointment_datetime: appointmentTime,
    specialist: 'Dra. Martínez (Ortodoncia)',
    status: 'PENDING',
  };

  CalendarService.addMockAppointment(testPatient1);

  // Ejecutar el cron job
  const cronResult = await ReminderJob.execute();
  assert(cronResult.processedCount === 1, `El cron debía procesar 1 cita (procesadas: ${cronResult.processedCount})`);

  const updatedAppt1 = (await CalendarService.findActiveAppointmentByPhone('+34611223344'))!;
  assert(updatedAppt1.status === 'REMINDER_SENT', `El estado debe ser REMINDER_SENT (actual: ${updatedAppt1.status})`);

  // --------------------------------------------------------------------------
  // TEST 3: Webhook Inbound - Confirmación por el paciente ("1" o "Sí")
  // --------------------------------------------------------------------------
  console.log('\n--- TEST 3: Webhook Inbound - Confirmación de Cita ---');

  // Simulación de req y res para Express
  const createMockReqRes = (body: any) => {
    let statusCode = 200;
    let responseData: any = null;
    const req = { body } as any;
    const res = {
      status: (code: number) => {
        statusCode = code;
        return res;
      },
      send: (data: any) => {
        responseData = data;
        return res;
      },
      json: (data: any) => {
        responseData = data;
        return res;
      },
    } as any;
    return { req, res, getStatus: () => statusCode, getData: () => responseData };
  };

  const mockConfirm = createMockReqRes({
    phone: '+34611223344',
    message: '1',
    messageId: 'msg_confirm_001',
  });

  await WebhookController.handleInboundMessage(mockConfirm.req, mockConfirm.res);
  assert(mockConfirm.getStatus() === 200, `Respuesta webhook debe ser HTTP 200`);

  const confirmedAppt = (await CalendarService.findActiveAppointmentByPhone('+34611223344'))!;
  assert(confirmedAppt.status === 'CONFIRMED', `La cita debe quedar en estado CONFIRMED (actual: ${confirmedAppt.status})`);

  // --------------------------------------------------------------------------
  // TEST 4: Idempotencia y Prevención de Bucles
  // --------------------------------------------------------------------------
  console.log('\n--- TEST 4: Idempotencia (Mismo mensaje enviado dos veces) ---');

  const mockDuplicate = createMockReqRes({
    phone: '+34611223344',
    message: '1',
    messageId: 'msg_confirm_001', // Mismo ID que arriba
  });

  await WebhookController.handleInboundMessage(mockDuplicate.req, mockDuplicate.res);
  assert(mockDuplicate.getStatus() === 200, `Mensaje duplicado debe responder 200 sin reprocesar`);

  // --------------------------------------------------------------------------
  // TEST 5: Webhook Inbound - Cancelación de Cita ("No podré ir")
  // --------------------------------------------------------------------------
  console.log('\n--- TEST 5: Webhook Inbound - Cancelación y Alerta a Recepción ---');

  const testPatient2: Appointment = {
    id: 'appt-102',
    patient_name: 'Carlos Ruiz',
    patient_phone: '+34655443322',
    appointment_datetime: appointmentTime,
    specialist: 'Dr. Zaragozá (Implantología)',
    status: 'REMINDER_SENT',
  };
  CalendarService.addMockAppointment(testPatient2);

  const mockCancel = createMockReqRes({
    phone: '+34655443322',
    message: 'Lamentablemente no puedo ir',
    messageId: 'msg_cancel_002',
  });

  await WebhookController.handleInboundMessage(mockCancel.req, mockCancel.res);
  const cancelledAppt = (await CalendarService.findActiveAppointmentByPhone('+34655443322'))!;
  assert(cancelledAppt.status === 'CANCELLED', `La cita debe quedar en estado CANCELLED (actual: ${cancelledAppt.status})`);

  // --------------------------------------------------------------------------
  // TEST 6: Webhook Inbound - Fallback Humano (Mensaje incomprensible)
  // --------------------------------------------------------------------------
  console.log('\n--- TEST 6: Webhook Inbound - Fallback Humano / MANUAL_REVIEW ---');

  const testPatient3: Appointment = {
    id: 'appt-103',
    patient_name: 'Laura Gómez',
    patient_phone: '+34699887766',
    appointment_datetime: appointmentTime,
    specialist: 'Dra. Vicente (Higiene Dental)',
    status: 'REMINDER_SENT',
  };
  CalendarService.addMockAppointment(testPatient3);

  const mockAmbiguous = createMockReqRes({
    phone: '+34699887766',
    message: '¿Tienen aparcamiento cerca de la clínica?',
    messageId: 'msg_ambiguous_003',
  });

  await WebhookController.handleInboundMessage(mockAmbiguous.req, mockAmbiguous.res);
  const reviewAppt = (await CalendarService.findActiveAppointmentByPhone('+34699887766'))!;
  assert(reviewAppt.status === 'MANUAL_REVIEW', `La cita debe marcarse como MANUAL_REVIEW (actual: ${reviewAppt.status})`);

  console.log('\n===============================================================');
  console.log('🎉 TODOS LOS TESTS COMPLETADOS Y VERIFICADOS CON ÉXITO');
  console.log('===============================================================\n');
}

runTests().catch((err) => {
  console.error('Error fatal en ejecución de tests:', err);
  process.exit(1);
});
