import { run } from "./process";
import type { OfficeFixtureState } from "./state";

/** Return only allowlisted failure labels and numbers, never raw editor logs. */
export function editorFailureSummary(log: string): string[] {
  return log
    .split("\n")
    .filter((line) => /WARN|ERROR/.test(line))
    .map((line) => {
      const labels =
        line.match(
          /\b(?:CheckFileInfo|GetFile|PutFile|PutRelativeFile|RenameFile|Lock|Unlock|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|wopiClient|downloadFile|postWopi|checkFileInfo|refreshLock|asc_findCell|getTargetDocContent|OnKeyDown|GetContentPosition|Set_CurrentElement)\b/g,
        ) ?? [];
      const codes = [
        ...line.matchAll(
          /\b(?:statusCode|status|errorCode|error|code)["'\s:=]+(-?\d{1,5})(?![\d.])/gi,
        ),
      ].map((match) => match[1]);
      const exception = editorExceptionSummary(line);
      return JSON.stringify({ labels, codes, ...(exception === null ? {} : { exception }) });
    });
}

export async function editorDiagnostics(
  state: OfficeFixtureState,
  execute: typeof run = run,
): Promise<string[]> {
  if (state.product !== "onlyoffice") return [];
  const log = await execute("docker", [
    "exec",
    state.officeContainer,
    "tail",
    "-n",
    "300",
    "/var/log/onlyoffice/documentserver/docservice/out.log",
  ]);
  return editorFailureSummary(log);
}

/** Keep exception classifications and code identifiers, never URLs, messages or arguments. */
export function editorExceptionSummary(
  text: string,
): { kind: string; properties: string[]; functions: string[] } | null {
  const kind = text.match(/\b(TypeError|RangeError|ReferenceError)\b/)?.[1];
  if (kind === undefined) return null;
  const properties = [
    ...text.matchAll(/reading [\\'"]+([A-Za-z_$][A-Za-z0-9_$]{0,60})[\\'"]+/g),
  ].flatMap((match) => match.slice(1, 2));
  const functions = [
    ...text.matchAll(/(?:^|\n|\\n)\s*at ([A-Za-z_$][A-Za-z0-9_.$]{0,80})\s+\(/g),
  ].flatMap((match) => match.slice(1, 2));
  return { kind, properties: [...new Set(properties)], functions: [...new Set(functions)] };
}
