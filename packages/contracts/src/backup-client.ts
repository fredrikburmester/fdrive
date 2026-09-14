import { z } from "zod";
import {
  type BackupAttachmentInput,
  BackupDestinationInput,
  BackupRehearsal,
  type BackupRunInput,
  BackupSchedule,
  BackupsResponse,
} from "./backups.ts";
import { ApiClientError } from "./client.ts";
import { ApiError } from "./error.ts";
import { IDENTITY_HEADER } from "./routes.ts";

const Ok = z.object({ ok: z.literal(true) });
const Accepted = z.object({ id: z.uuid() });
export function createBackupClient(
  options: {
    fetch?: typeof globalThis.fetch;
    baseUrl?: string;
    identityId?: () => string | undefined;
  } = {},
) {
  const base = `${options.baseUrl ?? ""}/api/v1/system/backups`;
  async function request<T>(
    suffix: string,
    schema: z.ZodType<T>,
    method = "GET",
    body?: RequestInit["body"],
    additional: Record<string, string> = {},
  ) {
    const headers = new Headers({ "X-Requested-With": "fdrive", ...additional });
    const identity = options.identityId?.();
    if (identity) headers.set(IDENTITY_HEADER, identity);
    const response = await (options.fetch ?? globalThis.fetch)(`${base}${suffix}`, {
      method,
      headers,
      credentials: "same-origin",
      ...(body === undefined ? {} : { body }),
    });
    const raw: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const failure = ApiError.safeParse(raw);
      throw new ApiClientError(
        failure.success ? failure.data.error.kind : "internal",
        failure.success ? failure.data.error.message : "Backup request failed",
        response.status,
      );
    }
    return schema.parse(raw);
  }
  const json = <T>(path: string, schema: z.ZodType<T>, method: string, body: unknown) =>
    request(path, schema, method, JSON.stringify(body), { "Content-Type": "application/json" });
  return {
    status: () => request("", BackupsResponse),
    estimate: () => json("/estimate", Accepted, "POST", {}),
    recordRehearsal: (report: BackupRehearsal) =>
      json("/rehearsal", Ok, "POST", BackupRehearsal.parse(report)),
    unlock: (credential: Record<string, string>) => json("/unlock", Ok, "POST", { credential }),
    key: (recipient: string) =>
      json("/key", z.object({ challenge: z.string() }), "POST", { recipient }),
    confirm: (proof: string) => json("/key/confirm", Ok, "POST", { proof }),
    schedule: (input: BackupSchedule) => json("/schedule", Ok, "PUT", BackupSchedule.parse(input)),
    create: (input: z.infer<typeof BackupRunInput>) => json("/runs", Accepted, "POST", input),
    verify: (id: string) => json(`/runs/${encodeURIComponent(id)}/verify`, Ok, "POST", {}),
    destinationSchedule: (id: string, schedule: BackupSchedule | null) =>
      json(`/destinations/${encodeURIComponent(id)}/schedule`, Ok, "PUT", { schedule }),
    cancel: (id: string) => json(`/runs/${encodeURIComponent(id)}/cancel`, Ok, "POST", {}),
    retry: (id: string) => json(`/runs/${encodeURIComponent(id)}/retry`, Ok, "POST", {}),
    pin: (id: string, pinned: boolean) =>
      json(`/runs/${encodeURIComponent(id)}/pin`, Ok, "PUT", { pinned }),
    remove: (id: string) => request(`/runs/${encodeURIComponent(id)}`, Ok, "DELETE"),
    destination: (input: z.infer<typeof BackupDestinationInput>, id?: string) =>
      json(
        `/destinations${id ? `/${encodeURIComponent(id)}` : ""}`,
        Accepted,
        id ? "PUT" : "POST",
        BackupDestinationInput.parse(input),
      ),
    testDestination: (id: string) =>
      json(`/destinations/${encodeURIComponent(id)}/test`, Ok, "POST", {}),
    removeDestination: (id: string) =>
      request(`/destinations/${encodeURIComponent(id)}`, Ok, "DELETE"),
    upload: (input: z.infer<typeof BackupAttachmentInput>, body: Blob, id?: string) => {
      const metadata = btoa(
        String.fromCharCode(...new TextEncoder().encode(JSON.stringify(input))),
      );
      return request(
        `/attachments${id ? `/${encodeURIComponent(id)}` : ""}`,
        Accepted,
        id ? "PUT" : "POST",
        body,
        { "Content-Type": "application/zip", "X-Backup-Metadata": metadata },
      );
    },
    removeAttachment: (id: string) =>
      request(`/attachments/${encodeURIComponent(id)}`, Ok, "DELETE"),
    downloadUrl: (id: string) => `${base}/runs/${encodeURIComponent(id)}/download`,
    attachmentUrl: (id: string) => `${base}/attachments/${encodeURIComponent(id)}/download`,
  };
}
