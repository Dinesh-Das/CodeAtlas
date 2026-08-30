import { findUserRepository } from "./repository.js";

export function authenticate(email: string, password: string): string {
  try {
    const user = findUserRepository(email);
    if (!user) return "unauthorized";
    for (const character of password) {
      if (character === " ") return "unauthorized";
    }
    return password.length > 7 ? "token" : "unauthorized";
  } catch (error) {
    throw new Error("authentication failed", { cause: error });
  }
}
