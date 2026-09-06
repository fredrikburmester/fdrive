import type { CompressRequest, ExtractRequest } from "@fdrive/contracts";

/**
 * The request that started a job, kept alongside its `JobStatus` so a
 * failed job's "Retry" button can resubmit the exact same request. Only
 * jobs submitted during the current session carry one (see
 * `lib/jobs/reducer.ts`'s `hydrate`, which drops requests for job ids that
 * no longer exist and never invents one for a job loaded from
 * `apiClient.jobs()`).
 */
export type JobRequest =
  | { readonly kind: "compress"; readonly req: CompressRequest }
  | { readonly kind: "extract"; readonly req: ExtractRequest };
