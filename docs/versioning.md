# Version and installation notes

LingoTori starts its independent version sequence at **0.0.1**, with no alpha or other prerelease suffix ([issue #62](https://github.com/aittaa/lingo-tori/issues/62)). `package.json` supplies WXT's generated Chrome and Firefox manifest versions and archive filenames. It does not control the stored configuration schema version, which remains unchanged.

## Build and identify a package

Use the Node and pnpm versions in `package.json`, a clean checkout of the reviewed commit, and locked dependencies. Build the two targets sequentially:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm exec wxt prepare
pnpm zip
pnpm zip:firefox
git rev-parse HEAD
git rev-parse HEAD^{tree}
shasum -a 256 .output/lingotoriextension-0.0.1-chrome.zip .output/lingotoriextension-0.0.1-firefox.zip
```

For this baseline, WXT produces `lingotoriextension-0.0.1-chrome.zip` and `lingotoriextension-0.0.1-firefox.zip`; Firefox packaging also produces `lingotoriextension-0.0.1-sources.zip`. Verify each archive's `manifest.json` reports `version: "0.0.1"` and `manifest_version: 3` and has no `version_name` field. Record the full commit and tree SHA, exact filename, SHA-256 checksum, toolchain, and validation limits alongside each shared package. A checksum identifies those archive bytes; it does not establish runtime behavior or a byte-identical rebuild on another machine.

These unsigned developer packages use the existing [temporary installation steps](../README.md#development). They are not store-signed releases. The version change adds no browser capabilities: the baseline Firefox build retains its existing support limits, and separate Firefox BYOS work must be reviewed and built from its own combined commit. Build success alone does not verify live sign-in, inference, clipboard permissions, or preservation of a particular existing profile.

## Existing 1.50.3 developer installations

`0.0.1` is numerically lower than `1.50.3`. Chrome's normal update mechanism only selects a newer version, so this reset is not an automatic upgrade for an installed `1.50.3` package. See [Chrome's version rules](https://developer.chrome.com/docs/extensions/reference/manifest/version).

For an unpacked Chrome installation, keep the same browser profile and existing extension directory, replace its build files, and use **Reload** in `chrome://extensions`. Keep the extension ID and storage identity; loading a new directory can create a separate installation. For a Firefox temporary add-on, update the existing build directory and use **Reload** in `about:debugging`; Firefox reparses its manifest. Temporary add-ons must be loaded again after a browser restart. See [Mozilla's temporary installation guide](https://extensionworkshop.com/documentation/develop/temporary-installation-in-firefox/).

Do not uninstall the existing extension, clear extension storage, reset the profile, or sign out just to change the version. Chrome clears extension storage on removal ([storage documentation](https://developer.chrome.com/docs/extensions/reference/api/storage)); settings exports are not a guarantee that authentication data can be restored. If a packaged installation rejects the lower version or needs reinstalling, pause and arrange an explicit data-preserving migration with the maintainer instead of removing it. This change neither performs a reinstall nor reads, exports, resets, or deletes user settings or authentication data.

## Release metadata

The [0.0.1 archive](releases/0.0.1/README.md) records the pending changes folded into this baseline. Later changesets start from `0.0.1`; this reset must not replay upstream minor bumps. The historical [upstream changelog](../CHANGELOG.md), contributor links, licenses, and notices remain intact. `.changeset/config.json` still targets `main`, versions and tags the private package, and leaves changelog generation disabled. `.github/release.yml` only groups release notes; the manual validation workflow does not publish a release. No release tag or remote publication is created by this reset.
