import { z } from "zod";
import { HttpUrl } from "./http-url.ts";

/**
 * Every storage backend fdrive can talk to. The API's provider registry
 * must have a module for each value; adding a provider adds one here and
 * one there.
 */
export const ProviderType = z.enum(["sftpgo", "webdav", "s3"]);
export type ProviderType = z.infer<typeof ProviderType>;

/**
 * What one linked login's storage can do, as the web reads it. Every route
 * that depends on a flag refuses with `unsupported` when it is false, so a
 * stale client cannot bypass the hidden control.
 */
export const ProviderCapabilities = z.object({
  /** Download as zip, folder entries in a multi-download. */
  zip: z.boolean(),
  /** Uploads keep the file's original modification time. */
  setModifiedAt: z.boolean(),
  /** Rename and move are single operations; false means copy then delete. */
  atomicMove: z.boolean(),
  /** A recycle folder is available for this login. */
  trash: z.boolean(),
  /** This login can create public shares. */
  shares: z.boolean(),
  /** Office viewing and editing can apply to this login's files. */
  office: z.boolean(),
  /** Search, thumbnails and folder size can apply to this login. */
  index: z.boolean(),
  /** Virtual folder mapping (the identity scope card) applies to this login. */
  scopeMapping: z.boolean(),
});
export type ProviderCapabilities = z.infer<typeof ProviderCapabilities>;

export const ProviderFieldKind = z.enum(["text", "password", "otp", "url"]);
export type ProviderFieldKind = z.infer<typeof ProviderFieldKind>;

/** One form field of a provider's configuration or credential; rendered by the web as is. */
export const ProviderField = z.object({
  name: z.string().min(1).max(64),
  label: z.string().min(1).max(120),
  kind: ProviderFieldKind,
  required: z.boolean(),
  help: z.string().max(400).optional(),
  maxLength: z.number().int().positive().optional(),
  /** Never stored (a one-time code). */
  transient: z.boolean().optional(),
});
export type ProviderField = z.infer<typeof ProviderField>;

/** A credential or configuration as submitted from a form: field name to value. */
export const ProviderFieldValues = z.record(z.string().min(1).max(64), z.string().max(4096));
export type ProviderFieldValues = z.infer<typeof ProviderFieldValues>;

/**
 * A provider as the login page sees it: enough to render its credential
 * form, nothing about where it is. Returned by the public
 * `GET /api/v1/providers` for enabled providers only.
 */
export const PublicProvider = z.object({
  id: z.uuid(),
  type: ProviderType,
  label: z.string(),
  credentialFields: z.array(ProviderField),
});
export type PublicProvider = z.infer<typeof PublicProvider>;

export const ProvidersResponse = z.object({
  providers: z.array(PublicProvider),
});
export type ProvidersResponse = z.infer<typeof ProvidersResponse>;

/** A provider type an administrator can add, with the form it needs. */
export const AdminProviderType = z.object({
  type: ProviderType,
  label: z.string(),
  configFields: z.array(ProviderField),
  credentialFields: z.array(ProviderField),
  capabilities: ProviderCapabilities,
});
export type AdminProviderType = z.infer<typeof AdminProviderType>;

/** One configured provider as `GET /api/v1/admin/providers` lists it. */
export const AdminProvider = z.object({
  id: z.uuid(),
  type: ProviderType,
  label: z.string(),
  baseUrl: HttpUrl,
  config: ProviderFieldValues,
  enabled: z.boolean(),
  /** True when the endpoint is pinned by environment (`SFTPGO_URL`) and cannot change here. */
  managedByEnv: z.boolean(),
  /** How many logins across every account use this provider. */
  identityCount: z.number().int().min(0),
  /** Result of probing the endpoint when this view was built. */
  reachable: z.boolean(),
  checkedAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
});
export type AdminProvider = z.infer<typeof AdminProvider>;

export const AdminProvidersResponse = z.object({
  providers: z.array(AdminProvider),
  types: z.array(AdminProviderType),
});
export type AdminProvidersResponse = z.infer<typeof AdminProvidersResponse>;

/** One administrator-managed display name, shared by this provider's logins. */
export const ProviderName = z
  .string()
  .trim()
  .min(1, "Enter a name for this storage.")
  .max(120, "Use 120 characters or fewer for the storage name.");

export const AdminProviderCreateRequest = z.strictObject({
  type: ProviderType,
  label: ProviderName,
  baseUrl: HttpUrl,
  config: ProviderFieldValues.optional(),
});
export type AdminProviderCreateRequest = z.infer<typeof AdminProviderCreateRequest>;

/** Partial update; `baseUrl` is refused with `forbidden` for an env-managed provider. */
export const AdminProviderUpdateRequest = AdminProviderCreateRequest.omit({ type: true })
  .partial()
  .extend({ enabled: z.boolean().optional() });
export type AdminProviderUpdateRequest = z.infer<typeof AdminProviderUpdateRequest>;

/**
 * Body for `POST /api/v1/admin/providers/test`: probe an unsaved candidate.
 * Probing a saved provider uses `POST /api/v1/admin/providers/:id/test`
 * with no body.
 */
export const AdminProviderTestRequest = AdminProviderCreateRequest.omit({ label: true });
export type AdminProviderTestRequest = z.infer<typeof AdminProviderTestRequest>;
