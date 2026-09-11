import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  transport:
    process.env.NODE_ENV !== "production"
      ? {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "SYS:standard" },
        }
      : undefined,
  formatters: {
    level(label) {
      return { level: label };
    },
  },
});

export function childLogger(bindings: Record<string, any>) {
  return logger.child(bindings);
}

export function sessionLogger(sessionId: string) {
  return logger.child({ sessionId });
}
