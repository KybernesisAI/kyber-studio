---
name: verify
description: "How to verify a change to KYBER Studio (the Electron desktop app) before it merges: both typechecks, the build, the test suite, then the running app with the change exercised and screenshotted. Releases are separate (the kyber-studio-release skill) and wait for Ian's local test."
---

# Verifying KYBER Studio

Done means the change works in the running app, not only in the tests.

## 1. Checks (all must pass, same as CI)

```bash
npm ci --no-audit --no-fund
npx tsc --noEmit -p tsconfig.node.json
npx tsc --noEmit -p tsconfig.web.json
npx electron-vite build
npm test
```

CI runs these on Linux, macOS (advisory) and Windows. If you touched paths, shells or file modes, read the Windows and macOS results too, not only Linux.

## 2. Exercise what you changed in the app

Start it (`npm run dev`, or `npm run build && npm start`; on a headless Linux box wrap it in `xvfb-run`). Sign in only with a test account you were given; never with Ian's. For the screen you touched, do the thing the brief describes, take screenshots before and after, and read the main-process and renderer logs for new errors. For local execution changes, show the approval prompt and a denied action staying denied.

If you cannot run the app where you are, say so plainly and say what you checked instead.

## 3. Evidence for the pull request

List each command and its result, the screenshots, and anything you could not check.

## 4. After the merge

A merge to `main` does not ship anything. A release is cut only with the `kyber-studio-release` skill, after Ian has tested the build on his machine. Never tag or bump the version inside a feature change.
