export function findUserRepository(id: string): string | null {
  return id.length > 0 ? id : null;
}
