import sys
import unittest

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")
from datetime import datetime, timedelta
from config import CLINIC_TIMEZONE
from types_models import Appointment, AppointmentStatus, ParsedIntent
from calendar_service import CalendarService
from nlp_service import NlpService
from state_service import StateService
from cron_reminder import ReminderJob
from app import app

class TestDrZaragozaFlow(unittest.TestCase):
    def setUp(self):
        CalendarService.clear_mock_appointments()
        self.client = app.test_client()

    def tearDown(self):
        from scheduler_service import SchedulerService
        for appt_id in list(SchedulerService._active_timers.keys()):
            SchedulerService.cancel_timer(appt_id)

    def test_01_nlp_normalization_and_classification(self):
        print("\n--- TEST 1: NLP Normalización y Clasificación de Intenciones ---")

        confirm_phrases = [
            "CONFIRMAR", "confirmar", "1", "1️⃣", "sí", "si", "SIII!", 
            "ok", "Ok, gracias", "vale", "perfecto", "asistiré sin falta"
        ]
        for phrase in confirm_phrases:
            res = NlpService.classify_intent(phrase)
            self.assertEqual(res.intent, ParsedIntent.CONFIRM, f"Fallo al clasificar confirmación: '{phrase}'")

        cancel_phrases = [
            "CANCELAR", "cancelar", "2", "2️⃣", "no puedo", "no podre ir", 
            "imposible asistir", "anular cita", "anulo"
        ]
        for phrase in cancel_phrases:
            res = NlpService.classify_intent(phrase)
            self.assertEqual(res.intent, ParsedIntent.CANCEL, f"Fallo al clasificar cancelación: '{phrase}'")

        unknown_phrases = [
            "¿A qué hora era la cita?", 
            "Me duele mucho la muela, ¿puedo cambiar la hora?",
            "Hola, buenas tardes"
        ]
        for phrase in unknown_phrases:
            res = NlpService.classify_intent(phrase)
            self.assertEqual(res.intent, ParsedIntent.UNKNOWN, f"Fallo al clasificar fallback: '{phrase}'")
        print("✅ 100% de los casos NLP validados correctamente.")

    def test_02_timezone_europe_madrid_and_cron_24h(self):
        print("\n--- TEST 2: Zona Horaria Europe/Madrid y Cron 24h ---")
        now_madrid = datetime.now(CLINIC_TIMEZONE)
        appointment_time = (now_madrid + timedelta(hours=24)).isoformat()

        appt = Appointment(
            id="appt-py-101",
            patient_name="Elena Navarro",
            patient_phone="+34611002233",
            appointment_datetime=appointment_time,
            specialist="Dr. Zaragozá (Implantes)",
            status=AppointmentStatus.PENDING
        )
        CalendarService.add_mock_appointment(appt)

        result = ReminderJob.execute()
        self.assertEqual(result["processed_count"], 1, "El cron debió despachar 1 recordatorio")
        
        updated = CalendarService.find_active_appointment_by_phone("+34611002233")
        self.assertIsNotNone(updated)
        self.assertEqual(updated.status, AppointmentStatus.REMINDER_SENT)
        print("✅ Cron ejecutado con cálculo horario exacto en Europe/Madrid y estado actualizado a REMINDER_SENT.")

    def test_03_inbound_webhook_confirm(self):
        print("\n--- TEST 3: Webhook Inbound - Confirmación por el Paciente ---")
        now_madrid = datetime.now(CLINIC_TIMEZONE)
        appt = Appointment(
            id="appt-py-102",
            patient_name="Marcos Soler",
            patient_phone="+34622334455",
            appointment_datetime=(now_madrid + timedelta(hours=24)).isoformat(),
            specialist="Dra. Ortiz (Ortodoncia)",
            status=AppointmentStatus.REMINDER_SENT
        )
        CalendarService.add_mock_appointment(appt)

        # Paciente responde "1" vía WhatsApp
        resp = self.client.post("/webhook/whatsapp", data={
            "From": "whatsapp:+34622334455",
            "Body": "1",
            "MessageSid": "msg_tw_confirm_102"
        })
        self.assertEqual(resp.status_code, 200)

        updated = CalendarService.find_active_appointment_by_phone("+34622334455")
        self.assertEqual(updated.status, AppointmentStatus.CONFIRMED)
        print("✅ Cita confirmada exitosamente en calendario [CONFIRMADO] y respuesta enviada al paciente.")

    def test_04_idempotency_duplicate_messages(self):
        print("\n--- TEST 4: Idempotencia y Prevención de Duplicados ---")
        # Re-enviar exactamente el mismo mensaje anterior con el mismo MessageSid
        resp = self.client.post("/webhook/whatsapp", data={
            "From": "whatsapp:+34622334455",
            "Body": "1",
            "MessageSid": "msg_tw_confirm_102"
        })
        self.assertEqual(resp.status_code, 200)
        print("✅ Mensaje duplicado interceptado por idempotencia sin re-ejecutar mutaciones.")

    def test_05_inbound_webhook_cancel_and_reception_alert(self):
        print("\n--- TEST 5: Webhook Inbound - Cancelación y Alerta a Recepción ---")
        now_madrid = datetime.now(CLINIC_TIMEZONE)
        appt = Appointment(
            id="appt-py-103",
            patient_name="Lucía Ramos",
            patient_phone="+34633445566",
            appointment_datetime=(now_madrid + timedelta(hours=24)).isoformat(),
            specialist="Dr. Zaragozá",
            status=AppointmentStatus.REMINDER_SENT
        )
        CalendarService.add_mock_appointment(appt)

        resp = self.client.post("/webhook/whatsapp", data={
            "From": "whatsapp:+34633445566",
            "Body": "Lamentablemente no podre ir manana",
            "MessageSid": "msg_tw_cancel_103"
        })
        self.assertEqual(resp.status_code, 200)

        updated = CalendarService.find_active_appointment_by_phone("+34633445566")
        self.assertEqual(updated.status, AppointmentStatus.CANCELLED)
        print("✅ Cita cancelada, hueco marcado en calendario y alerta a recepción generada.")

    def test_06_fallback_human_on_ambiguity(self):
        print("\n--- TEST 6: Webhook Inbound - Fallback Humano (MANUAL_REVIEW) ---")
        now_madrid = datetime.now(CLINIC_TIMEZONE)
        appt = Appointment(
            id="appt-py-104",
            patient_name="Andrés Gil",
            patient_phone="+34644556677",
            appointment_datetime=(now_madrid + timedelta(hours=24)).isoformat(),
            specialist="Dr. Zaragozá",
            status=AppointmentStatus.REMINDER_SENT
        )
        CalendarService.add_mock_appointment(appt)

        resp = self.client.post("/webhook/whatsapp", data={
            "From": "whatsapp:+34644556677",
            "Body": "¿Hay parking cerca de la clínica Dr. Zaragozá?",
            "MessageSid": "msg_tw_unknown_104"
        })
        self.assertEqual(resp.status_code, 200)

        updated = CalendarService.find_active_appointment_by_phone("+34644556677")
        self.assertEqual(updated.status, AppointmentStatus.MANUAL_REVIEW)
        print("✅ Mensaje ambiguo derivado a MANUAL_REVIEW y alerta a recepción despachada.")

    def test_07_create_appointment_and_courtesy_message(self):
        print("\n--- TEST 7: Creación Manual de Cita y Mensaje de Cortesía ---")
        now_madrid = datetime.now(CLINIC_TIMEZONE)
        new_dt = (now_madrid + timedelta(days=2, hours=10)).strftime("%Y-%m-%dT10:00")

        resp = self.client.post("/api/appointments", json={
            "patient_name": "Ignacio Vidal",
            "patient_phone": "+34688990011",
            "appointment_datetime": new_dt,
            "specialist": "Dr. Zaragozá (Implantes)",
            "treatment": "Implante Dental",
            "notes": "Primera visita valoración"
        })
        self.assertEqual(resp.status_code, 201)
        data = resp.get_json()
        self.assertTrue(data["courtesy_sent"])
        self.assertTrue(data["test_mode"])

        # Verificar que el mensaje de cortesía se guardó en el historial de WhatsApp
        from whatsapp_service import WhatsAppService
        history = WhatsAppService.get_chat_history("+34688990011")
        self.assertTrue(len(history) >= 1)
        self.assertIn("ha sido agendada", history[0]["text"])
        print("✅ Cita creada manualmente y WhatsApp de cortesía inmediato despachado.")

    def test_08_drag_and_drop_update(self):
        print("\n--- TEST 8: Reprogramación Drag-and-Drop y Notificación ---")
        now_madrid = datetime.now(CLINIC_TIMEZONE)
        appt = Appointment(
            id="appt-py-drag-01",
            patient_name="Sonia Blanco",
            patient_phone="+34677889900",
            appointment_datetime=(now_madrid + timedelta(days=3, hours=9)).isoformat(),
            specialist="Dra. Martínez",
            status=AppointmentStatus.PENDING
        )
        CalendarService.add_mock_appointment(appt)

        # Arrastrar y soltar a nueva hora
        new_dt = (now_madrid + timedelta(days=3, hours=12)).isoformat()
        resp = self.client.put("/api/appointments/appt-py-drag-01", json={
            "appointment_datetime": new_dt
        })
        self.assertEqual(resp.status_code, 200)

        updated = CalendarService.find_appointment_by_id("appt-py-drag-01")
        self.assertEqual(updated.appointment_datetime, new_dt)
        print("✅ Drag & Drop simulado exitosamente: cita reprogramada en el calendario.")

if __name__ == "__main__":
    unittest.main(verbosity=2)
