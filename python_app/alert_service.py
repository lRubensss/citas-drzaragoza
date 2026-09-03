import logging
import requests
from datetime import datetime
from zoneinfo import ZoneInfo
from typing import Optional
from config import RECEPTION_ALERT_WEBHOOK_URL, RECEPTION_ALERT_EMAIL
from types_models import Appointment

logger = logging.getLogger(__name__)

class AlertService:
    recent_alerts = []

    @classmethod
    def get_recent_alerts(cls):
        return cls.recent_alerts

    @classmethod
    def notify_reception(
        cls,
        alert_type: str,
        patient_phone: str,
        patient_message: str,
        reason: str,
        patient_name: Optional[str] = None,
        appointment: Optional[Appointment] = None
    ) -> None:
        alert_data = {
            "type": alert_type,
            "patient_name": patient_name or "Desconocido",
            "patient_phone": patient_phone,
            "patient_message": patient_message,
            "reason": reason,
            "timestamp": datetime.now(ZoneInfo("Europe/Madrid")).strftime("%H:%M:%S - %d/%m/%Y")
        }
        cls.recent_alerts.insert(0, alert_data)
        if len(cls.recent_alerts) > 50:
            cls.recent_alerts.pop()
        logger.warning(
            f"🚨 ALERTA A RECEPCIÓN DR. ZARAGOZÁ [{alert_type}] - Paciente: {patient_name or patient_phone} | "
            f"Mensaje: '{patient_message}' | Razón: {reason}"
        )

        if RECEPTION_ALERT_WEBHOOK_URL:
            try:
                payload = {
                    "title": f"[Clínica Dr. Zaragozá] {alert_type}",
                    "patient_name": patient_name or "Desconocido",
                    "patient_phone": patient_phone,
                    "patient_message": patient_message,
                    "reason": reason,
                    "appointment_details": {
                        "date_time": appointment.appointment_datetime if appointment else None,
                        "specialist": appointment.specialist if appointment else None,
                        "status": appointment.status.value if appointment else None
                    } if appointment else None
                }
                res = requests.post(RECEPTION_ALERT_WEBHOOK_URL, json=payload, timeout=5)
                if res.status_code >= 400:
                    logger.error(f"Fallo enviando alerta a webhook de recepción: {res.status_code}")
                else:
                    logger.info("Alerta de recepción entregada al webhook correctamente")
            except Exception as e:
                logger.error(f"Error de red contactando webhook de recepción: {e}")

        if RECEPTION_ALERT_EMAIL:
            logger.info(f"Despachando notificación por email a {RECEPTION_ALERT_EMAIL}")
