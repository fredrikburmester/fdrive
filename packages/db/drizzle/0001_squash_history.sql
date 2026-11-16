-- Brings a database that ran the history the baseline replaced (0000-0047) to
-- what a new install has: the same schema and the same two rows of history.
-- Such a database skips the baseline, whose journal date is the old 0000's; a
-- new install runs the baseline and then this, which finds nothing to do. It
-- runs inside drizzle's migration transaction, so a refusal changes nothing.
DO $$
BEGIN
	-- No drizzle table: these files were applied directly to a new database, as
	-- the indexer's and OCR's tests do.
	IF to_regclass('drizzle.__drizzle_migrations') IS NULL THEN
		RETURN;
	END IF;
	-- A new install: drizzle recorded the baseline, 0000_baseline.sql, just
	-- before this. That file must never change: this hash is its sha256.
	IF EXISTS (
		SELECT 1 FROM "drizzle"."__drizzle_migrations"
		WHERE "hash" = '02b843bf77a5f0fad3adfc6ac986370e91b8e63cc03eb65ac5d528375e0e72d2'
	) THEN
		RETURN;
	END IF;
	-- 0046_trash_items, the last migration v0.7.0-rc.11 ran.
	IF NOT EXISTS (
		SELECT 1 FROM "drizzle"."__drizzle_migrations"
		WHERE "hash" = '90eb50dd1fac64435339ee01bc01f505d833b52342acc83a31febf3906b1515e'
	) THEN
		RAISE EXCEPTION 'fdrive cannot upgrade this database: it is older than v0.7.0-rc.11'
			USING HINT = 'Start fdrive v0.7.0-rc.11 on it once, then this release.';
	END IF;
	-- What 0047_drop_desktop_original_path did, for a database rc.11 left.
	ALTER TABLE "app"."desktop_items" DROP COLUMN IF EXISTS "original_path";
	-- The old history's rows give way to the baseline's, with the old 0000's date.
	DELETE FROM "drizzle"."__drizzle_migrations" WHERE "hash" IN (
		'f968a4ff1812958b61a1db4512a5a15e6a8bda901618ffc5a11617b28818dab7', -- 0000_init
		'c34a0cedacf22e32de2c3af7cf2951bed27de47f4f7adf65d5bfd487468b02af', -- 0001_storage_providers
		'7906cb106c46208c14149f29ab3b5527189dac6bba829ed041f328ad605345c7', -- 0002_foreign_key_indexes
		'698addc7a8577ecbeeddde9cf9a527f50400542306389e4b0fde2765cc276985', -- 0003_index_query_hot_paths
		'10f9578c7f024e6213b9f66e6f7dca3b7d3cc0248e5e1494a0db6cc2c9e607f0', -- 0004_mcp_token_access
		'd9885ab12c829bacda3cfc85d84a3968e64eecde764f013fd1c36fecee5a192a', -- 0005_synchronize_declared_indexes
		'de32512b2fdbdb6a7c76e2b8bbed44cf1322fd2a0789040e417745400beb4493', -- 0006_processing_failures
		'680df42979ce71cd1b1b035b4e69aeb4449e71c51c75cba71e1528714b3e009a', -- 0007_desktop_writes
		'51f09e66492eeeb600ebc50ce10cf516057474b2f890dfe038705f08223df953', -- 0008_desktop_operation_account_index
		'2791ce12c252f64ca0f904c9da1f2c0997721281f07e542a12b3580d4183ceb9', -- 0009_desktop_metadata_recovery
		'718dbd041604acb100041ac5a916f703a36fd3594038239a02035db3b134e5d3', -- 0010_heavy_wolfpack
		'5452755c96c9af4109ecf9c9d955cd53913093c0f9bb0e12d7d999450b96328c', -- 0011_same_magdalene
		'1d2a4091ab413e5ff24d0016966f87acd6f288b2b9c91e6d19d25bd09e752c15', -- 0012_known_sentinel
		'c5f1dc07dd35b6e5da4d8c16875a99461d21b7feccba993c030fec6840198cd9', -- 0013_folder_view_sort
		'053fd7bbcf9f6cca5bc58a988ba3f7ce05b128f968691115ec7dec6f83a962c4', -- 0014_owned_shares
		'729100ae62764984518232e39c2a65a96cc0ccef0839fa500d7790322069e04f', -- 0015_ai_chats
		'335678936c3fb720419ab25e9a404457f863325dfd74ab8c5df9c10652fe2ee7', -- 0016_personal_activity
		'11996167b567e2942da67c7525a688ff78710efc77fb6ccdf57b5a5bfaaceccd', -- 0017_local_storage
		'626b17cc34d6bfb599d64431ec2ebcfbabebfb841998e7c835b184735d6152b9', -- 0018_local_grants
		'd08b55d93afd7d1c5d6ede84670f4fac672c9753e40f65595279265181b218cc', -- 0019_remove_webdav_and_s3
		'c94916248e651cd58d6c7de15f20f1b30c57119e0fad610ec5067e1538d4a334', -- 0020_index_root_upgrade
		'2b5455ddf322619defdbd91aa023376501bf96e6f9c7f31414c34807156ad4f3', -- 0021_drop_trash_binding_strategy
		'2cf4780728ead68256b2bc1816d3fa323ea38253361afbf57b2e49aec01ffee7', -- 0022_index_work
		'e57f0748462be7fe5e85623066e22f4057c3b12a3cf88adeba3d2017d497d364', -- 0023_index_folders
		'ef47c821331d5e7a3a0bc5141c172af05626e087c4d1f04757ad7419eaa7fa5b', -- 0024_change_journal
		'4011de5acc99deaa7968e0a677ef268b79999719a4c146885402bc40ebc9d921', -- 0025_change_epoch
		'7e8164de2754cac92f051590e67d70ab61a99ad92ffa405a8626d628111647b3', -- 0026_index_file_stamp
		'2c3410b571b799252f491d8d9aa38c92059097a50fab97bbc657a8f672a41703', -- 0027_drop_index_events
		'849b2c0010d96361324d9cce6fe01c8cd66ae4911f9eacd037e2e5bc99731183', -- 0028_ocr_log_sha256
		'2ae94061525d6c0e3973eca922288708523e0caf19577b9f91fbcc112dbf33d8', -- 0029_one_login_per_account
		'211d7371f6bc89d61f878f6124405bfbcd56b69bca0e45c149f41f4921c7dc28', -- 0030_drop_legacy_tokens_and_moves
		'737e972536a01e41af7061ad63e0556a45863881ce848e8b2b9438d2169093a3', -- 0031_drop_desktop_effects
		'b9a0fbda898bc6214c6309e906ed8cada1c5fd88a08fd944761d25ed5a593080', -- 0032_change_previous_ctime
		'f7f1fd56736a1509c29f0e53262ab88c3bf728c7fee4ece2909613e5dc80a7a9', -- 0033_local_passwords
		'e962aface927711e7685f2e447e15bbc0f8d1bc18db786c6070a5f3da78ad3c7', -- 0034_activity_without_provider_values
		'508efb0f80a4b6f2860a8e01e9884b1c8b21e05c22038a7ee5899accfda65f00', -- 0035_office_files_by_owner
		'f3baec421f50990792e0878a55dd7786050696318ee936cb3dca1f759a95e804', -- 0036_backups_s3_only
		'90df9e8b599eb86e92c8200acaf4e510f528d2b526d6cccaab24f9f86432d7c6', -- 0037_saved_searches
		'b66753c6a47c233f9328b53025f57e26a66e9592ce3b382ffbc03ff52a54c60c', -- 0038_photo_details
		'856e0a9d146dee4731008d5df0bd693d050ea17b2de598d3e083a5c139fee25e', -- 0039_trash_leaf_required
		'600a6f5429bc1242c86be1f682524552fc9de691dd1bcc21a91f0a219fa9549d', -- 0040_index_root_files
		'71d3bdfd2ad71873883791f2c1aa02e16fc6108708180389ca65c8a658d180b8', -- 0041_drop_schema_version
		'16f0957e2ae2e11ecd7743b83fcffe8a23ab68c9bc4c5aad55d0e67ab323dd22', -- 0042_local_user_storage_limit
		'efe291eeca3cb985821a8f3f0cff012381a1e2508d7a2d64ab2bba1795dbbb21', -- 0043_index_hard_delete
		'810dd169efc4abcad69b2bd114d26cab16b8ec9acdd4ede4ac046f42b5f772ff', -- 0044_share_columns
		'a208bd45e7aa18c979496047d6bc3052c300c0a9fbb54f1eabcdf81a5e187c44', -- 0045_drop_providers
		'90eb50dd1fac64435339ee01bc01f505d833b52342acc83a31febf3906b1515e', -- 0046_trash_items
		'afdc5e796d4c3d9f19ac96748dc8b471ac2b5c20c32a87cb3e1221a14bf187b7' -- 0047_drop_desktop_original_path
	);
	IF EXISTS (SELECT 1 FROM "drizzle"."__drizzle_migrations") THEN
		RAISE EXCEPTION 'fdrive cannot upgrade this database: its migration history has entries no fdrive release wrote';
	END IF;
	INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at")
	VALUES ('02b843bf77a5f0fad3adfc6ac986370e91b8e63cc03eb65ac5d528375e0e72d2', 1789074251698);
END
$$;
