// Criterion 4 of KYB-618, executed rather than deferred to a tagged release.
//
// The property under test is that a version carrying a SemVer PRE-RELEASE
// suffix (0.6.0-beta.1) interpolates into build.win.artifactName as a
// well-formed, space-free, URL-safe installer filename — and that SemVer BUILD
// METADATA (a `+`) is the one form that would not.
//
// It is mocked at the only boundary that needs a real release: the version
// string. Everything else is the shipped implementation —
// app-builder-lib's own expandMacro and builder-util's own getArtifactArchName,
// reached through the same call shape PlatformPackager.computeArtifactName
// uses, driven by the artifactName template read out of package.json. So this
// is not a restatement of the template; it fails if the template changes
// shape, if electron-builder changes how it expands macros, or if either stops
// agreeing with the derivation release-win asserts against.
//
// What it does NOT cover: NSIS actually writing a file with that name. Only a
// real packaging run produces that, and the installed-mode UAT observes it.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const require = createRequire(import.meta.url)
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))

// Resolve app-builder-lib from electron-builder's own location rather than from
// here, so the test does not depend on how npm happened to hoist a transitive
// dependency.
const fromElectronBuilder = createRequire(require.resolve('electron-builder/package.json'))
const { expandMacro } = fromElectronBuilder('app-builder-lib/out/util/macroExpander.js')
const { getCompleteExtname } = fromElectronBuilder('app-builder-lib/out/util/filename.js')
const { Arch, getArtifactArchName } = fromElectronBuilder('builder-util/out/arch.js')

const template = pkg.build.win.artifactName

/** The shape PlatformPackager.computeArtifactName() uses: expandMacro(pattern, getArtifactArchName(arch, ext), appInfo, { os, ext }). */
function expandWinArtifactName(version, arch = Arch.x64, ext = 'exe') {
  const appInfo = {
    version,
    name: pkg.name,
    productName: pkg.build.productName,
    sanitizedProductName: pkg.build.productName,
    channel: null,
    companyName: null
  }
  return expandMacro(template, getArtifactArchName(arch, ext), appInfo, { os: 'win', ext })
}

/** The substitution release-win's assertion step performs in `node -p`. If this ever stops matching the real expander, that assertion is comparing against the wrong expectation. */
function expandAsReleaseWinDoes(version, arch = 'x64', ext = 'exe') {
  return template
    .replaceAll('${version}', version)
    .replaceAll('${arch}', arch)
    .replaceAll('${ext}', ext)
}

test('build.win.artifactName is set, and explicitly carries ${arch}', () => {
  // Non-empty is what makes the pattern "user forced" in
  // artifactPatternConfig(), which is in turn why expandArtifactNamePattern()
  // does NOT null the arch for the default architecture. Without it, x64 would
  // have `-${arch}` stripped out of the name entirely.
  assert.ok(typeof template === 'string' && template.length > 0, 'build.win.artifactName must be set')
  assert.ok(template.includes('${arch}'), 'template must carry ${arch} explicitly')
  assert.ok(!/\s/.test(template.replace(/\$\{[^}]+\}/g, '')), 'the literal parts of the template must be space-free — see KYB-607')
})

test('Windows x64 keeps the arch name "x64"', () => {
  // Unlike .deb (amd64) or AppImage (x86_64). Pinned because the name the feed
  // declares and the name release-win asserts both depend on it.
  assert.equal(getArtifactArchName(Arch.x64, 'exe'), 'x64')
})

test('a pre-release version produces a well-formed installer name', () => {
  for (const version of ['0.6.0-beta.1', '1.0.0-rc.2', '0.6.0-alpha.0', pkg.version, '0.6.0']) {
    const name = expandWinArtifactName(version)

    assert.ok(!name.includes('${'), `${version}: an unexpanded macro survived: ${name}`)
    assert.ok(!/\s/.test(name), `${version}: name contains whitespace: ${name}`)
    assert.ok(name.includes(version), `${version}: version missing from name: ${name}`)
    assert.equal(getCompleteExtname(name), '.exe', `${version}: not a single .exe extension: ${name}`)

    // URL-safe, because this name becomes a path segment in latest.yml that
    // electron-updater resolves against the release URL. A name that changes
    // under URL encoding is the KYB-607 failure in a different coat: the feed
    // and the asset would no longer resolve to each other.
    assert.equal(encodeURIComponent(name), name, `${version}: name is not URL-safe: ${name}`)

    // The real expander and release-win's `node -p` substitution must agree,
    // or that assertion is checking the built file against the wrong string.
    assert.equal(name, expandAsReleaseWinDoes(version), `${version}: release-win's derivation disagrees with electron-builder's expander`)
  }
})

test('0.6.0-beta.1 interpolates to exactly the expected filename', () => {
  assert.equal(expandWinArtifactName('0.6.0-beta.1'), 'KYBER-Studio-0.6.0-beta.1-win-x64.exe')
})

test('SemVer build metadata is the form that would break the name, and is not in use', () => {
  // The negative control for the claim on KYB-618. `+` is legal in a filename
  // and survives expansion untouched, so nothing in the build would complain —
  // it breaks at URL resolution, where `+` is decoded as a space.
  const withMetadata = expandWinArtifactName('0.6.0+build.5')
  assert.ok(withMetadata.includes('+'), `expected the + to survive expansion: ${withMetadata}`)
  assert.notEqual(encodeURIComponent(withMetadata), withMetadata, 'build metadata should NOT be URL-safe — if this passes, the claim on KYB-618 needs revisiting')

  // And the guard that keeps the claim true: our own version carries none.
  assert.ok(!pkg.version.includes('+'), `package.json version must not carry build metadata: ${pkg.version}`)
})
