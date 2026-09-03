import logging
import requests
from datetime import datetime
from zoneinfo import ZoneInfo
from config import (
    CLINIC_NAME,
    WHATSAPP_PROVIDER,
    TWILIO_ACCOUNT_SID,
    TWILIO_AUTH_TOKEN,
    TWILIO_WHATSAPP_NUMBER,
    META_WHATSAPP_TOKEN,
    META_PHONE_NUMBER_ID
)
from types_models import Appointment

logger = logging.getLogger(__name__)

class WhatsAppService:
    chat_history = {}  # phone -> [{"sender": "bot"|"patient", "text": str, "time": str}]

    @classmethod
    def get_chat_history(cls, phone: str):
        clean_phone = (phone or "").strip()
        if not clean_phone.startswith("+"):
            clean_phone = f"+{clean_phone}"
        return cls.chat_history.get(clean_phone, [])

    @classmethod
    def record_message(cls, phone: str, sender: str, text: str):
        clean_phone = (phone or "").strip()
        if not clean_phone.startswith("+"):
            clean_phone = f"+{clean_phone}"
        if clean_phone not in cls.chat_history:
            cls.chat_history[clean_phone] = []
        cls.chat_history[clean_phone].append({
            "sender": sender,
            "text": text,
            "time": datetime.now(ZoneInfo("Europe/Madrid")).strftime("%H:%M")
        })

    @staticmethod
    def build_courtesy_booking_message(appointment: Appointment, formatted_date: str, formatted_time: str) -> str:
        return (
            f"Hola {appointment.patient_name}, tu cita en la *{CLINIC_NAME}* ha sido agendada correctamente "
            f"para el {formatted_date} a las {formatted_time} con {appointment.specialist} 🦷. ¡Te esperamos!"
        )

    @staticmethod
    def build_reminder_message(appointment: Appointment, formatted_date: str, formatted_time: str = None) -> str:
        if formatted_time is None:
            formatted_time = formatted_date
            formatted_date = "mañana"
        return (
            f"Hola {appointment.patient_name}, te recordamos que mañana {formatted_date} a las {formatted_time} "
            f"tienes tu cita en la *{CLINIC_NAME}* 📲.\n\n"
            f"Por favor, responde a este mensaje para gestionar tu turno:\n"
            f"1️⃣ Escribe *CONFIRMAR* para asegurar tu asistencia.\n"
            f"2️⃣ Escribe *CANCELAR* si deseas liberar el hueco."
        )

    @staticmethod
    def build_confirmation_message(patient_name: str) -> str:
        return f"¡Perfecto, {patient_name}! Tu cita en {CLINIC_NAME} queda confirmada. ¡Te esperamos!"

    @staticmethod
    def build_cancellation_message() -> str:
        return "Entendido. Hemos cancelado tu cita. Si deseas reagendar, escríbenos o llámanos. ¡Que tengas buen día!"

    @staticmethod
    def build_fallback_message() -> str:
        return f"No hemos entendido tu respuesta. Un agente de la {CLINIC_NAME} se pondrá en contacto contigo a la brevedad."

    @staticmethod
    def build_already_confirmed_message(patient_name: str) -> str:
        return f"Hola {patient_name}, tu cita en {CLINIC_NAME} ya se encontraba confirmada previamente. ¡Muchas gracias!"

    @staticmethod
    def build_already_cancelled_message() -> str:
        return "Tu cita ya había sido cancelada previamente. Para concertar una nueva cita, por favor contacta con nosotros."

    @classmethod
    def send_message(cls, to_phone: str, text: str) -> dict:
        clean_phone = (to_phone or "").strip()
        if not clean_phone.startswith("+"):
            clean_phone = f"+{clean_phone}"
        logger.info(f"Enviando WhatsApp a {clean_phone} vía {WHATSAPP_PROVIDER}")

        # Guardar mensaje en el historial del chat
        cls.record_message(clean_phone, "bot", text)

        # 1. Modo Mock (por defecto / sin coste)
        if WHATSAPP_PROVIDER == "mock" or not TWILIO_ACCOUNT_SID:
            logger.info(f"[MOCK WHATSAPP OUTBOUND to {clean_phone}]:\n{text}")
            return {"success": True, "message_id": f"mock_py_{clean_phone}"}

        # 2. Twilio
        if WHATSAPP_PROVIDER == "twilio":
            try:
                from twilio.rest import Client
                client = Client(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
                msg = client.messages.create(
                    from_=f"whatsapp:{TWILIO_WHATSAPP_NUMBER}",
                    to=f"whatsapp:{clean_phone}",
                    body=text
                )
                return {"success": True, "message_id": msg.sid}
            except Exception as e:
                logger.error(f"Error despachando Twilio WhatsApp: {e}")
                return {"success": False, "error": str(e)}

        # 3. Meta Cloud API
        if WHATSAPP_PROVIDER == "meta":
            try:
                url = f"https://graph.facebook.com/v19.0/{META_PHONE_NUMBER_ID}/messages"
                headers = {
                    "Authorization": f"Bearer {META_WHATSAPP_TOKEN}",
                    "Content-Type": "application/json"
                }
                data = {
                    "messaging_product": "whatsapp",
                    "recipient_type": "individual",
                    "to": clean_phone.replace("+", ""),
                    "type": "text",
                    "text": {"body": text}
                }
                res = requests.post(url, headers=headers, json=data, timeout=10)
                res_data = res.json()
                if res.status_code >= 400:
                    return {"success": False, "error": str(res_data)}
                return {"success": True, "message_id": res_data.get("messages", [{}])[0].get("id", "meta_sent")}
            except Exception as e:
                logger.error(f"Error despachando Meta WhatsApp: {e}")
                return {"success": False, "error": str(e)}

        return {"success": False, "error": "Proveedor no soportado"}
