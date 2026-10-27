# Releasing react-native-lander

The SDK is developed in the private Lander monorepo at `sdk/lander_react_native`. Two jobs in `.github/workflows/sdk-react-native-release.yml` take it public:

- **mirror**: every push to `main` that touches `sdk/lander_react_native/**` (or a manual run) pushes the folder, with its history, to the public mirror [github.com/SwiftwareIO/lander_react_native](https://github.com/SwiftwareIO/lander_react_native) on `main`. The mirror is read only. Never commit to it directly; the next push would overwrite it.
- **release**: a monorepo tag `react-native-vX.Y.Z` checks the version, runs typecheck, tests and the build, publishes `react-native-lander@X.Y.Z` to npm and pushes tag `vX.Y.Z` to the mirror (the podspec's `source` points at that tag).

Each step that needs a secret is skipped with a notice when the secret is missing, so the workflow is safe to merge before the setup below is done.

## One-time setup

1. **Mirror deploy key.** Create a key pair without a passphrase:

   ```bash
   ssh-keygen -t ed25519 -N '' -C 'lander monorepo -> lander_react_native' -f lander_react_native_mirror
   ```

   Add `lander_react_native_mirror.pub` as a deploy key with **write access** on `SwiftwareIO/lander_react_native` (Settings > Deploy keys). Save the private key `lander_react_native_mirror` as the Actions secret `SDK_MIRROR_REACT_NATIVE_DEPLOY_KEY` on `SwiftwareIO/lander` (Settings > Secrets and variables > Actions). Delete both files afterwards.

2. **npm owner.** Use an npm account or organization that owns the `react-native-lander` name (the first publish claims it). Turn on two factor authentication for the account.

3. **npm token.** Create a granular access token on npmjs.com (Access Tokens > Generate New Token > Granular Access Token) with **Read and write** permission on packages, limited to `react-native-lander` once it exists (for the very first publish, scope it to all packages of the owner, then replace it with a narrower one). Give it an expiry and a reminder to rotate it. Save it as the Actions secret `NPM_TOKEN` on `SwiftwareIO/lander`.

4. Merge a change to `main` (or run the workflow by hand from the Actions tab) once, so the mirror's `main` exists before the first release.

### Why there is no provenance or trusted publishing

npm provenance (`npm publish --provenance`) and trusted publishing (OIDC from GitHub Actions, no token) both require the workflow to run in a **public** repository, because npm links the package to the source commit. The monorepo is private, so the workflow publishes with `NPM_TOKEN` and without `--provenance`. If the source ever moves to a public repository (for example by building and publishing from the mirror itself), switch to trusted publishing: add the repository and workflow as a trusted publisher in the package settings on npmjs.com, give the job `permissions: id-token: write`, publish with `npm publish --provenance --access public`, and delete `NPM_TOKEN`.

## Each release

1. On a branch, bump the version in three places and describe the release:
   - `version` in `package.json` (the podspec reads it from there),
   - `landerSdkVersion` in `src/version.ts` (sent to the API as `sdkVersion`),
   - a `## X.Y.Z` heading at the top of `CHANGELOG.md`,
   - and the docs: `apps/docs/content/docs/react-native/changelog.mdx` and the version on `index.mdx`.
2. Check locally:

   ```bash
   cd sdk/lander_react_native
   npm ci && npm run typecheck && npm test && npm run build
   npm publish --dry-run
   ```

3. Open a pull request and merge it to `main`. The mirror job pushes the change to the mirror.
4. Tag the merge commit on `main` and push the tag:

   ```bash
   git checkout main && git pull
   git tag react-native-vX.Y.Z
   git push origin react-native-vX.Y.Z
   ```

5. Watch the **React Native SDK release** run. It fails before publishing if the tag does not match `package.json`, `src/version.ts` and a `CHANGELOG.md` heading, or if the tagged commit is not on `main`. Re-running it after a failure is safe: a version that is already on npm is not published again, and the mirror tag is pushed afterwards.
6. Check [npmjs.com/package/react-native-lander](https://www.npmjs.com/package/react-native-lander) and the `vX.Y.Z` tag on the mirror.

Published versions cannot be overwritten. Within 72 hours `npm unpublish react-native-lander@X.Y.Z` is possible (if nothing depends on it); otherwise deprecate it with `npm deprecate react-native-lander@X.Y.Z "reason"` and publish a fix.
