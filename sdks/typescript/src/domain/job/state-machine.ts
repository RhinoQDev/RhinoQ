import type { JobState } from '../../contracts/index.js';

const transitions: Record<JobState, readonly JobState[]> = {
  pending: ['leased', 'cancelled'],
  leased: ['succeeded', 'retry_wait', 'dead', 'blocked', 'cancelled'],
  retry_wait: ['leased', 'cancelled', 'dead'],
  succeeded: [],
  dead: [],
  cancelled: [],
  blocked: ['leased', 'cancelled'],
};

export function canTransitionJob(from: JobState, to: JobState): boolean {
  return transitions[from].includes(to);
}

export function transitionJob(from: JobState, to: JobState): JobState {
  if (!canTransitionJob(from, to)) {
    throw new Error(`Invalid job transition: ${from} -> ${to}`);
  }
  return to;
}
