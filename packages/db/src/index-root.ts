/**
 * The files folder's row in `idx.roots`, its only one: a migration seeds
 * it, so it exists before anything reads or writes the index. The indexer
 * and OCR read the folder at `/data`.
 */
export const INDEX_ROOT_ID = 1;
export const INDEX_ROOT_NAME = "files";
