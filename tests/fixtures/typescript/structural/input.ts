import { dependency as dep } from "./dependency";

export interface Processor {
  readonly id: string;
  execute(input: string): Promise<boolean>;
}

export class Service {
  private token: string = "not-stored";

  public async run(input: string = "hidden"): Promise<boolean> {
    const normalize = (value: string) => value.trim();
    return normalize(input).length > 0;
  }
}

const localValue = 1;
export const helper = (value: number): number => value + localValue;
export { localValue };
