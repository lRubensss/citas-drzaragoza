import logging
import threading
import time
from datetime import datetime
from config import CLINIC_TIMEZONE
from types_models import AppointmentStatus

logger = logging.getLogger(__name__)

class SchedulerService:
    # appointment_id -> {"timer": threading.Timer, "fire_timestamp": float, "appointment_id": str}
    _active_timers = {}
    _lock = threading.RLock()

    @classmethod
    def schedule_smart_reminder(cls, appointment_id: str, is_test_mode: bool = False):
        """
        Programa de forma inteligente el recordatorio:
        - Si está en Modo Pruebas o si la cita es en <= 3 minutos -> Dispara a los 60 segundos (1 minuto exacto).
        - Si es Producción -> Se calcula exactamente a 24 horas antes del inicio de la cita.
        """
        from calendar_service import CalendarService
        appt = CalendarService.find_appointment_by_id(appointment_id)
        if not appt:
            return

        now = datetime.now(CLINIC_TIMEZONE)
        try:
            dt = datetime.fromisoformat(appt.appointment_datetime)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=CLINIC_TIMEZONE)
            else:
                dt = dt.astimezone(CLINIC_TIMEZONE)
            diff_seconds = (dt - now).total_seconds()
        except Exception:
            diff_seconds = 86400

        # Si el usuario activó Modo Pruebas O si la cita se programó para dentro de 3 minutos
        if is_test_mode or (0 < diff_seconds <= 180):
            logger.info(f"⚡ [PRUEBAS] Programando recordatorio para cita {appointment_id} a 60 segundos exactos tras creación.")
            cls.schedule_test_mode_reminder(appointment_id, delay_seconds=60)
        else:
            # Modo Producción: exactamente 24 horas antes del inicio de la cita
            seconds_until_reminder = diff_seconds - (24 * 3600)
            if seconds_until_reminder > 0:
                logger.info(f"📅 [PRODUCCIÓN] Recordatorio para cita {appointment_id} programado para dentro de {int(seconds_until_reminder)}s (24h antes).")
                if seconds_until_reminder <= 7 * 86400:
                    cls.schedule_test_mode_reminder(appointment_id, delay_seconds=int(seconds_until_reminder))
            else:
                logger.info(f"📅 [PRODUCCIÓN] Cita {appointment_id} ocurre en menos de 24h.")

    @classmethod
    def schedule_test_mode_reminder(cls, appointment_id: str, delay_seconds: int = 60):
        """
        Programa un temporizador de prueba para enviar el recordatorio tras 'delay_seconds' (por defecto 1 minuto).
        """
        from calendar_service import CalendarService
        from whatsapp_service import WhatsAppService

        with cls._lock:
            # Cancelar temporizador previo si existía
            cls.cancel_timer(appointment_id)

            def task():
                try:
                    logger.info(f"⏰ [MODO PRUEBAS] Temporizador de 1 minuto disparado para cita {appointment_id}")
                    appt = CalendarService.find_appointment_by_id(appointment_id)
                    if not appt:
                        logger.warning(f"Cita {appointment_id} no encontrada al disparar recordatorio.")
                        return

                    if appt.status != AppointmentStatus.PENDING:
                        logger.info(f"Cita {appointment_id} ya no está PENDING (estado: {appt.status}). Cancelando recordatorio.")
                        return

                    # Parsear fecha y hora para el mensaje
                    try:
                        dt = datetime.fromisoformat(appt.appointment_datetime)
                        if dt.tzinfo is None:
                            dt = dt.replace(tzinfo=CLINIC_TIMEZONE)
                        else:
                            dt = dt.astimezone(CLINIC_TIMEZONE)
                        f_date = dt.strftime("%d/%m/%Y")
                        f_time = dt.strftime("%H:%M")
                    except Exception:
                        f_date = "fecha acordada"
                        f_time = "hora acordada"

                    reminder_text = WhatsAppService.build_reminder_message(appt, f_date, f_time)
                    WhatsAppService.send_message(appt.patient_phone, reminder_text)

                    CalendarService.update_appointment_status(
                        appointment_id,
                        AppointmentStatus.REMINDER_SENT,
                        f"Recordatorio 1-minuto (Modo Pruebas) enviado a las {datetime.now(CLINIC_TIMEZONE).isoformat()}"
                    )
                    logger.info(f"✅ Recordatorio enviado exitosamente a {appt.patient_name} ({appt.patient_phone})")

                except Exception as e:
                    logger.error(f"Error ejecutando recordatorio de prueba para {appointment_id}: {e}")
                finally:
                    with cls._lock:
                        cls._active_timers.pop(appointment_id, None)

            fire_timestamp = time.time() + delay_seconds
            timer = threading.Timer(delay_seconds, task)
            timer.daemon = True
            timer.start()

            cls._active_timers[appointment_id] = {
                "timer": timer,
                "fire_timestamp": fire_timestamp,
                "appointment_id": appointment_id
            }
            logger.info(f"⏱️ Temporizador de 1 minuto programado para la cita {appointment_id} (dispara en {delay_seconds}s)")

    @classmethod
    def cancel_timer(cls, appointment_id: str):
        with cls._lock:
            existing = cls._active_timers.pop(appointment_id, None)
            if existing and existing.get("timer"):
                try:
                    existing["timer"].cancel()
                    logger.info(f"Temporizador cancelado para cita {appointment_id}")
                except Exception:
                    pass

    @classmethod
    def fire_immediately(cls, appointment_id: str) -> bool:
        """
        Dispara el recordatorio inmediatamente sin esperar a que se cumplan los 60 segundos.
        """
        cls.cancel_timer(appointment_id)
        from calendar_service import CalendarService
        from whatsapp_service import WhatsAppService

        appt = CalendarService.find_appointment_by_id(appointment_id)
        if not appt:
            return False

        try:
            dt = datetime.fromisoformat(appt.appointment_datetime)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=CLINIC_TIMEZONE)
            else:
                dt = dt.astimezone(CLINIC_TIMEZONE)
            f_date = dt.strftime("%d/%m/%Y")
            f_time = dt.strftime("%H:%M")
        except Exception:
            f_date = "fecha acordada"
            f_time = "hora acordada"

        reminder_text = WhatsAppService.build_reminder_message(appt, f_date, f_time)
        WhatsAppService.send_message(appt.patient_phone, reminder_text)
        CalendarService.update_appointment_status(
            appointment_id,
            AppointmentStatus.REMINDER_SENT,
            f"Recordatorio acelerado manualmente a las {datetime.now(CLINIC_TIMEZONE).isoformat()}"
        )
        return True

    @classmethod
    def get_remaining_seconds(cls, appointment_id: str) -> int:
        with cls._lock:
            data = cls._active_timers.get(appointment_id)
            if not data:
                return 0
            rem = int(data["fire_timestamp"] - time.time())
            return max(0, rem)

    @classmethod
    def get_all_active_timers(cls) -> dict:
        with cls._lock:
            now = time.time()
            return {
                appt_id: max(0, int(data["fire_timestamp"] - now))
                for appt_id, data in cls._active_timers.items()
            }
