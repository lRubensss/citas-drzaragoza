import { IntentClassificationResult, ParsedIntent } from '../types/appointment';
import { logger } from '../utils/logger';

export class NlpService {
  /**
   * Normaliza una cadena de texto eliminando acentos/tildes, caracteres especiales,
   * emojis y convirtiendo a minúsculas para un análisis semántico estricto.
   */
  public static normalize(text: string): string {
    if (!text) return '';
    return text
      .toLowerCase()
      .trim()
      // Reemplazar números con formato keycaps / emoji (ej: 1️⃣ -> 1, 2️⃣ -> 2)
      .replace(/1[\ufe0e\ufe0f]?\u20e3/g, '1')
      .replace(/2[\ufe0e\ufe0f]?\u20e3/g, '2')
      .replace(/1️⃣/g, '1')
      .replace(/2️⃣/g, '2')
      // Eliminar diacríticos / acentos (ej: "sí" -> "si", "anulación" -> "anulacion")
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      // Eliminar signos de puntuación repetidos
      .replace(/[¿?¡!.,;:_()\-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Clasifica la intención del paciente con tolerancia a errores tipográficos y variantes coloquiales.
   */
  public static classifyIntent(rawText: string): IntentClassificationResult {
    const normalized = this.normalize(rawText);

    logger.debug({ rawText, normalized }, 'Clasificando intención de mensaje');

    // 1. Patrones de CONFIRMACIÓN
    const confirmPatterns = [
      /^1$/,
      /\b(opcion 1|numero 1)\b/,
      /\b(confirmar|confirmo|confirmado|confirmada|confirmo asistencia)\b/,
      /\b(si|sii|siii|sep|sip|yes|yep)\b/,
      /\b(ok|oki|okey|okay|vale|perfecto|correcto|de acuerdo|hecho)\b/,
      /\b(asistire|ire|alli estare|ahi estare|cuenta conmigo|seguro)\b/,
    ];

    // 2. Patrones de CANCELACIÓN
    const cancelPatterns = [
      /^2$/,
      /\b(opcion 2|numero 2)\b/,
      /\b(cancelar|cancelo|cancelada|cancelado)\b/,
      /\b(no puedo|no podre|no podria|no voy a poder|no voy a asistir)\b/,
      /\b(anular|anulo|anulacion|dar de baja)\b/,
      /\b(imposible|no asisto|no voy)\b/,
    ];

    // Primero verificamos coincidencia exacta o fuerte con cancelación
    // Nota: "no" aislado o frases como "no puedo" deben ser tratadas con precaución
    for (const pattern of cancelPatterns) {
      if (pattern.test(normalized)) {
        return {
          intent: 'CANCEL',
          confidence: 0.95,
          rawText,
          normalizedText: normalized,
        };
      }
    }

    // Luego verificamos confirmación
    for (const pattern of confirmPatterns) {
      if (pattern.test(normalized)) {
        return {
          intent: 'CONFIRM',
          confidence: 0.95,
          rawText,
          normalizedText: normalized,
        };
      }
    }

    // Caso de ambigüedad o respuesta no entendida -> Fallback humano
    return {
      intent: 'UNKNOWN',
      confidence: 0.1,
      rawText,
      normalizedText: normalized,
    };
  }
}
