/** The key in SEED_FILES whose content belongs to the shared folder, not a user's home. */
const SHARED_FILES_KEY = "@shared";

/** The SEED_FOLDERS entry that "@shared" content is mapped under. */
const SHARED_FOLDER_NAME = "shared";

export interface SeedFileLayoutOptions {
  readonly dataDir: string;
}

export interface SeededFile {
  readonly containerPath: string;
  readonly content: string;
}

/**
 * Maps the SEED_FILES structure (owner -> virtual path -> content) onto
 * absolute paths inside the SFTPGo container. Pure: no filesystem access.
 * The "@shared" owner maps under the mapped path of the "shared" folder
 * (dataDir/_folders/shared/...); every other owner maps under its own home
 * directory (dataDir/<owner>/...).
 */
export function seedFileLayout(
  files: Readonly<Record<string, Record<string, string>>>,
  opts: SeedFileLayoutOptions,
): SeededFile[] {
  const result: SeededFile[] = [];

  for (const [owner, pathToContent] of Object.entries(files)) {
    const base =
      owner === SHARED_FILES_KEY
        ? `${opts.dataDir}/_folders/${SHARED_FOLDER_NAME}`
        : `${opts.dataDir}/${owner}`;

    for (const [virtualPath, content] of Object.entries(pathToContent)) {
      result.push({ containerPath: `${base}${virtualPath}`, content });
    }
  }

  return result;
}
