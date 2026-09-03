import logging
from datetime import datetime
from flask import Flask, request, jsonify, Response, render_template
from config import CLINIC_NAME, CLINIC_TIMEZONE, PORT, WHATSAPP_PROVIDER, META_VERIFY_TOKEN
from types_models import IncomingWhatsAppMessage, AppointmentStatus, ParsedIntent
from calendar_service import CalendarService
from nlp_service import NlpService
from state_service import StateService
from alert_service import AlertService
from whatsapp_service import WhatsAppService
from cron_reminder import ReminderJob

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger(__name__)

app = Flask(__name__)

# Manejador global de excepciones para evitar caídas del servidor y 500 no controlados
@app.errorhandler(Exception)
def handle_global_exception(e):
    logger.error(f"🚨 Error no controlado capturado por el servidor: {e}", exc_info=True)
    return jsonify({
        "status": "error",
        "message": "Se produjo un error interno controlado en el servidor",
        "error": str(e)
    }), 500

def parse_incoming_request() -> IncomingWhatsAppMessage | None:
    # 1. Twilio format (form urlencoded)
    if request.form:
        from_phone = request.form.get("From", "").replace("whatsapp:", "").strip()
        body = request.form.get("Body", "").strip()
        msg_id = request.form.get("MessageSid", f"tw_{int(datetime.now().timestamp())}")
        return IncomingWhatsAppMessage(from_phone=from_phone, body=body, message_id=msg_id, provider="twilio")

    # 2. Meta Cloud API format (JSON)
    json_data = request.get_json(silent=True)
    if json_data and "entry" in json_data:
        try:
            msg = json_data["entry"][0]["changes"][0]["value"]["messages"][0]
            from_phone = f"+{msg['from']}"
            body = msg.get("text", {}).get("body", "")
            if not body and "button" in msg:
                body = msg["button"].get("text", "")
            msg_id = msg.get("id", f"meta_{int(datetime.now().timestamp())}")
            return IncomingWhatsAppMessage(from_phone=from_phone, body=body, message_id=msg_id, provider="meta")
        except Exception:
            pass

    # 3. Formato JSON directo (simulación / tests)
    if json_data and "phone" in json_data and "message" in json_data:
        return IncomingWhatsAppMessage(
            from_phone=json_data["phone"],
            body=json_data["message"],
            message_id=json_data.get("messageId", f"dir_{int(datetime.now().timestamp())}"),
            provider="mock"
        )

    return None

from scheduler_service import SchedulerService

# MODO PRUEBAS (1 MINUTO) - Por defecto activado para pruebas inmediatas
TEST_MODE = True

CalendarService.seed_demo_data()

@app.route("/", methods=["GET"])
def index():
    return render_template("index.html")

@app.route("/api/settings", methods=["GET"])
def get_settings():
    return jsonify({
        "test_mode": TEST_MODE,
        "clinic_name": CLINIC_NAME,
        "timezone": str(CLINIC_TIMEZONE),
        "active_timers": SchedulerService.get_all_active_timers()
    })

@app.route("/api/settings/test-mode", methods=["POST"])
def toggle_test_mode():
    global TEST_MODE
    data = request.get_json(silent=True) or {}
    if "test_mode" in data:
        TEST_MODE = bool(data["test_mode"])
    else:
        TEST_MODE = not TEST_MODE
    logger.info(f"🔄 Modo de Pruebas (1 minuto) establecido en: {TEST_MODE}")
    return jsonify({"test_mode": TEST_MODE, "message": f"Modo de pruebas {'activado' if TEST_MODE else 'desactivado'}"})

@app.route("/api/appointments", methods=["GET"])
def get_appointments():
    appts = CalendarService.get_all_appointments()
    timers = SchedulerService.get_all_active_timers()
    return jsonify([{
        "id": a.id,
        "patient_name": a.patient_name,
        "patient_phone": a.patient_phone,
        "appointment_datetime": a.appointment_datetime,
        "specialist": a.specialist,
        "treatment": getattr(a, "treatment", "Revisión General"),
        "status": a.status.value if hasattr(a.status, 'value') else a.status,
        "notes": a.notes,
        "remaining_seconds": timers.get(a.id, 0)
    } for a in appts])

@app.route("/api/appointments/calendar", methods=["GET"])
def get_calendar_events():
    """Retorna las citas formateadas para FullCalendar con los colores de doctorzaragoza.com"""
    events = CalendarService.to_fullcalendar_events()
    return jsonify(events)

