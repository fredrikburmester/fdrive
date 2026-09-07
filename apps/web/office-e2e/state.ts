import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { OfficeProduct } from "./fixture-config";
export interface OfficeFixtureState {
  product: OfficeProduct;
  webUrl: string;
  apiUrl: string;
  officeUrl: string;
  officeContainer: string;
  sftpgoUrl: string;
  sftpgoContainer: string;
  directory: string;
}
export async function fixtureState(
  directory = process.env.E2E_STATE_DIR,
): Promise<OfficeFixtureState> {
  if (!directory) throw new Error("Office fixture was not started");
  return JSON.parse(await readFile(join(directory, "office.json"), "utf8")) as OfficeFixtureState;
}
