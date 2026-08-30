import { authenticate } from "../src/auth/service.js";

export function authenticationTest(): boolean {
  return authenticate("user@example.com", "password") === "token";
}
