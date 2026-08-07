export type ErrorReporter = (error: unknown) => void;

/**
 * Delivers operational errors without allowing a failing error listener to
 * recursively emit another error event.
 */
export class ErrorManager {
  constructor(
    private readonly onError: ErrorReporter,
    private readonly emitError: ErrorReporter,
  ) {}

  report(error: unknown, emitEvent = true): void {
    this.callSafely(this.onError, error);
    if (emitEvent) this.callSafely(this.emitError, error);
  }

  private callSafely(callback: ErrorReporter, error: unknown): void {
    try {
      callback(error);
    } catch (reportingError) {
      try {
        console.error('[SakuCore] Error reporter failed', reportingError);
      } catch {
        // A hostile console implementation must not break gateway processing.
      }
    }
  }
}
