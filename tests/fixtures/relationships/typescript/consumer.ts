import { Base, Runnable, shared, value } from "./base.js";

export class Worker extends Base implements Runnable {
  run(): void {
    shared();
    this.finish();
    const current = value;
  }

  finish(): void {}
}
