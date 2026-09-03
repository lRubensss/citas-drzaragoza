import re
import unicodedata
import logging
from types_models import IntentClassificationResult, ParsedIntent

logger = logging.getLogger(__name__)

class NlpService:
    @staticmethod
    def normalize(text: str) -> str:
        """
        Normaliza una cadena de texto:
        - Minúsculas
        - Eliminación de acentos/tildes (NFD)
        - Reemplazo de emojis de números (1️⃣, 2️⃣, keycaps)
        - Remoción de puntuación sobrante
        """
        if not text:
            return ""
        
        text = text.lower().strip()

        # Mapeo de keycaps / emojis numéricos antes de quitar diacríticos
        text = re.sub(r"1[\ufe0e\ufe0f]?\u20e3", "1", text)
        text = re.sub(r"2[\ufe0e\ufe0f]?\u20e3", "2", text)
        text = text.replace("1️⃣", "1").replace("2️⃣", "2")

        # Normalización NFD para separar caracteres base de sus diacríticos
        text = unicodedata.normalize("NFD", text)
        text = "".join(ch for ch in text if unicodedata.category(ch) != "Mn")
        
        # Remover puntuación sobrante
        text = re.sub(r"[¿?¡!.,;:_\(\)\-]", " ", text)
        text = re.sub(r"\s+", " ", text).strip()
        return text

    @classmethod
    def classify_intent(cls, raw_text: str) -> IntentClassificationResult:
        normalized = cls.normalize(raw_text)

        # Patrones de confirmación
        confirm_patterns = [
            r"^1$",
            r"\b(opcion 1|numero 1)\b",
            r"\b(confirmar|confirmo|confirmado|confirmada|confirmo asistencia)\b",
            r"\b(si|sii|siii|sep|sip|yes|yep)\b",
            r"\b(ok|oki|okey|okay|vale|perfecto|correcto|de acuerdo|hecho)\b",
            r"\b(asistire|ire|alli estare|ahi estare|cuenta conmigo|seguro)\b",
        ]

        # Patrones de cancelación
        cancel_patterns = [
            r"^2$",
            r"\b(opcion 2|numero 2)\b",
            r"\b(cancelar|cancelo|cancelada|cancelado)\b",
            r"\b(no puedo|no podre|no podria|no voy a poder|no voy a asistir)\b",
            r"\b(anular|anulo|anulacion|dar de baja)\b",
            r"\b(imposible|no asisto|no voy)\b",
        ]

        for pattern in cancel_patterns:
            if re.search(pattern, normalized):
                return IntentClassificationResult(
                    intent=ParsedIntent.CANCEL,
                    confidence=0.95,
                    raw_text=raw_text,
                    normalized_text=normalized
                )

        for pattern in confirm_patterns:
            if re.search(pattern, normalized):
                return IntentClassificationResult(
                    intent=ParsedIntent.CONFIRM,
                    confidence=0.95,
                    raw_text=raw_text,
                    normalized_text=normalized
                )

        return IntentClassificationResult(
            intent=ParsedIntent.UNKNOWN,
            confidence=0.1,
            raw_text=raw_text,
            normalized_text=normalized
        )