@app.route("/api/appointments", methods=["POST"])
def create_appointment_endpoint():
    """
    Crea una nueva cita desde el calendario manual.
    Dispara el WhatsApp de cortesía inmediato (Mensaje 1) y programa el recordatorio (Mensaje 2).
    Si WhatsApp o la red fallan, la cita se conserva en el calendario igualmente y no produce error 500.
    """
    try:
        data = request.get_json(silent=True) or request.form.to_dict() or {}
        patient_name = data.get("patient_name", "").strip()
        patient_phone = data.get("patient_phone", "").strip()
        appointment_datetime = data.get("appointment_datetime", "").strip()
        specialist = data.get("specialist", "Dr. Zaragozá").strip()
        treatment = data.get("treatment", "Revisión General").strip()
        notes = data.get("notes", "").strip()

        if not patient_name or not patient_phone or not appointment_datetime:
            return jsonify({"error": "Faltan campos obligatorios (nombre, teléfono, fecha/hora)", "status": "fail"}), 400

        # 1. Guardar cita en calendario primero (Persistencia garantizada)
        new_appt = CalendarService.create_appointment(
            patient_name=patient_name,
            patient_phone=patient_phone,
            appointment_datetime=appointment_datetime,
            specialist=specialist,
            treatment=treatment,
            notes=notes
        )

        courtesy_sent = False
        whatsapp_error = None

        # 2. DISPARO INMEDIATO: Mensaje 1 de Confirmación de Agendamiento al paciente
        try:
            dt = datetime.fromisoformat(new_appt.appointment_datetime)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=CLINIC_TIMEZONE)
            else:
                dt = dt.astimezone(CLINIC_TIMEZONE)
            f_date = dt.strftime("%d/%m/%Y")
            f_time = dt.strftime("%H:%M")

            courtesy_msg = WhatsAppService.build_courtesy_booking_message(new_appt, f_date, f_time)
            send_res = WhatsAppService.send_message(new_appt.patient_phone, courtesy_msg)
            courtesy_sent = send_res.get("success", False)
            if courtesy_sent:
                logger.info(f"📲 Mensaje 1 (Cortesía agendamiento) enviado a {new_appt.patient_name} ({new_appt.patient_phone})")
            else:
                whatsapp_error = send_res.get("error", "Error desconocido de envío")
                logger.warn(f"WhatsApp no pudo entregarse a {new_appt.patient_phone}: {whatsapp_error}")
        except Exception as wa_err:
            whatsapp_error = str(wa_err)
            logger.error(f"Excepción controlada al enviar WhatsApp de cortesía: {wa_err}")

        # 3. PROGRAMACIÓN DE MENSAJE 2 (Recordatorio de Cita): 1 minuto en pruebas o 24h antes
        try:
            SchedulerService.schedule_smart_reminder(new_appt.id, is_test_mode=TEST_MODE)
        except Exception as sch_err:
            logger.error(f"Excepción controlada al programar recordatorio para {new_appt.id}: {sch_err}")

        return jsonify({
            "status": "created",
            "message": "Cita guardada en el calendario exitosamente",
            "appointment": {
                "id": new_appt.id,
                "patient_name": new_appt.patient_name,
                "patient_phone": new_appt.patient_phone,
                "appointment_datetime": new_appt.appointment_datetime,
                "specialist": new_appt.specialist,
                "treatment": new_appt.treatment,
                "status": new_appt.status.value if hasattr(new_appt.status, "value") else new_appt.status
            },
            "test_mode": TEST_MODE,
            "courtesy_sent": courtesy_sent,
            "whatsapp_warning": whatsapp_error
        }), 201

    except Exception as e:
        logger.error(f"Error crítico al procesar creación de cita: {e}", exc_info=True)
        return jsonify({
            "status": "fail",
            "error": f"No se pudo completar la creación de la cita: {str(e)}"
        }), 400

