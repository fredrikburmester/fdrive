import { isOfficePath } from "@fdrive/contracts";
import type { Identity } from "@fdrive/db";
import { z } from "zod";

const ruleSchema = z.strictObject({
  providerId: z.uuid().refine((value) => value === value.toLowerCase()),
  username: z
    .string()
    .min(1)
    .max(255)
    .refine((value) => !/[*?]/.test(value)),
  path: z.string().refine((value) => isOfficePath(value) && !/[*?]/.test(value)),
  recursive: z.boolean(),
  allow: z.boolean(),
});
export type OfficeEditRule = z.infer<typeof ruleSchema>;

/** Trusted operator configuration. No upstream permission inference or wildcard expansion. */
export function parseOfficeEditRules(value: string | undefined): OfficeEditRule[] {
  if (value === undefined) return [];
  if (Buffer.byteLength(value, "utf8") > 128 * 1024) throw new Error("must be at most 128 KiB");
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("must be valid JSON");
  }
  const result = z.array(ruleSchema).max(500).safeParse(parsed);
  if (!result.success) throw new Error("must be an array of at most 500 strict office edit rules");
  return result.data;
}

/** The most specific provider/user/path match wins; a deny wins equally specific ties. */
export function allowsOfficeEdit(
  rules: readonly OfficeEditRule[],
  identity: Pick<Identity, "providerId" | "externalUsername">,
  path: string,
): boolean {
  if (!isOfficePath(path)) return false;
  let specificity = -1;
  let allowed = false;
  for (const rule of rules) {
    if (rule.providerId !== identity.providerId || rule.username !== identity.externalUsername)
      continue;
    if (
      path !== rule.path &&
      !(rule.recursive && (rule.path === "/" || path.startsWith(`${rule.path}/`)))
    )
      continue;
    if (rule.path.length > specificity) {
      specificity = rule.path.length;
      allowed = rule.allow;
    } else if (rule.path.length === specificity && !rule.allow) allowed = false;
  }
  return allowed;
}
