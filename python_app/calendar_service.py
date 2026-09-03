import re
import logging
from datetime import datetime, timedelta
from typing import List, Optional
from config import CLINIC_TIMEZONE, GOOGLE_CALENDAR_ID, GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY, CALENDAR_COLORS
from types_models import Appointment, AppointmentStatus

logger = logging.getLogger(__name__)

class CalendarService:
    _mock_appointments: List[Appointment] = []
    _google_client = None

    @classmethod
    def get_google_client(cls):
        if cls._google_client:
            return cls._google_client
        if GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_PRIVATE_KEY:
            try:
                from google.oauth2 import service_account
                from googleapiclient.discovery import build
                creds = service_account.Credentials.from_service_account_info({
                    "client_email": GOOGLE_SERVICE_ACCOUNT_EMAIL,
                    "private_key": GOOGLE_PRIVATE_KEY,
                    "token_uri": "https://oauth2.googleapis.com/token"
                }, scopes=["https://www.googleapis.com/auth/calendar"])
                cls._google_client = build("calendar", "v3", credentials=creds)
                return cls._google_client
            except Exception as e:
                logger.error(f"Error autenticando con Google Calendar: {e}")
        return None

    @classmethod
    def get_appointments_for_reminder_window(cls, hours_ahead: int = 24, tolerance_minutes: int = 30) -> List[Appointment]:
        now_madrid = datetime.now(CLINIC_TIMEZONE)
        target = now_madrid + timedelta(hours=hours_ahead)
        window_start = target - timedelta(minutes=tolerance_minutes)
        window_end = target + timedelta(minutes=tolerance_minutes)

        client = cls.get_google_client()
        if not client or not GOOGLE_CALENDAR_ID:
            # Usar Mock Store en memoria
            results = []
            for appt in cls._mock_appointments:
                try:
                    dt = datetime.fromisoformat(appt.appointment_datetime)
                    if dt.tzinfo is None:
                        dt = dt.replace(tzinfo=CLINIC_TIMEZONE)
                    if window_start <= dt <= window_end and appt.status == AppointmentStatus.PENDING:
                        results.append(appt)
                except Exception as e:
                    logger.error(f"Error evaluando fecha de cita mock: {e}")
            return results

        # Consulta a API de Google Calendar
        try:
            events_result = client.events().list(
                calendarId=GOOGLE_CALENDAR_ID,
                timeMin=window_start.isoformat(),
                timeMax=window_end.isoformat(),
                singleEvents=True,
                orderBy="startTime"
            ).execute()
            items = events_result.get("items", [])
            appointments = []
            for item in items:
                parsed = cls._parse_google_event(item)
                if parsed and parsed.status == AppointmentStatus.PENDING:
                    appointments.append(parsed)
            return appointments
        except Exception as e:
            logger.error(f"Error listando eventos de Google Calendar: {e}")
            return []

    @classmethod
    def find_active_appointment_by_phone(cls, phone: str) -> Optional[Appointment]:
        clean_phone = phone if phone.startswith("+") else f"+{phone}"
        client = cls.get_google_client()

        if not client or not GOOGLE_CALENDAR_ID:
            matches = [a for a in cls._mock_appointments if a.patient_phone == clean_phone]
            matches.sort(key=lambda x: x.appointment_datetime)
            return matches[0] if matches else None

        now_madrid = datetime.now(CLINIC_TIMEZONE)
        try:
            events_result = client.events().list(
                calendarId=GOOGLE_CALENDAR_ID,
                timeMin=now_madrid.isoformat(),
                timeMax=(now_madrid + timedelta(days=14)).isoformat(),
                q=clean_phone,
                singleEvents=True,
                orderBy="startTime"
            ).execute()
            for item in events_result.get("items", []):
                appt = cls._parse_google_event(item)
                if appt and appt.patient_phone == clean_phone:
                    return appt
        except Exception as e:
            logger.error(f"Error buscando cita por teléfono: {e}")
        return None

    @classmethod
    def update_appointment_status(cls, appt_id: str, new_status: AppointmentStatus, note: Optional[str] = None) -> bool:
        client = cls.get_google_client()
        if not client or not GOOGLE_CALENDAR_ID:
            for appt in cls._mock_appointments:
                if appt.id == appt_id:
                    appt.status = new_status
                    if note:
                        appt.notes = f"{appt.notes or ''}\n{note}"
                    return True
            return False

        try:
            event = client.events().get(calendarId=GOOGLE_CALENDAR_ID, eventId=appt_id).execute()
            summary = event.get("summary", "")
            clean_summary = re.sub(r"^\[(CONFIRMADO|CANCELADO|RECORDATORIO ENVIADO|REVISIÓN MANUAL)\]\s*", "", summary)
            
            prefix = ""
            color_id = event.get("colorId")
            if new_status == AppointmentStatus.CONFIRMED:
                prefix = "[CONFIRMADO] "
                color_id = CALENDAR_COLORS["CONFIRMED"]
            elif new_status == AppointmentStatus.CANCELLED:
                prefix = "[CANCELADO] "
                color_id = CALENDAR_COLORS["CANCELLED"]
            elif new_status == AppointmentStatus.REMINDER_SENT:
                prefix = "[RECORDATORIO ENVIADO] "
                color_id = CALENDAR_COLORS["REMINDER_SENT"]
            elif new_status == AppointmentStatus.MANUAL_REVIEW:
                prefix = "[REVISIÓN MANUAL] "
                color_id = CALENDAR_COLORS["MANUAL_REVIEW"]

            desc = event.get("description", "")
            desc += f"\n[{datetime.now(CLINIC_TIMEZONE).strftime('%Y-%m-%d %H:%M')}] Estado: {new_status.value}"
            if note:
                desc += f" | {note}"

            client.events().patch(
                calendarId=GOOGLE_CALENDAR_ID,
                eventId=appt_id,
                body={
                    "summary": f"{prefix}{clean_summary}",
                    "colorId": color_id,
                    "description": desc
                }
            ).execute()
            return True
        except Exception as e:
            logger.error(f"Error actualizando evento en Google Calendar: {e}")
            return False

    @classmethod
    def _parse_google_event(cls, event: dict) -> Optional[Appointment]:
        event_id = event.get("id")
        start = event.get("start", {}).get("dateTime")
        if not event_id or not start:
            return None

        summary = event.get("summary", "")
        desc = event.get("description", "")

        phone_match = re.search(r"(?:Teléfono|Telefono|Phone|Tel):\s*(\+?[0-9\s-]+)", desc, re.IGNORECASE)
        patient_match = re.search(r"(?:Paciente|Patient|Nombre):\s*([^\n\r]+)", desc, re.IGNORECASE)
        specialist_match = re.search(r"(?:Especialista|Doctor|Dentista|Odontologo):\s*([^\n\r]+)", desc, re.IGNORECASE)

        if not phone_match:
            return None

        phone = re.sub(r"[\s-]", "", phone_match.group(1))
        if not phone.startswith("+"):
            phone = f"+{phone}"

        status = AppointmentStatus.PENDING
        color_id = event.get("colorId")
        if "[CONFIRMADO]" in summary or color_id == CALENDAR_COLORS["CONFIRMED"]:
            status = AppointmentStatus.CONFIRMED
        elif "[CANCELADO]" in summary or color_id == CALENDAR_COLORS["CANCELLED"]:
            status = AppointmentStatus.CANCELLED
        elif "[RECORDATORIO ENVIADO]" in summary or color_id == CALENDAR_COLORS["REMINDER_SENT"]:
            status = AppointmentStatus.REMINDER_SENT
        elif "[REVISIÓN MANUAL]" in summary or color_id == CALENDAR_COLORS["MANUAL_REVIEW"]:
            status = AppointmentStatus.MANUAL_REVIEW

        patient_name = patient_match.group(1).strip() if patient_match else re.sub(r"\[.*?\]", "", summary).strip() or "Paciente"
        specialist = specialist_match.group(1).strip() if specialist_match else "Dr. Zaragozá"

        return Appointment(
            id=event_id,
            patient_name=patient_name,
            patient_phone=phone,
            appointment_datetime=start,
            specialist=specialist,
            status=status,
            calendar_event_id=event_id,
            notes=desc,
            raw_summary=summary
        )

    @classmethod
    def get_all_appointments(cls) -> List[Appointment]:
        return cls._mock_appointments

    @classmethod
    def seed_demo_data(cls):
        if not cls._mock_appointments:
            now_madrid = datetime.now(CLINIC_TIMEZONE)
            # Cita para dentro de 24 horas (pendiente de recordatorio)
            cls.add_mock_appointment(Appointment(
                id="appt-zaragoza-001",
                patient_name="Elena Navarro",
                patient_phone="+34611223344",
                appointment_datetime=(now_madrid + timedelta(hours=24)).strftime("%Y-%m-%d 10:30"),
                specialist="Dr. Zaragozá (Implantes 🦷)",
                status=AppointmentStatus.PENDING,
                notes="Revisión implante primer cuadrante"
            ))
            # Cita para dentro de 24 horas con recordatorio ya enviado (esperando respuesta)
            cls.add_mock_appointment(Appointment(
                id="appt-zaragoza-002",
                patient_name="Carlos Ruiz",
                patient_phone="+34655443322",
                appointment_datetime=(now_madrid + timedelta(hours=24, minutes=30)).strftime("%Y-%m-%d 12:00"),
                specialist="Dra. Martínez (Ortodoncia)",
                status=AppointmentStatus.REMINDER_SENT,
                notes="Ajuste de brackets mensual"
            ))
            # Cita ya confirmada
            cls.add_mock_appointment(Appointment(
                id="appt-zaragoza-003",
                patient_name="Laura Gómez",
                patient_phone="+34699887766",
                appointment_datetime=(now_madrid + timedelta(hours=26)).strftime("%Y-%m-%d 16:00"),
                specialist="Dra. Vicente (Higiene Dental)",
                status=AppointmentStatus.CONFIRMED,
                notes="Limpieza anual y fluorización"
            ))

    @classmethod
    def find_appointment_by_id(cls, appt_id: str) -> Optional[Appointment]:
        for appt in cls._mock_appointments:
            if appt.id == appt_id:
                return appt
        return None

    @classmethod
    def create_appointment(
        cls,
        patient_name: str,
        patient_phone: str,
        appointment_datetime: str,
        specialist: str,
        treatment: str = "Revisión General",
        notes: str = ""
    ) -> Appointment:
        clean_phone = patient_phone.strip()
        if not clean_phone.startswith("+"):
            clean_phone = f"+{clean_phone}"

        import uuid
        appt_id = f"appt_{uuid.uuid4().hex[:8]}"
        now_str = datetime.now(CLINIC_TIMEZONE).isoformat()

        new_appt = Appointment(
            id=appt_id,
            patient_name=patient_name.strip(),
            patient_phone=clean_phone,
            appointment_datetime=appointment_datetime,
            specialist=specialist.strip() or "Dr. Zaragozá",
            treatment=treatment.strip() or "Revisión General",
            status=AppointmentStatus.PENDING,
            notes=notes.strip(),
            created_at=now_str
        )
        cls.add_mock_appointment(new_appt)
        logger.info(f"➕ Nueva cita creada: {new_appt.patient_name} para {new_appt.appointment_datetime}")
        return new_appt

    @classmethod
    def update_appointment_time(cls, appt_id: str, new_datetime: str) -> Optional[Appointment]:
        appt = cls.find_appointment_by_id(appt_id)
        if appt:
            old_dt = appt.appointment_datetime
            appt.appointment_datetime = new_datetime
            appt.notes = f"{appt.notes or ''}\n[Modificado de {old_dt} a {new_datetime}]"
            logger.info(f"🔄 Cita {appt_id} reprogramada a {new_datetime}")
            return appt
        return None

    @classmethod
    def delete_appointment(cls, appt_id: str) -> bool:
        initial_len = len(cls._mock_appointments)
        cls._mock_appointments = [a for a in cls._mock_appointments if a.id != appt_id]
        deleted = len(cls._mock_appointments) < initial_len
        if deleted:
            logger.info(f"🗑️ Cita {appt_id} eliminada")
        return deleted

    @classmethod
    def to_fullcalendar_events(cls) -> list:
        events = []
        # Paleta oficial doctorzaragoza.com
        status_colors = {
            AppointmentStatus.PENDING: {"bg": "#E9C46A", "border": "#D4A373", "text": "#1A202C"},
            AppointmentStatus.REMINDER_SENT: {"bg": "#005073", "border": "#0D3B66", "text": "#FFFFFF"},
            AppointmentStatus.CONFIRMED: {"bg": "#2A9D8F", "border": "#21867A", "text": "#FFFFFF"},
            AppointmentStatus.CANCELLED: {"bg": "#E76F51", "border": "#C94A29", "text": "#FFFFFF"},
            AppointmentStatus.MANUAL_REVIEW: {"bg": "#F4A261", "border": "#E76F51", "text": "#FFFFFF"}
        }

        for appt in cls._mock_appointments:
            try:
                # Calcular end time sumando 30 o 45 minutos
                dt_start = datetime.fromisoformat(appt.appointment_datetime)
                duration = getattr(appt, "duration_minutes", 30) or 30
                dt_end = dt_start + timedelta(minutes=duration)
                start_iso = dt_start.isoformat()
                end_iso = dt_end.isoformat()
            except Exception:
                start_iso = appt.appointment_datetime
                end_iso = appt.appointment_datetime

            colors = status_colors.get(appt.status, {"bg": "#6B7280", "border": "#4B5563", "text": "#FFFFFF"})

            events.append({
                "id": appt.id,
                "title": f"{appt.patient_name} ({appt.treatment or appt.specialist})",
                "start": start_iso,
                "end": end_iso,
                "backgroundColor": colors["bg"],
                "borderColor": colors["border"],
                "textColor": colors["text"],
                "extendedProps": {
                    "patient_name": appt.patient_name,
                    "patient_phone": appt.patient_phone,
                    "specialist": appt.specialist,
                    "treatment": getattr(appt, "treatment", "Consulta"),
                    "status": appt.status.value if hasattr(appt.status, "value") else appt.status,
                    "notes": appt.notes or ""
                }
            })
        return events

    @classmethod
    def add_mock_appointment(cls, appt: Appointment):
        cls._mock_appointments.append(appt)

    @classmethod
    def clear_mock_appointments(cls):
        cls._mock_appointments = []