@app.route("/api/appointments/<appt_id>", methods=["PUT"])
def update_appointment_endpoint(appt_id):
    """
    Actualiza la fecha y hora de la cita (usado por Drag & Drop en FullCalendar).
    """
    try:
        data = request.get_json(silent=True) or request.form.to_dict() or {}
        new_datetime = data.get("appointment_datetime")

        if not new_datetime:
            return jsonify({"error": "appointment_datetime es requerido"}), 400

        updated = CalendarService.update_appointment_time(appt_id, new_datetime)
        if not updated:
            return jsonify({"error": "Cita no encontrada"}), 404

        # Si se reprograma en modo pruebas, reprogramar recordatorio a 1 minuto
        try:
            if TEST_MODE and updated.status == AppointmentStatus.PENDING:
                SchedulerService.schedule_smart_reminder(appt_id, is_test_mode=TEST_MODE)
        except Exception as timer_err:
            logger.error(f"Error reprogramando temporizador: {timer_err}")

        # Notificar al paciente del cambio (si falla WhatsApp, no afecta la reprogramación)
        try:
            dt = datetime.fromisoformat(updated.appointment_datetime)
            f_date = dt.strftime("%d/%m/%Y")
            f_time = dt.strftime("%H:%M")
            msg = f"Hola {updated.patient_name}, te informamos que tu cita en la *{CLINIC_NAME}* ha sido reprogramada para el {f_date} a las {f_time} 🦷."
            WhatsAppService.send_message(updated.patient_phone, msg)
        except Exception as e:
            logger.error(f"Error notificando reprogramación: {e}")

        return jsonify({"status": "updated", "appointment_id": appt_id, "new_datetime": new_datetime})
    except Exception as e:
        logger.error(f"Error al actualizar cita {appt_id}: {e}", exc_info=True)
        return jsonify({"error": f"Error al actualizar cita: {str(e)}", "status": "fail"}), 400

@app.route("/api/appointments/<appt_id>", methods=["DELETE"])
def delete_appointment_endpoint(appt_id):
    """
    Elimina una cita del calendario manual.
    """
    try:
        SchedulerService.cancel_timer(appt_id)
        deleted = CalendarService.delete_appointment(appt_id)
        if deleted:
            return jsonify({"status": "deleted", "appointment_id": appt_id})
        return jsonify({"error": "Cita no encontrada"}), 404
    except Exception as e:
        logger.error(f"Error al eliminar cita {appt_id}: {e}", exc_info=True)
        return jsonify({"error": f"Error al eliminar cita: {str(e)}", "status": "fail"}), 400

@app.route("/api/test/fire-reminder/<appt_id>", methods=["POST"])
def fire_reminder_now(appt_id):
    """
    Acelera el recordatorio de 1 minuto para enviarlo inmediatamente sin esperar los 60s.
    """
    try:
        success = SchedulerService.fire_immediately(appt_id)
        if success:
            return jsonify({"status": "fired", "appointment_id": appt_id, "message": "Recordatorio enviado inmediatamente"})
        return jsonify({"error": "No se pudo disparar el recordatorio"}), 400
    except Exception as e:
        logger.error(f"Error al disparar recordatorio: {e}", exc_info=True)
        return jsonify({"error": str(e), "status": "fail"}), 400

@app.route("/api/alerts", methods=["GET"])
def get_alerts():
    return jsonify(AlertService.get_recent_alerts())

@app.route("/api/chat", methods=["GET"])
def get_chat():
    phone = request.args.get("phone", "")
    return jsonify(WhatsAppService.get_chat_history(phone))

@app.route("/health", methods=["GET"])
def health():
    return jsonify({
        "status": "online",
        "clinic": CLINIC_NAME,
        "timezone": str(CLINIC_TIMEZONE),
        "timestamp": datetime.now(CLINIC_TIMEZONE).isoformat(),
        "whatsapp_provider": WHATSAPP_PROVIDER
    })

@app.route("/webhook/whatsapp", methods=["GET"])
def verify_meta_webhook():
    mode = request.args.get("hub.mode")
    token = request.args.get("hub.verify_token")
    challenge = request.args.get("hub.challenge")

    if mode == "subscribe" and token == META_VERIFY_TOKEN:
        logger.info("Webhook de Meta verificado con éxito")
        return challenge, 200
    return "Forbidden", 403

