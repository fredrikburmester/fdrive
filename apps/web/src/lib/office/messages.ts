import type { OfficeOpenResponse } from "@fdrive/contracts";
export type OfficeMessage =
  | { MessageId: "UI_Close" | "UI_Edit" }
  | { MessageId: "App_LoadingStatus"; Values?: { Status?: string } }
  | { MessageId: "File_Rename"; Values: { NewName: string } }
  | { MessageId: "UI_Hyperlink"; Values: { Url: string } };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recognizedMessage(value: unknown): OfficeMessage | null {
  if (!isRecord(value)) return null;
  if (value.MessageId === "UI_Close" || value.MessageId === "UI_Edit")
    return { MessageId: value.MessageId };
  if (value.MessageId === "App_LoadingStatus") {
    if (value.Values === undefined) return { MessageId: value.MessageId };
    if (!isRecord(value.Values)) return null;
    if (value.Values.Status === undefined) return { MessageId: value.MessageId, Values: {} };
    return typeof value.Values.Status === "string"
      ? { MessageId: value.MessageId, Values: { Status: value.Values.Status } }
      : null;
  }
  if (!isRecord(value.Values)) return null;
  if (
    value.MessageId === "File_Rename" &&
    typeof value.Values.NewName === "string" &&
    value.Values.NewName.length <= 255
  )
    return { MessageId: value.MessageId, Values: { NewName: value.Values.NewName } };
  if (
    value.MessageId === "UI_Hyperlink" &&
    typeof value.Values.Url === "string" &&
    value.Values.Url.length <= 8192
  )
    return { MessageId: value.MessageId, Values: { Url: value.Values.Url } };
  return null;
}

/** Both checks are required: another iframe at the editor origin is not this editor. */
export function parseOfficeMessage(
  event: { origin: string; source: unknown; data: unknown },
  editorOrigin: string,
  iframeWindow: unknown,
): OfficeMessage | null {
  if (
    iframeWindow === null ||
    iframeWindow === undefined ||
    event.origin !== editorOrigin ||
    event.source !== iframeWindow
  )
    return null;
  try {
    const data: unknown = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
    return recognizedMessage(data);
  } catch {
    return null;
  }
}

export function validOfficeDescriptor(
  descriptor: OfficeOpenResponse,
  identityId: string,
  path: string,
): boolean {
  try {
    const action = new URL(descriptor.actionUrl);
    return (
      descriptor.identityId === identityId &&
      descriptor.path === path &&
      ["http:", "https:"].includes(action.protocol) &&
      action.origin === descriptor.editorOrigin &&
      !action.username &&
      !action.password &&
      !action.hash &&
      !action.searchParams.has("access_token") &&
      typeof descriptor.formFields.access_token === "string" &&
      descriptor.formFields.access_token.length > 0
    );
  } catch {
    return false;
  }
}
