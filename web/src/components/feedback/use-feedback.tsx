import { createContext, useContext } from 'react';

/**
 * A persistent operator error (ADR-0007/0009). Keeps the server's diagnostic
 * structured so the surface can show the stable `reason` code and the raw
 * `detail` verbatim, never genericised and never auto-dismissed.
 */
export interface OperatorError {
  id: string;
  /** Human lead-in ("Retry failed"). */
  title: string;
  /** The full technical message ("label: diagnostic"). */
  message: string;
  /** HTTP status, when the failure came from a response (vs. a network error). */
  status?: number;
  /** Stable machine reason code, when the failure carried one. */
  reason?: string;
  /** Raw technical diagnostic, verbatim. */
  detail?: string;
}

export interface FeedbackApi {
  /**
   * A transient success/info confirmation — a bottom toast that auto-dismisses
   * (ADR-0009). Never use this for errors.
   */
  notify: (message: string, opts?: { description?: string }) => void;
  /**
   * Raise a persistent, copy-pasteable operator error (ADR-0007/0009). Stays on
   * screen until dismissed; never a toast. Accepts an ApiError (keeps its reason
   * code + raw detail), any Error, or a string.
   */
  reportError: (error: unknown, opts?: { title?: string }) => void;
}

export const FeedbackContext = createContext<FeedbackApi | null>(null);

/** Access the app's feedback channels. Must be used within a FeedbackProvider. */
export function useFeedback(): FeedbackApi {
  const ctx = useContext(FeedbackContext);
  if (!ctx) {
    throw new Error('useFeedback must be used within a FeedbackProvider');
  }
  return ctx;
}
