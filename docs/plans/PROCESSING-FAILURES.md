# Processing failure transparency

Accepted 2026-09-13. The thumbnail sidebar can report hundreds of shared scan errors
while its Logs sheet contains only API requests. Worker stderr/stdout is container-local.

Implementation is present in the checkout. Application, native database/indexer regressions
and the real worker/browser recovery path pass. Required Docker coverage/inotify, full
integration and standard browser setup remain blocked by the unavailable Docker engine.
See [current evidence](../workflow/STATUS.md#processing-failure-transparency-implemented-docker-verification-pending).

## Delivery

- Persist one current failure per index root, relative file path and processing feature
  (thumbnails, text extraction, semantic embeddings, image embeddings). Store cause,
  message, operation ID, first/last failure, failed attempts and resolution time.
- Success resolves an existing failure; repeated failures update it without flooding history.
  Keep unresolved failures; prune resolved records after 30 days and cap resolved history
  at 10,000 records. Deleted files resolve their issues. Existing lost logs are not recoverable.
- Record actual stage outcomes for scans, watcher processing and explicit rebuilds. A
  downstream failure must not increment an upstream feature's error count. Policy skips
  and service backoff are distinguished from failures.
- Admin-only failure lists remain readable while workers are stopped. Show grouped causes,
  file/root, reason, attempts and timestamps, with unresolved/resolved filters and stable
  pagination. Link feature failures from the existing Logs sheet and page error count.
- Retry unresolved files in a bounded background pass using existing maintenance admission;
  retry only the selected feature, recheck feature enablement and root containment. Preserve
  failures when retry is interrupted; successful retries resolve them.
- Include persisted failures in existing subsystem logs. Keep indexer diagnostic output in a
  rotating file on a persistent deployment volume as well as stdout, surviving replacement.

## Verification

Exercise a corrupt image through worker, PostgreSQL, API and browser; restart the worker,
confirm details remain, repair it, retry and confirm resolution. Cover mixed-stage failures,
backend waiting, duplicate paths across roots, pagination ties, authorization, retention,
disabled/busy retries and missing/symlinked files. Run application, integration, indexer Python,
affected browser and workflow gates; inspect narrow and desktop UI in a live dev app.
