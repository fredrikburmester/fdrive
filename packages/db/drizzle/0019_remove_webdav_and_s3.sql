-- WebDAV and S3 storage are gone: the files folder is the only storage. Their
-- rows stay, since logins and everything keyed by them reference them, but
-- they are switched off and no longer pinned. Their logins already vanish
-- from sign-in, since no module serves the type.
UPDATE "app"."providers" SET "enabled" = false, "managed_by_env" = false WHERE "type" IN ('webdav', 's3');
