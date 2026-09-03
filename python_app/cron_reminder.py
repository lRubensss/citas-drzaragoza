import logging
from datetime import datetime
from config import CLINIC_TIMEZONE, REMINDER_HOURS_BEFORE, REMINDER_WINDOW_TOLERANCE_MINUTES
from calendar_service import CalendarService
from whatsapp_service import WhatsAppService
from types_models import AppointmentStatus

logger = logging.getLogger(__name__)

class ReminderJob:
    _is_running = False

    @classmethod
    def execute(cls) -> dict:
        if cls._is_running:
            logger.warning("El cron de recordatorios ya está en ejecución. Omitiendo.")
            return {"processed_count": 0, "errors": 0}

        cls._is_running = True
        processed = 0
        errors = 0

        try:
            logger.info("Iniciando escaneo de citas en ventana 24h para Clínica Dr. Zaragozá...")
            appointments = CalendarService.get_appointments_for_reminder_window(
                hours_ahead=REMINDER_HOURS_BEFORE,
                tolerance_minutes=REMINDER_WINDOW_TOLERANCE_MINUTES
            )

            logger.info(f"Citas pendientes encontradas: {len(appointments)}")

            for appt in appointments:
                try:
                    dt = datetime.fromisoformat(appt.appointment_datetime)
                    if dt.tzinfo is None:
                        dt = dt.replace(tzinfo=CLINIC_TIMEZONE)
                    else:
                        dt = dt.astimezone(CLINIC_TIMEZONE)
                    
                    formatted_time = dt.strftime("%H:%M")
                    message = WhatsAppService.build_reminder_message(appt, formatted_time)

                    res = WhatsAppService.send_message(appt.patient_phone, message)
                    if res.get("success"):
                        CalendarService.update_appointment_status(
                            appt.id,
                            AppointmentStatus.REMINDER_SENT,
                            f"Recordatorio 24h enviado exitosamente a las {datetime.now(CLINIC_TIMEZONE).isoformat()}"
                        )
                        processed += 1
                        logger.info(f"Recordatorio enviado a {appt.patient_name} ({appt.patient_phone})")
                    else:
                        errors += 1
                        logger.error(f"Fallo enviando WhatsApp a {appt.patient_phone}: {res.get('error')}")
                except Exception as e:
                    errors += 1
                    logger.error(f"Error procesando cita {appt.id}: {e}")

        except Exception as e:
            logger.error(f"Error crítico en cron de recordatorios: {e}")
        finally:
            cls._is_running = False

        return {"processed_count": processed, "errors": errors}
