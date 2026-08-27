export interface Runnable {
  run(): void;
}

export class Base {
  protected helper(): void {}
}

export function shared(): void {}
export const value = 1;
