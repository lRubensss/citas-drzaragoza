import time
import logging
from types_models import AppointmentStatus

logger = logging.getLogger(__name__)

class StateService:
    _processed_message_ids = set()
    _locks_in_flight = set()
    _user_interactions = {}  # phone -> {"status": AppointmentStatus, "timestamp": float, "count": int}

    @classmethod
    def is_message_already_processed(cls, message_id: str) -> bool:
        if not message_id:
            return False
        if message_id in cls._processed_message_ids:
            logger.warning(f"Mensaje duplicado detectado: {message_id}. Ignorando para mantener idempotencia.")
            return True
        cls._processed_message_ids.add(message_id)

        # Evitar crecimiento ilimitado
        if len(cls._processed_message_ids) > 10000:
            cls._processed_message_ids.pop()
        return False

    @classmethod
    def acquire_lock(cls, phone: str) -> bool:
        if phone in cls._locks_in_flight:
            logger.warning(f"Bloqueo activo para {phone}: colisión prevenida.")
            return False
        cls._locks_in_flight.add(phone)
        return True

    @classmethod
    def release_lock(cls, phone: str) -> None:
        cls._locks_in_flight.discard(phone)

    @classmethod
    def register_interaction(cls, phone: str, status: AppointmentStatus) -> bool:
        """
        Retorna True si el usuario parece estar en un bucle repetitivo de spam.
        """
        now = time.time()
        existing = cls._user_interactions.get(phone)
        if existing:
            diff = now - existing["timestamp"]
            if diff < 120 and existing["status"] == status and status in [AppointmentStatus.CONFIRMED, AppointmentStatus.CANCELLED]:
                existing["count"] += 1
                existing["timestamp"] = now
                if existing["count"] >= 3:
                    logger.warning(f"Bucle de spam detectado para {phone} en estado {status}")
                    return True
            else:
                existing["count"] = 1
                existing["status"] = status
                existing["timestamp"] = now
        else:
            cls._user_interactions[phone] = {"status": status, "timestamp": now, "count": 1}
        return False

    @staticmethod
    def is_terminal_status(status: AppointmentStatus) -> bool:
        return status in [AppointmentStatus.CONFIRMED, AppointmentStatus.CANCELLED]
