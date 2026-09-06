import { formatBytes } from "../format.js";

/** One throughput sample: bytes transferred so far, as of `timestampMs`. */
export interface ThroughputSample {
  readonly timestampMs: number;
  readonly bytesDone: number;
}

/**
 * Estimates bytes per second from a series of monotonically increasing
 * samples, using only the samples within `windowMs` of the most recent one
 * (defaults to 5 seconds) so a slow start does not depress a since-recovered
 * rate. Returns 0 when there are fewer than two samples in the window or the
 * elapsed time is zero.
 */
export function estimateSpeed(samples: readonly ThroughputSample[], windowMs = 5000): number {
  if (samples.length < 2) {
    return 0;
  }
  const last = samples[samples.length - 1];
  /* v8 ignore next 3 -- unreachable: samples.length >= 2 guarantees a last element */
  if (last === undefined) {
    return 0;
  }

  let first = last;
  for (const sample of samples) {
    if (last.timestampMs - sample.timestampMs <= windowMs) {
      first = sample;
      break;
    }
  }
  if (first === last) {
    return 0;
  }

  const elapsedSeconds = (last.timestampMs - first.timestampMs) / 1000;
  if (elapsedSeconds <= 0) {
    return 0;
  }

  const bytes = last.bytesDone - first.bytesDone;
  return bytes > 0 ? bytes / elapsedSeconds : 0;
}

/** Formats a throughput as "<bytes>/s", e.g. "1.5 MB/s". */
export function formatSpeed(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`;
}

/**
 * Formats an estimated time remaining given the bytes left to transfer and
 * the current speed: "0s" once nothing remains, "calculating..." when speed
 * is not yet known, otherwise a compact duration such as "45s", "3m 12s", or
 * "2h 5m".
 */
export function formatEta(bytesRemaining: number, bytesPerSecond: number): string {
  if (bytesRemaining <= 0) {
    return "0s";
  }
  if (bytesPerSecond <= 0) {
    return "calculating...";
  }

  const totalSeconds = Math.ceil(bytesRemaining / bytesPerSecond);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}
