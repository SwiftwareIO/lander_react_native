## 0.1.1

* Publish from the public SDK mirror using npm trusted publishing and verifiable provenance.
* Remove the bootstrap publishing token from the release path.
* SDK behavior is unchanged.

## 0.1.0

First release, with the behavior of `lander_flutter` 0.3.0.

* `Lander.initialize`: publishable key check (secret and malformed keys reject with `invalid_argument`, the key is never echoed), random install ID stored outside backups, `POST /v1/sdk/init` in the background on every launch with `isFirstLaunch`, Play Install Referrer on Android first launch, a fresh install ID on `install_id_conflict`. Never rejects because of the network. A failed first launch report is retried when the app becomes active, before `claimHandoff`, before queued events are sent, and on the next launch.
* `Lander.onDeepLink` and `useLanderDeepLink`: Universal Links, App Links and custom scheme URLs on cold and warm start, resolved through `POST /v1/sdk/resolve`. Links are buffered until the app listens, delivered in arrival order, the launch link is delivered exactly once, and duplicates within 2 seconds count once. Unknown links (404) and network failures still deliver the raw URL. Custom scheme URLs carrying `lander_link` resolve that link.
* `Lander.getInitialLink`: the launch link or a deferred link (a launch link wins), once.
* Deferred links with `isDeferred`, `confidence` and `method`.
* `Lander.claimHandoff`: authenticated handoff after sign in, with one `Idempotency-Key` across retries.
* `Lander.createLink`: short links from the app via `POST /v1/sdk/links`.
* `Lander.trackEvent`: persistent offline queue, batches of up to 100, exponential backoff with jitter and `Retry-After`, client generated event IDs, flush when the app goes to the background, held until the install is registered.
* Request timeouts (10 s), retries with the same `Idempotency-Key`, at most 10 seconds of waiting per call, `LanderError` with `code`, `message`, `statusCode`, `retryAfter` and `isRetryable`.
* Android (Kotlin): launch intent once per activity (ignoring Recents replays and activities restored after process death), `onNewIntent`, Play Install Referrer, storage in `noBackupFilesDir`.
* iOS (Swift): links through React Native's `Linking`, storage in Application Support excluded from backups, privacy manifest.
* Expo config plugin for Associated Domains, the App Links intent filter and a custom scheme.
* Example app: Acme Shop.
