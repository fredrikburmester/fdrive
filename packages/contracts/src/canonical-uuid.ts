import { z } from "zod";

/** Lowercase UUID form generated and accepted by fdrive persistence repositories. */
export const CanonicalUuid = z.uuid().regex(/^[0-9a-f-]+$/);
