# Review rules: kyber-studio

KYBER Studio, the signed, self-updating Electron desktop app people use to talk to their agents and to let those agents work on their own machine. It ships to customers. A reviewer reads this file from `main`, reviews the pull request's exact head commit at the depth `review-tier` prints, and runs `.claude/skills/verify` itself. Findings are Important (blocks the merge), Nit, or Pre-existing.

## What failure looks like here

An agent runs something on a person's machine they didn't approve, a token reaches the renderer, a conversation shows the wrong history or answer, or an update ships a build that won't start. A finding that can't be tied to one of these, or to a broken done-when line, is a Nit at most.

## How to write the findings

- Start with the counts: `Important <a>, Nit <b>, Pre-existing <c>.` When there is nothing to fix, say "Nothing to fix." and stop.
- Every finding cites a file and line and says what fails and how to fix it. No guesses from a name.
- At most 5 Nits; keep the ones that matter most.
- Name the bug class when a mistake can repeat, so every instance gets fixed, not only the line quoted.
- Review depth comes from the changed files (`review-tier`): the build plugin's defaults plus `.github/risk` mark the deep paths, which get parallel bug hunters, a confirm vote and a separate security status.

## Skip

- `build/icons/**`, `build/icon-source/**`, `resources/brand/**` (images).
- `test/fixtures/**` contents, except to check they are anonymised.
- `package-lock.json` except for the dependency row; `out/` and `dist/`.
- Whitespace and formatting the repo's own tools already enforce.

## Always check

- **It does what the brief says,** all of it, and nothing it doesn't.
- **Local work stays approved:** any change to local execution (search, read, edit, write, run) keeps the per-kind approval, the allowed roots and the relay's checks; nothing widens what an agent may do on the machine without the person's yes.
- **Secrets stay in main:** tokens stay encrypted with the OS keychain and never reach the renderer, logs or crash reports; IPC exposes only what the renderer needs.
- **The eve session protocol** (continue by path, stream after the replayed transcript, scope events by `turnId`, bounded silence, a new message cancels the running turn) is kept; a client is a view of the agent's record, never a second store of it.
- **Contracts with the control plane and agents** are used as they are; a new field is read defensively.
- **Cross-platform:** paths, shells and file modes work on macOS, Windows and Linux; the Linux packaging work belongs to its owner and is not changed here unless the brief says so.
- **Naming:** customer-facing UI and copy name no agent of ours and no competitor.
- **No release in a pull request:** version bumps and tags happen only through the release skill, after Ian has tested the build locally.

## Reliability checklist (check the item when the diff matches the trigger)

| Diff touches | Check |
| --- | --- |
| `src/main/**` local execution, relay, MCP launch | The approval prompt still appears once per kind; a denied action stays denied; a command outside allowed roots is refused. |
| Sign-in, keychain, token refresh | Device flow and refresh still work; a revoked grant signs the person out cleanly; no token in renderer state. |
| Chat streaming, rooms, history | Resuming a conversation doesn't replay its own history as the answer; a cancelled turn shows as cancelled; rooms still route `@` tags right. |
| Updater, packaging, `electron-builder` config | `npm run verify:package` passes; the packaged app starts; nothing changes signing or notarization unless the brief says so. |
| `package.json` / lockfile | The lockfile matches on all three platforms; a new native dependency ships prebuilt. |
| Renderer UI | Looks right in the window sizes Studio supports, light and dark. |

## Not this repo's business

The control plane is `kybernesis-admin`, the agent-side routes are in `platform` (`@kybernesis/manage`, `@kybernesis/local`), and the phone app is `kyber-studio-mobile`. A change that needs them is a separate pull request there; deploy the control plane before a Studio release that depends on it.
