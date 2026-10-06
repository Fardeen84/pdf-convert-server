/** Tiny async semaphore: limits how many conversions run at the same time. */
export class Semaphore {
  private waiting: Array<() => void> = [];
  private active = 0;

  constructor(private readonly max: number) {}

  get queued(): number {
    return this.waiting.length;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active++;
    try {
      return await task();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}
