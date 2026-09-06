/** Generates opaque unique identifiers. Lets use cases be tested with fixed ids. */
export interface IdGenerator {
  next(): string;
}
