/**
 * Structured JSON logging to stdout.
 * Coexists with the existing markdown daily logs in memory/log.ts.
 */

export type LogLevel = "info" | "warn" | "error";

export function structuredLog(
  level: LogLevel,
  event: string,
  meta?: Record<string, unknown>,
): void {
  const entry = {
    ts: new Date().toISOString(),
    level,
    event,
    ...meta,
  };
  process.stdout.write(JSON.stringify(entry) + "\n");
}
