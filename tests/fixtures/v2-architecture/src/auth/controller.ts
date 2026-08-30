import { auditRepository, findUserRepository } from "./repository.js";
import { authenticate } from "./service.js";

export function login(email: string, password: string): string {
  auditRepository(email);
  const user = findUserRepository(email);
  return authenticate(user, password);
}
