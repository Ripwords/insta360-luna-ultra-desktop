/**
 * The message to show for a caught value. Tauri's `invoke()` rejects with the
 * Rust command's `Err(String)` as a bare string rather than an `Error`, so both
 * shapes carry the real cause; anything else gets the fallback.
 */
export function errorMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message) return cause.message;
  if (typeof cause === "string" && cause) return cause;
  return fallback;
}
