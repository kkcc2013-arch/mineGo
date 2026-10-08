# Notification storage, routes and client acceptance

The production notification service uses the existing UUID user and SERIAL history
identities. The 20261008_160000 bridge preserves the original relation, ID/sequence,
`type`, JSON data and legacy read values. A generated canonical notification_type
maps supported old aliases; title/body copy only actual JSON strings. Unknown old
read timestamps remain unknown. Nine canonical types cover seven game notifications
plus system and trade. Unsupported legacy types fail with an explicit reconciliation
requirement. Legacy boolean and modern JSON preferences share actual persisted values.

History is capped at 50 for each recipient, ordered by creation time and ID. The
original cleanup used a global offset that could delete other recipients' history;
its checksummed whole repair now ranks each owner independently. Stable event IDs
use an owner/type/event receipt and unique history index. Deleting a history entry or
retaining only 50 does not recreate it on replay: receipts remain for 90 days. Events
without a source identity are not deduplicated. Storage commits before delivery;
durable outbox, retries after a committed delivery failure and multi-instance socket
routing still need implementation. Successful storage is not claimed as provider delivery.

An unused bridge can reverse while preserving original OID/data. Existing event
receipts or actual modern title/body/read/event metadata explicitly block lossy down.
A data-preserving reverse plan is required for those records. Raw published SQL files
remain unchanged; repairs are bound to complete original-source SHA256 values.

User-service mounts the actual eight message-center operations once at /notifications:
list, unread count, single read, batch/all read, delete, clear-read, stats and preferences.
Gateway exposes /api/notifications, /api/v1/notifications, /api/v2/notifications,
/v1/notifications and /notifications aliases. Legacy preference GET/PUT stays available
at /v1/users/me/notification-preferences. Device-token API validates platform/token and
returns registration state without exposing token values. Production controllers enforce
verified normalized user identity; all read/update/delete SQL is owner-scoped. The old
REQ-00120 Bearer test string correctly returns401; positive checks use a signed fixture JWT.

The actual /ws/notifications upgrade verifies UUID JWT and IP policy before acceptance.
Gateway replaces caller forwarding headers with the resolved trusted client address.
Native tests publish seven real Kafka events and observe authenticated gateway frames,
actual history IDs, replay behavior and active-socket closure on SIGINT/SIGTERM. Socket
cleanup precedes HTTP draining through an owned lifecycle hook. Those process tests use
real user/gateway/Redis/Kafka/PostgreSQL; other service registry peers alias the user
fixture and do not prove seven additional services.

The real browser fixture runs the production MessageCenter and NotificationManager
against the production controllers/storage. Numeric IDs, hostile HTML, zero latitude,
read failures, realtime history identity, authoritative unread badges and owner-isolated
IndexedDB caches are exercised. Offline category filtering/pagination uses only that
user's cached messages. A missing getCurrentLocale export previously prevented the
realtime module loading; the actual language getter is now exported. This is component
acceptance, not full game integration. Detail/actions, all navigation, preference UI,
reconnect/incremental synchronization, accessibility and true virtual scrolling remain.
No FPS60/1000-message, <200ms realtime, <500ms navigation, cache/first-load latency,
provider reach/retention or satisfaction target has been accepted without measurement.

## Reproduce local checks

Use Node24 and an isolated PostGIS database through TEST_DATABASE_URL. Run:

- node --test backend/tests/regression/notification-storage.test.js (35 actual checks).
- node --test backend/tests/regression/notification-client.test.js (10 Chromium checks).
  Install the declared frontend dependencies and Playwright Chromium first; optionally
  set PLAYWRIGHT_CHROMIUM_EXECUTABLE to a compatible installed Chromium executable.
- Native user/gateway process suites additionally require isolated Redis and Kafka;
  see their documented fixture environment in backend/tests/regression/*-startup.test.js.
- npm test --prefix backend (623 checks including actual lifecycle regressions).
- node --test backend/tests/regression/database-bootstrap.test.js (full history gate).

Combined migration/CLI/prerequisite/audit/achievement/notification storage:114 pass.
Privacy/title/IP/native business:35 pass. Syntax1420 files passes. Full V1/V2 loads;
all84 pending migrations still fail at 20260611_131000 statement20, because the actual
friendship table lacks pokemon_instance_id. All pending SQL rolls back. Canonical
species key lookups and canary partial-index syntax are repaired, but the sample catalog
lacks some intended evolution targets; zero seed rows is not evolution acceptance.
Notification storage/client workflows retain these limits and must pass on the new
commit. FCM/APNs, full-history rollback, all-service startup and complete658 acceptance
remain open. No production migration or deployment is performed.
