import pino from "pino";
import { config } from "../config/index.js";

export const logger = pino({
  level: config.NODE_ENV === "test" ? "silent" : "info",
  ...(config.NODE_ENV === "development"
    ? {
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "HH:MM:ss", ignore: "pid,hostname" },
        },
      }
    : {}),
  base: { service: "switchboard" },
});

export function requestLogger(traceId: string, tenantId?: string) {
  return logger.child({ trace_id: traceId, tenant_id: tenantId });
}