@app.route("/webhook/whatsapp", methods=["POST"])
def handle_whatsapp_webhook():
    incoming = parse_incoming_request()
    if not incoming or not incoming.from_phone or not incoming.body:
        logger.warning(f"Payload inválido o vacío: {request.data}")
        return jsonify({"error": "Payload inválido"}), 400

    phone = incoming.from_phone
    body = incoming.body
    msg_id = incoming.message_id

    logger.info(f"📥 WhatsApp entrante de {phone}: '{body}' (ID: {msg_id})")

    # Registrar mensaje del paciente en el chat interactivo
    WhatsAppService.record_message(phone, "patient", body)

    # 1. Regla de Idempotencia: ¿Mensaje ya procesado?
    if StateService.is_message_already_processed(msg_id):
        logger.info(f"Mensaje {msg_id} ya procesado previamente. Retornando HTTP 200.")
        return Response("<Response/>", mimetype="text/xml", status=200)

    # 2. Regla Anti Race Condition: Adquirir bloqueo para el paciente
    if not StateService.acquire_lock(phone):
        logger.warning(f"Colisión prevenida: operación en vuelo para {phone}")
        return jsonify({"error": "Operación en curso"}), 429

    try:
        # 3. Buscar cita activa
        appointment = CalendarService.find_active_appointment_by_phone(phone)
        if not appointment:
            logger.warning(f"No hay cita activa para {phone}")
            WhatsAppService.send_message(
                phone,
                f"Hola, no encontramos ninguna cita activa próxima asociada a este número en {CLINIC_NAME}. Si deseas concertar un turno, contáctanos directamente."
            )
            return Response("<Response/>", mimetype="text/xml", status=200)

        # 4. Regla Anti-bucle: Estado terminal previo
        if StateService.is_terminal_status(appointment.status):
            is_spam = StateService.register_interaction(phone, appointment.status)
            if is_spam:
                logger.warning(f"Omitiendo respuesta por spam loop para {phone}")
                return Response("<Response/>", mimetype="text/xml", status=200)

            if appointment.status == AppointmentStatus.CONFIRMED:
                WhatsAppService.send_message(phone, WhatsAppService.build_already_confirmed_message(appointment.patient_name))
            elif appointment.status == AppointmentStatus.CANCELLED:
                WhatsAppService.send_message(phone, WhatsAppService.build_already_cancelled_message())
            return Response("<Response/>", mimetype="text/xml", status=200)

        # 5. Clasificar Intención NLP
        nlp_res = NlpService.classify_intent(body)

        if nlp_res.intent == ParsedIntent.CONFIRM:
            logger.info(f"Confirmación recibida para cita {appointment.id} ({appointment.patient_name})")
            CalendarService.update_appointment_status(
                appointment.id,
                AppointmentStatus.CONFIRMED,
                f"Confirmada vía WhatsApp a las {datetime.now(CLINIC_TIMEZONE).isoformat()}"
            )
            StateService.register_interaction(phone, AppointmentStatus.CONFIRMED)
            WhatsAppService.send_message(phone, WhatsAppService.build_confirmation_message(appointment.patient_name))

        elif nlp_res.intent == ParsedIntent.CANCEL:
            logger.info(f"Cancelación recibida para cita {appointment.id} ({appointment.patient_name})")
            CalendarService.update_appointment_status(
                appointment.id,
                AppointmentStatus.CANCELLED,
                f"Cancelada vía WhatsApp a las {datetime.now(CLINIC_TIMEZONE).isoformat()}"
            )
            StateService.register_interaction(phone, AppointmentStatus.CANCELLED)

            # Notificación inmediata a recepción
            AlertService.notify_reception(
                alert_type="CANCELACION_CITA",
                patient_phone=phone,
                patient_name=appointment.patient_name,
                patient_message=body,
                reason="El paciente canceló su cita tras el recordatorio de 24h.",
                appointment=appointment
            )

            WhatsAppService.send_message(phone, WhatsAppService.build_cancellation_message())

        else: # UNKNOWN -> Fallback Humano obligatorio
            logger.warning(f"Intención desconocida para cita {appointment.id}: '{body}' -> Derivando a Recepción")
            CalendarService.update_appointment_status(
                appointment.id,
                AppointmentStatus.MANUAL_REVIEW,
                f"Mensaje ambiguo: '{body}'"
            )

            # Notificar a recepción para revisión manual
            AlertService.notify_reception(
                alert_type="REVISION_MANUAL_REQUERIDA",
                patient_phone=phone,
                patient_name=appointment.patient_name,
                patient_message=body,
                reason="El paciente envió un mensaje que requiere asistencia humana.",
                appointment=appointment
            )

            WhatsAppService.send_message(phone, WhatsAppService.build_fallback_message())

        return Response("<Response/>", mimetype="text/xml", status=200)

    finally:
        StateService.release_lock(phone)

@app.route("/api/cron/trigger-reminders", methods=["POST"])
def trigger_reminders():
    result = ReminderJob.execute()
    return jsonify({"status": "completed", **result})

if __name__ == "__main__":
    logger.info(f"🦷 Servidor Dr. Zaragozá iniciando en puerto {PORT} (Timezone: {CLINIC_TIMEZONE})")
    app.run(host="0.0.0.0", port=PORT, debug=False)
