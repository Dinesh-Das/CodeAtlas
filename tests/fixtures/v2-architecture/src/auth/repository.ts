export function findUserRepository(email: string): string | null {
  return email.includes("@") ? email : null;
}

export function auditRepository(_email: string): void {}
