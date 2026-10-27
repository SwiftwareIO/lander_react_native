# Releasing react-native-lander

Develop the SDK in the private Lander monorepo at `sdk/lander_react_native`. Its public mirror is [SwiftwareIO/lander_react_native](https://github.com/SwiftwareIO/lander_react_native). Never edit the mirror directly.

## Publishing flow

1. The private `.github/workflows/sdk-react-native-release.yml` mirrors SDK changes to the public repository on `main`.
2. A private `react-native-vX.Y.Z` tag validates the version, ancestry, changelog, typecheck, tests and build, then pushes `vX.Y.Z` to the public mirror.
3. The mirror's `.github/workflows/npm-release.yml` validates and builds the tagged source, then publishes through npm trusted publishing with provenance. It requires no npm access token.

The public workflow is maintained at `sdk/lander_react_native/.github/workflows/npm-release.yml` in the monorepo. Keeping publication in the public mirror makes the npm repository URL match the workflow repository and allows provenance to identify the public source commit.

## One-time setup

The private repository needs `SDK_MIRROR_REACT_NATIVE_DEPLOY_KEY`, the private half of a write deploy key scoped to the public mirror.

In npm, open **react-native-lander > Settings > Trusted publishing** and configure:

- Provider: GitHub Actions
- Organization or user: `SwiftwareIO`
- Repository: `lander_react_native`
- Workflow filename: `npm-release.yml`
- Environment: leave empty
- Allow direct publication with `npm publish`

Complete the first trusted publish within two days of saving the configuration. After a successful trusted publish, revoke the bootstrap npm token and remove `NPM_TOKEN` from the private repository. Neither release workflow uses that secret.

## Each release

1. On a branch from current `origin/main`, update:
   - `version` in `package.json` and both root version fields in `package-lock.json`;
   - `landerSdkVersion` in `src/version.ts`;
   - `CHANGELOG.md`;
   - the version and changelog in `apps/docs/content/docs/react-native`.
2. Run `npm ci`, `npm run typecheck`, `npm test -- --ci`, `npm run build`, and `npm pack --dry-run` in the SDK directory.
3. Open and merge the release PR. Wait for the mirror push to succeed.
4. Tag the merged main commit `react-native-vX.Y.Z` and push that tag to the private repository.
5. Check both release runs, the npm version, provenance, tarball contents and the mirror's `vX.Y.Z` tag.

A successful private tag push alone does not prove publication: the public **Publish React Native SDK** run must also succeed. Published versions cannot be overwritten. If a publish fails before creating the version, rerun the public workflow against its existing version tag. For a code fix, create a new patch release.
