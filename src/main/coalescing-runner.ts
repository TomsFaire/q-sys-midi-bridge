/**
 * CoalescingRunner — runs an async task one at a time. Requests that arrive
 * while a run is in flight collapse into a single trailing run, so a burst of
 * N requests costs at most two runs and the last one starts after every
 * earlier one has finished. The task reads its inputs when it starts, which
 * is what makes "latest config wins" true.
 */
export class CoalescingRunner {
  private running: Promise<void> | null = null
  private trailing: Promise<void> | null = null

  constructor(private readonly task: () => Promise<void>) {}

  /** Resolves when the run that covers this request has finished. Never rejects. */
  request(onError: (err: Error) => void): Promise<void> {
    if (!this.running) return this.start(onError)
    if (!this.trailing) {
      this.trailing = this.running.then(() => {
        this.trailing = null
        return this.start(onError)
      })
    }
    return this.trailing
  }

  private start(onError: (err: Error) => void): Promise<void> {
    const run: Promise<void> = this.task()
      .catch(onError)
      .finally(() => { if (this.running === run) this.running = null })
    this.running = run
    return run
  }
}
