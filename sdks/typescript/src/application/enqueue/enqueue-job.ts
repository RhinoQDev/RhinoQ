import type { EnqueueInput, JobId } from '../../contracts/index.js';
import type { JobStore } from '../../ports/stores.js';

export class EnqueueJob {
  public constructor(private readonly jobs: JobStore) {}

  public execute<TPayload>(input: EnqueueInput<TPayload>): Promise<JobId> {
    return this.jobs.enqueue(input);
  }
}
