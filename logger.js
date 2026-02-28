const { createLogger, format, transports } = require('winston');
const { combine, timestamp, printf, colorize } = format;

const logFormat = printf(({ level, message, timestamp }) => {
  return `${timestamp} [${level}]: ${message}`;
});

const logger = createLogger({
  level: 'info',
  format: combine(timestamp(), logFormat),
  transports: [
    new transports.File({ filename: 'bot-error.log', level: 'error' }),
    new transports.File({ filename: 'bot-combined.log' })
  ]
});

// Console only in non-production for developer convenience
if (process.env.NODE_ENV !== 'production') {
  logger.add(new transports.Console({ format: combine(colorize(), timestamp(), logFormat) }));
}

module.exports = logger;
