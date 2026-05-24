// Simple async semaphore for capping concurrent task execution.
// Default concurrency is 1; pass concurrency: N to orchestrate() to allow more.
export class JobQueue {
  private active = 0
  private waiting: Array<() => void> = []

  constructor(private readonly limit: number) {
    if (limit < 1) throw new Error(`JobQueue limit must be >= 1, got ${limit}`)
  }

  async acquire(): Promise<() => void> {
    if (this.active < this.limit) {
      this.active++
      return () => this.release()
    }
    return new Promise<() => void>((resolve) => {
      this.waiting.push(() => {
        this.active++
        resolve(() => this.release())
      })
    })
  }

  private release(): void {
    this.active--
    const next = this.waiting.shift()
    if (next) next()
  }

  get activeCount(): number {
    return this.active
  }

  get waitingCount(): number {
    return this.waiting.length
  }
}
