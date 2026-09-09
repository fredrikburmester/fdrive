import {
  OfficeRuntimeConfiguration,
  OfficeSettings,
  type OfficeSettingsUpdateRequest,
  type SystemOfficeResponse,
} from "@fdrive/contracts";
import type { SettingsRepo } from "@fdrive/db";
import { ApiHttpError } from "../errors.js";

export const OFFICE_SETTINGS_KEY = "office.configuration";

export async function probeOnlyOfficeRuntime(
  serverUrl: string,
  revision: number,
  fetchImpl: typeof fetch,
): Promise<"starting" | "ready" | "unavailable"> {
  const runtimeUrl = new URL(serverUrl);
  runtimeUrl.port = "8099";
  runtimeUrl.pathname = "/runtime";
  runtimeUrl.search = "";
  runtimeUrl.hash = "";
  const response = await fetchImpl(runtimeUrl, {
    signal: AbortSignal.timeout(2000),
    redirect: "error",
  });
  if (!response.ok) return "unavailable";
  const state = (await response.json()) as { status?: unknown; revision?: unknown };
  if (state.status === "failed") return "unavailable";
  if (state.status === "ready" && state.revision === revision) return "ready";
  return "starting";
}

export interface OfficeSettingsService {
  configuration(): Promise<OfficeSettings>;
  update(
    activeProviderId: string | null,
    input: OfficeSettingsUpdateRequest,
  ): Promise<OfficeSettings>;
  runtimeConfiguration(): Promise<OfficeRuntimeConfiguration>;
  status(activeProviderId: string | null): Promise<SystemOfficeResponse>;
}

export function createOfficeSettingsService(deps: {
  settings: Pick<SettingsRepo, "get" | "compareAndSet">;
  product: "onlyoffice" | "collabora";
  /** The owner-chosen server address the editor is told fdrive lives at; Office cannot be enabled without one. */
  publicUrl: () => Promise<string | null>;
  probeStatus: (configuration: OfficeSettings) => Promise<"starting" | "ready" | "unavailable">;
}): OfficeSettingsService {
  const defaults: OfficeSettings = {
    revision: 0,
    enabled: false,
    editingEnabled: false,
    editingProviderId: null,
    editorUsernames: [],
  };

  async function read(): Promise<{ raw: unknown | null; value: OfficeSettings }> {
    const raw = await deps.settings.get<unknown>(OFFICE_SETTINGS_KEY);
    if (raw === null) return { raw, value: defaults };
    const parsed = OfficeSettings.safeParse(raw);
    if (!parsed.success)
      throw new ApiHttpError("internal", "Stored Office configuration is invalid.");
    return { raw, value: parsed.data };
  }

  return {
    async configuration() {
      return (await read()).value;
    },
    async update(activeProviderId, input) {
      if (input.enabled && (await deps.publicUrl()) === null)
        throw new ApiHttpError(
          "bad_request",
          "Set the fdrive server address before enabling Office.",
        );
      if (input.enabled && input.editingEnabled && input.editingProviderId !== activeProviderId)
        throw new ApiHttpError(
          "conflict",
          "The active SFTPGo provider changed. Reload Office settings and try again.",
        );
      const current = await read();
      if (input.revision !== current.value.revision)
        throw new ApiHttpError(
          "conflict",
          "Office settings changed in another session. Reload and try again.",
        );
      const next = OfficeSettings.parse({ ...input, revision: input.revision + 1 });
      if (!(await deps.settings.compareAndSet(OFFICE_SETTINGS_KEY, current.raw, next)))
        throw new ApiHttpError(
          "conflict",
          "Office settings changed in another session. Reload and try again.",
        );
      return next;
    },
    async runtimeConfiguration() {
      const value = (await read()).value;
      return OfficeRuntimeConfiguration.parse({
        version: 1,
        revision: value.revision,
        enabled: value.enabled && deps.product === "onlyoffice",
      });
    },
    async status(activeProviderId) {
      const configuration = (await read()).value;
      let status: SystemOfficeResponse["status"] = "off";
      if (configuration.enabled) {
        try {
          status = await deps.probeStatus(configuration);
        } catch {
          status = "unavailable";
        }
      }
      return { configuration, product: deps.product, status, activeProviderId };
    },
  };
}
