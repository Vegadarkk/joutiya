import pino from "pino";

// JSON logs (§2). Personal data and secrets are redacted by key, wherever they appear.
const REDACT = [
  "password",
  "token",
  "idToken",
  "authorization",
  "cookie",
  "email",
  "phone",
  "ip",
  "*.password",
  "*.token",
  "*.idToken",
  "*.authorization",
  "*.cookie",
  "*.email",
  "*.phone",
  "*.ip",
  "req.headers.authorization",
  "req.headers.cookie",
];

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { app: "joutiya", env: process.env.APP_ENV ?? "dev" },
  redact: { paths: REDACT, censor: "[redacted]" },
  timestamp: pino.stdTimeFunctions.isoTime,
});
