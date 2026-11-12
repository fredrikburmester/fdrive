import type { SeedFiles } from "./seed-data.js";

export interface SeedFileLayoutOptions {
  /** The folder every home lives under, as `<dataDir>/<owner>`. */
  readonly dataDir: string;
}

export interface SeededFile {
  /** Where the file lives: on disk for a local folder, or inside a container. */
  readonly containerPath: string;
  readonly content: string;
}

/**
 * Maps the SEED_FILES structure (owner -> virtual path -> content) onto
 * absolute paths below `dataDir`, each owner's files under its own home
 * (`dataDir/<owner>/...`): the layout of the local folder. Pure: no
 * filesystem access.
 */
export function seedFileLayout(files: SeedFiles, opts: SeedFileLayoutOptions): SeededFile[] {
  const result: SeededFile[] = [];
  for (const [owner, pathToContent] of Object.entries(files)) {
    for (const [virtualPath, content] of Object.entries(pathToContent)) {
      result.push({ containerPath: `${opts.dataDir}/${owner}${virtualPath}`, content });
    }
  }
  return result;
}
