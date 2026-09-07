import { fileURLToPath } from "node:url";
import { createDevEnvironment, officeProduct } from "./dev-env.ts";

const product = officeProduct(process.argv[2]);
const path = fileURLToPath(new URL(`../../.env.office.${product}.dev`, import.meta.url));
const created = await createDevEnvironment(path, product);
console.info(`${created ? "Created" : "Preserved"} ${path}. Secret contents are not printed.`);
