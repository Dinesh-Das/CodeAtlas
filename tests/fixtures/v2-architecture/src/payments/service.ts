import { findUserRepository } from "../users/repository.js";

export function charge(userId: string, amount: number): boolean {
  return findUserRepository(userId) !== null && amount > 0;
}
