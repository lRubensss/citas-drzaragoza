import os
from zoneinfo import ZoneInfo

# Cargar .env si existe
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

CLINIC_NAME = "Clínica Dental Dr. Zaragozá"
TIMEZONE_STR = os.getenv("TIMEZONE", "Europe/Madrid")
CLINIC_TIMEZONE = ZoneInfo(TIMEZONE_STR)

PORT = int(os.getenv("PORT", "3000"))
WHATSAPP_PROVIDER = os.getenv("WHATSAPP_PROVIDER", "mock")

# Twilio
TWILIO_ACCOUNT_SID = os.getenv("TWILIO_ACCOUNT_SID", "")
TWILIO_AUTH_TOKEN = os.getenv("TWILIO_AUTH_TOKEN", "")
TWILIO_WHATSAPP_NUMBER = os.getenv("TWILIO_WHATSAPP_NUMBER", "")

# Meta Cloud API
META_WHATSAPP_TOKEN = os.getenv("META_WHATSAPP_TOKEN", "")
META_PHONE_NUMBER_ID = os.getenv("META_PHONE_NUMBER_ID", "")
META_VERIFY_TOKEN = os.getenv("META_VERIFY_TOKEN", "dr_zaragoza_secret_token")

# Google Calendar
GOOGLE_CALENDAR_ID = os.getenv("GOOGLE_CALENDAR_ID", "")
GOOGLE_SERVICE_ACCOUNT_EMAIL = os.getenv("GOOGLE_SERVICE_ACCOUNT_EMAIL", "")
GOOGLE_PRIVATE_KEY = os.getenv("GOOGLE_PRIVATE_KEY", "").replace("\\n", "\n")

# Alertas
RECEPTION_ALERT_WEBHOOK_URL = os.getenv("RECEPTION_ALERT_WEBHOOK_URL", "")
RECEPTION_ALERT_EMAIL = os.getenv("RECEPTION_ALERT_EMAIL", "")

# Horas y tolerancia
REMINDER_HOURS_BEFORE = int(os.getenv("REMINDER_HOURS_BEFORE", "24"))
REMINDER_WINDOW_TOLERANCE_MINUTES = int(os.getenv("REMINDER_WINDOW_TOLERANCE_MINUTES", "30"))

# Colores Google Calendar
CALENDAR_COLORS = {
    "PENDING": "7",        # Azul
    "REMINDER_SENT": "5",  # Amarillo
    "CONFIRMED": "10",     # Verde Basil
    "CANCELLED": "11",     # Rojo Flamingo
    "MANUAL_REVIEW": "6",  # Naranja
}
