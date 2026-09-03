import { AppointmentStatus } from '../types/appointment';
import { logger } from '../utils/logger';

export class StateService {
  // Set de Message IDs procesados recientemente para idempotencia estricta (evita reenvíos de webhook)
  private static processedMessageIds = new Set<string>();

  // Bloqueos en vuelo por teléfono para prevenir race conditions si el cliente envía mensajes ráfaga
  private static locksInFlight = new Set<string>();

  // Registro de últimos estados y respuestas para evitar bucles
  private static userLastInteractions = new Map<
    string,
    { status: AppointmentStatus; lastInteractionAt: number; count: number }
  >();

  /**
   * Verifica si un mensaje ya ha sido procesado (Idempotencia)
   */
  public static isMessageAlreadyProcessed(messageId: string): boolean {
    if (!messageId) return false;
    if (this.processedMessageIds.has(messageId)) {
      logger.warn({ messageId }, 'Mensaje duplicado detectado. Ignorando para mantener idempotencia.');
      return true;
    }
    this.processedMessageIds.add(messageId);

    // Mantener tamaño de caché controlado (máximo 10,000 IDs en memoria)
    if (this.processedMessageIds.size > 10000) {
      const first = this.processedMessageIds.values().next().value;
      if (first) this.processedMessageIds.delete(first);
    }
    return false;
  }

  /**
   * Adquiere un bloqueo atómico para un número de teléfono.
   * Evita condiciones de carrera si entran 2 webhooks simultáneos del mismo usuario.
   */
  public static async acquireLock(phone: string): Promise<boolean> {
    if (this.locksInFlight.has(phone)) {
      logger.warn({ phone }, 'Bloqueo activo: otra petición está procesando este teléfono actualmente');
      return false;
    }
    this.locksInFlight.add(phone);
    return true;
  }

  /**
   * Libera el bloqueo del teléfono
   */
  public static releaseLock(phone: string): void {
    this.locksInFlight.delete(phone);
  }

  /**
   * Registra interacción y detecta si el usuario está en un bucle repetitivo
   */
  public static registerInteraction(phone: string, newStatus: AppointmentStatus): { isSpamLoop: boolean } {
    const now = Date.now();
    const existing = this.userLastInteractions.get(phone);

    if (existing) {
      // Si interactúa más de 5 veces en menos de 2 minutos sobre el mismo estado terminal
      const diffMs = now - existing.lastInteractionAt;
      if (diffMs < 120000 && existing.status === newStatus && (newStatus === 'CONFIRMED' || newStatus === 'CANCELLED')) {
        existing.count += 1;
        existing.lastInteractionAt = now;
        if (existing.count >= 3) {
          logger.warn({ phone, status: newStatus, count: existing.count }, 'Detectado posible bucle de mensajes del usuario');
          return { isSpamLoop: true };
        }
      } else {
        existing.count = 1;
        existing.status = newStatus;
        existing.lastInteractionAt = now;
      }
    } else {
      this.userLastInteractions.set(phone, { status: newStatus, lastInteractionAt: now, count: 1 });
    }

    return { isSpamLoop: false };
  }

  /**
   * Determina si un estado es terminal y no debe aceptar mutaciones repetitivas
   */
  public static isTerminalStatus(status: AppointmentStatus): boolean {
    return status === 'CONFIRMED' || status === 'CANCELLED';
  }
}
