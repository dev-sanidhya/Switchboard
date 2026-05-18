import { randomUUID } from "crypto";

export function generateTraceId(): string {
  return randomUUID();
}

export function generateId(): string {
  return randomUUID();
}
