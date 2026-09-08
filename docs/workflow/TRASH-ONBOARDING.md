# Trash in onboarding

User request: include Trash alongside the six processing choices. Repository work only;
no access to a deployment server or live owner SFTPGo.

- Keep the six processing settings/worker contract unchanged. Add a seventh choice, Trash,
  immediately before review: three claim/connection/account steps, six processing choices,
  Trash, review (11 total). Persist progress and allow skip/all-off.
- Store Trash settings in the database and apply them without restart. Use an administrator-
  only GET/PUT `/api/v1/system/trash` with revision conflict protection. Defaults: disabled,
  path `/.trash`, retentionHours null, rulesConfirmed false. Settings bind to the active
  immutable SFTPGo provider so switching providers cannot reuse a rule confirmation.
- Contract: `TrashSettings` and `TrashSettingsUpdateRequest` contain providerId (active immutable provider ID), revision (nonnegative
  integer), enabled (boolean), path (normalized absolute directory other than `/`),
  retentionHours (positive integer or null), rulesConfirmed (boolean). Enabling requires
  rulesConfirmed. `apiClient.systemTrash()` / `systemUpdateTrash(input)` use these types.
- This configures fdrive's existing SFTPGo recycle-bin integration, not a new deletion engine.
  Explain that SFTPGo's pre-delete rule must already exist and be tested; fdrive cannot prove
  that from a file-user login. Never request WebAdmin credentials or silently create rules.
  Retention is informational and is enforced only by an external SFTPGo schedule.
- UI exposes Enable Trash, folder, optional retention, and explicit rule confirmation.
  Skipping does not delete retained files or change SFTPGo rules. Keep settings accessible
  under System > Features after onboarding. Review includes the saved Trash choice.
- All consumers must use current settings consistently: storage capabilities, list/search/
  MCP exclusions, folder sizes, trash endpoints and deletion metadata. Missing settings leave
  integration off. No legacy environment activation fallback or data migration.
- Preserve authorization, provider binding, failed-move/delete behavior, restore conflicts,
  and permanent purge semantics. Test enable/disable live without restart and provider changes.

Validation: application, integration, affected browser and real dev UI, workflow; contracts
and runtime behavior tests. Use fixtures only. Existing processing worker lifecycle is unchanged.
