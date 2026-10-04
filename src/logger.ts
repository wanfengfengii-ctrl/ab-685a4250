/**
 * Privacy-safe logging.
 *
 * Hard rule: request bodies and raw identifiers (patientId, accessionId,
 * recordId, relatedIds) MUST NOT be passed to any function in this module.
 * Log lines may contain only structural metadata: method names, batch IDs
 * (the client-supplied routing key), validation issue codes and array
 * indices. Error messages produced by third-party code (for example JSON
 * parser messages that quote body snippets) are intentionally NOT logged.
 */

type Level = 'info' | 'warn' | 'error';

export interface LogEvent {
  level: Level;
  event: string;
  meta?: Record<string, string | number | boolean>;
}

export type LogSink = (entry: LogEvent) => void;

let sink: LogSink = ({ level, event, meta }) => {
  const line = {
    ts: new Date().toISOString(),
    level,
    event,
    ...(meta ?? {}),
  };
  const stream = level === 'error' ? process.stderr : process.stdout;
  stream.write(`${JSON.stringify(line)}\n`);
};

/**
 * Replace the log destination. Intended for tests that need to assert on the
 * (already privacy-safe) log stream without touching process.fd, which would
 * interfere with the test runner's own reporter.
 */
export function setLogSink(next: LogSink): void {
  sink = next;
}

function write(level: Level, event: string, meta?: Record<string, string | number | boolean>): void {
  sink({ level, event, meta });
}

export const log = {
  info(event: string, meta?: Record<string, string | number | boolean>): void {
    write('info', event, meta);
  },
  warn(event: string, meta?: Record<string, string | number | boolean>): void {
    write('warn', event, meta);
  },
  error(event: string, meta?: Record<string, string | number | boolean>): void {
    write('error', event, meta);
  },
};
