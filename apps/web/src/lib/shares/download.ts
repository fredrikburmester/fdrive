import { ApiError } from "@fdrive/contracts";

/** Only known, bounded API JSON errors can be displayed from a download frame. */
export function downloadFrameError(input: {
  href: string;
  expected: string;
  contentType: string;
  text: string;
}): string | null {
  if (
    input.href !== input.expected ||
    input.contentType.split(";")[0]?.trim() !== "application/json" ||
    input.text.length > 8192
  )
    return null;
  try {
    const parsed = ApiError.safeParse(JSON.parse(input.text));
    return parsed.success
      ? parsed.data.error.message.replace(/[\p{Cc}]/gu, " ").slice(0, 2048)
      : null;
  } catch {
    return null;
  }
}
