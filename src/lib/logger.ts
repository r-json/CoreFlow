/**
 * Minimal structured (JSON) logger. One line per event so logs are queryable in
 * Vercel/any log drain. Note: production strips console.log/debug/info (see
 * next.config removeConsole) to cut noise — error/warn always survive, which is
 * where actionable signal lives. Use `audit()` for security events that must
 * persist regardless.
 */

type Level = 'debug' | 'info' | 'warn' | 'error';

type Fields = Record<string, unknown>;

function emit(level: Level, msg: string, fields?: Fields) {
  const entry = { level, msg, time: new Date().toISOString(), ...fields };
  let line: string;
  try {
    line = JSON.stringify(entry);
  } catch {
    line = JSON.stringify({ level, msg, time: entry.time, note: 'unserializable fields' });
  }
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else if (level === 'info') console.log(line);
  else console.debug(line);
}

export const logger = {
  debug: (msg: string, fields?: Fields) => emit('debug', msg, fields),
  info: (msg: string, fields?: Fields) => emit('info', msg, fields),
  warn: (msg: string, fields?: Fields) => emit('warn', msg, fields),
  error: (msg: string, fields?: Fields) => emit('error', msg, fields),
};
