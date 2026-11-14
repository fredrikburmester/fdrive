import {
  createFilesFolderGuard,
  FILES_MARKER,
  type FilesFolderFacts,
  type FilesFolderGuard,
} from "@fdrive/local";

export interface FilesFolderLog {
  info(message: string): void;
  error(message: string): void;
}

/**
 * The guard over the deployment's files folder, logging each change of
 * verdict: a refusal loudly, since every file route fails until the folder
 * is fixed, and an adoption or recovery once.
 */
export function createDeploymentFilesFolderGuard(
  root: string,
  facts: FilesFolderFacts,
  log: FilesFolderLog,
): FilesFolderGuard {
  return createFilesFolderGuard({
    root,
    facts,
    onChange: (verdict) => {
      if (!verdict.ok) {
        log.error(
          `files folder ${root} refused: ${verdict.reason} Files stay unavailable and nothing is indexed until it is fixed; fdrive checks again on the next request.`,
        );
      } else if (verdict.adopted) {
        log.info(`files folder ${root} adopted: wrote ${FILES_MARKER} with this installation's id`);
      } else {
        log.info(`files folder ${root} verified`);
      }
    },
  });
}

/** The core subsystem's health from the guard: a refusal fails it with the reason. */
export async function filesFolderHealth(
  guard: FilesFolderGuard,
): Promise<true | { readonly failed: string }> {
  const verdict = await guard.verify();
  return verdict.ok ? true : { failed: verdict.reason };
}
