from dataclasses import dataclass, field
from enum import Enum
from typing import Optional

class AppointmentStatus(str, Enum):
    PENDING = "PENDING"
    REMINDER_SENT = "REMINDER_SENT"
    CONFIRMED = "CONFIRMED"
    CANCELLED = "CANCELLED"
    MANUAL_REVIEW = "MANUAL_REVIEW"

class ParsedIntent(str, Enum):
    CONFIRM = "CONFIRM"
    CANCEL = "CANCEL"
    UNKNOWN = "UNKNOWN"

@dataclass
class Appointment:
    id: str
    patient_name: str
    patient_phone: str          # Formato E.164 (+34...)
    appointment_datetime: str   # ISO 8601 o YYYY-MM-DD HH:mm
    specialist: str             # Especialista o Dr. Zaragozá
    treatment: Optional[str] = "Revisión General"
    duration_minutes: int = 30
    status: AppointmentStatus = AppointmentStatus.PENDING
    calendar_event_id: Optional[str] = None
    notes: Optional[str] = None
    raw_summary: Optional[str] = None
    created_at: Optional[str] = None

@dataclass
class IntentClassificationResult:
    intent: ParsedIntent
    confidence: float
    raw_text: str
    normalized_text: str

@dataclass
class IncomingWhatsAppMessage:
    from_phone: str
    body: str
    message_id: str
    provider: str = "twilio"
    timestamp: Optional[float] = None
