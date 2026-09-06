/** Provides the current time. Lets use cases be tested with a fixed clock. */
export interface Clock {
  now(): Date;
}
