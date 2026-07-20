# Pi Per Fork Governance

This document defines the only supported Git workflow for the Pi Per downstream
fork. It protects the canonical mirror while allowing the downstream branch to
carry intentional, reviewable changes.

## Invariants

- `upstream` is the canonical remote: `https://github.com/can1357/oh-my-pi.git`.
- `origin` is the Pi Per fork: `https://github.com/clssck/oh-my-pi.git`.
- `main` is a clean fast-forward mirror of `upstream/main`. Do not make Pi Per
  commits on it.
- `pi-per/main` is the shared downstream shipping branch.
- A shared branch is never rebased, reset, or force-pushed. In particular, do
  not force-push `main` or `pi-per/main`.
- Use `pi-per/sync/<version>` only for an upstream synchronization PR.
- Use `contrib/<topic>` for every non-sync candidate branch. Never create a
  local branch named `upstream/*`.

`upstream/main` in commands below is a remote-tracking ref, not a local branch.
It is expected after `git fetch upstream`; do not create a branch under the
local `refs/heads/upstream/` namespace.

## Check remotes before changing history

Run these commands before a mirror update, sync, or release:

```sh
git remote get-url upstream
git remote get-url origin
```

They must print the canonical and fork URLs above. Repair a mistaken URL before
continuing; do not compensate by pushing to a differently named remote.

## Branch roles

| Ref | Role | Allowed history operation |
| --- | --- | --- |
| `main` | Fork's byte-for-byte canonical mirror | fast-forward from `upstream/main` only |
| `pi-per/main` | Shared downstream branch and release source | merge approved PRs only |
| `pi-per/sync/<version>` | One upstream-sync proposal | merge `upstream/main` into the branch |
| `contrib/<topic>` | Any generic candidate or rollback proposal | rework freely before review; merge by PR |

A branch name communicates its destination, not its remote. A branch under
`contrib/` may start from `main` when proposing a generic upstream contribution,
or from `pi-per/main` when proposing a downstream candidate. It must not be
used to rewrite either shared branch.

## Keep `main` a fast-forward mirror

Only perform this sequence when the fork mirror is meant to catch up to the
canonical repository:

```sh
git fetch upstream --prune
git switch main
git pull --ff-only origin main
git merge --ff-only upstream/main
git push origin main
```

If any command cannot fast-forward, stop. Investigate the unexpected commit;
do not merge, rebase, reset, or force-push to make the command succeed. Pi Per
changes belong on `pi-per/main`, never in the mirror.

## Merge-based upstream synchronization

Synchronize upstream through a dedicated PR, not directly on `pi-per/main`.
The merge commit is deliberate provenance: it makes the canonical boundary and
conflict resolution visible in history.

```sh
git fetch upstream --prune
git fetch origin --prune
git switch pi-per/main
git pull --ff-only origin pi-per/main
git switch -c pi-per/sync/<version> origin/pi-per/main
git merge --no-ff --no-commit upstream/main
```

Use a real upstream version or immutable upstream commit in `<version>`. If the
merge succeeds or its conflicts are resolved, inspect the staged result and
create the merge commit with both required trailers:

```sh
git diff --check
git commit -m "chore(pi-per): merge upstream <version>" \
  --trailer "Upstream-Status: merged <40-hex-upstream-commit>" \
  --trailer "Pi-Per-Reason: synchronize canonical upstream <version>"
git push -u origin HEAD:pi-per/sync/<version>
```

Open a PR from `pi-per/sync/<version>` to `pi-per/main`. Merge that PR with a
merge commit. Do not squash or rebase it. Delete the short-lived sync branch
only after the shared branch contains the merge.

### Conflict and `rerere` policy

Enable recorded resolutions locally, but never accept them blindly:

```sh
git config rerere.enabled true
git config rerere.autoupdate false
```

For each conflict, identify whether the canonical behavior or the downstream
adaptation should win, then stage the reviewed result. Use `git rerere status`
and `git rerere diff` to inspect a reused resolution before staging it. A stale
or incorrect cached resolution must be removed with `git rerere forget <path>`;
never commit it because Git supplied it automatically.

If the conflict cannot be explained in the PR, abandon the attempt with
`git merge --abort`, record the question, and start again after the decision is
made. Do not reset `pi-per/main` or turn the sync into a rebase.

## Generic contribution flow

Use `contrib/<topic>` rather than a personal or `upstream/*` branch name.
Start from the branch the PR will target:

```sh
# Candidate intended for canonical upstream.
git switch main
git pull --ff-only origin main
git switch -c contrib/<topic>

# Candidate intended for Pi Per downstream instead.
git switch pi-per/main
git pull --ff-only origin pi-per/main
git switch -c contrib/<topic>
```

Push the candidate and open a PR. A generic candidate that becomes an upstream
contribution must not be merged locally into `main`; let the canonical mirror
advance through the fast-forward procedure after upstream accepts it.

## Commit trailers

Every commit that changes downstream behavior, including an upstream-sync merge
commit, carries both trailers:

```text
Upstream-Status: <status and immutable reference>
Pi-Per-Reason: <durable reason Pi Per needs this change>
```

Use one of these `Upstream-Status` forms:

- `merged <40-hex-commit>` for code incorporated from canonical upstream;
- `submitted <PR URL>` for a candidate sent upstream;
- `pending` while an upstream proposal has not been submitted; or
- `not-applicable` for a deliberately downstream-only change.

`Pi-Per-Reason` must describe the product, compatibility, policy, or operational
need—not merely restate the code change. A commit that has no durable reason
must not enter `pi-per/main`.

## Provenance and immutable releases

`pi-per-provenance.json` is the checked-in downstream provenance record. Its
fields are intentionally literal rather than symbolic:

| Field | Required value |
| --- | --- |
| `canonical.repository` | `can1357/oh-my-pi` |
| `canonical.baseCommit` | full lowercase 40-hex canonical commit |
| `fork.repository` | `clssck/oh-my-pi` |
| `fork.commit` | full lowercase 40-hex commit used to build the artifact |
| `omp.package` and `omp.version` | the shipped OMP package identity and exact package version |
| `bun.version` | the exact Bun version pinned by root `package.json` |
| `release.sha256` | full lowercase SHA-256 of the published artifact |

A `draft` record anchors current work and has `release: null`. A `release`
record is immutable and must include a Pi Per release tag, artifact basename,
and SHA-256 checksum. Branch names, tags in commit fields, `HEAD`, abbreviated
IDs, version ranges, timestamps as substitutes for a commit, and placeholder
checksums are invalid.

To cut a release:

1. Start from the reviewed `pi-per/main` candidate that will build the artifact.
2. Record that candidate's full commit ID as `fork.commit` and the canonical
   base it contains as `canonical.baseCommit`.
3. Read the exact OMP package version from `packages/coding-agent/package.json`
   and the exact Bun pin from root `package.json`.
4. Build the artifact from `fork.commit`, compute its checksum with
   `shasum -a 256 -b <artifact>`, and change the manifest to `state: "release"`.
5. Add the immutable tag and artifact metadata to the manifest, commit that
   record, and run:

   ```sh
   bun scripts/verify-pi-per-provenance.mjs \
     --manifest pi-per-provenance.json \
     --require-release \
     --require-ancestry
   ```

6. Publish the artifact under the recorded basename and checksum. Do not replace
   an artifact, checksum, or tag after publication. Correct a release by making
   a new release record and a new artifact.

The artifact can legitimately be built from the commit immediately preceding
the provenance-record commit. The verifier requires that recorded commit to be
reachable from the checked-out history; it does not pretend that the later
metadata commit was part of the artifact.

The verifier always validates schema, immutable commit syntax, repository and
package identity, package version, Bun pin, and release metadata when present.
`--require-ancestry` additionally requires local Git objects and proves both
canonical-base-to-fork and fork-to-`HEAD` ancestry. It fails closed when that
metadata is unavailable. The Pi Per workflow runs that mode with a full Git
checkout.

## Parity gates

Before merging a sync or cutting a release, all of the following must hold:

1. `main` exactly fast-forwards to `upstream/main`; it contains no Pi Per-only
   commit.
2. `pi-per/main` contains the reviewed merge history for every canonical update.
3. The manifest's canonical base is an ancestor of its recorded fork commit,
   and the fork commit is reachable from the reviewed downstream history.
4. The manifest package and Bun values equal the repository's actual pins.
5. The dedicated Pi Per provenance workflow passes; it is separate from the
   canonical upstream workflow and therefore does not alter canonical CI.
6. `git for-each-ref refs/heads/upstream/` prints no local `upstream/*` branch.

The narrow local check is:

```sh
bun scripts/verify-pi-per-provenance.mjs \
  --manifest pi-per-provenance.json \
  --require-ancestry
```

## Rollback without rewriting shared history

A rollback is a new reviewed change. Never reset, rebase, or force-push a shared
branch to hide a shipped commit.

```sh
git switch pi-per/main
git pull --ff-only origin pi-per/main
git switch -c contrib/revert-<release-or-topic>
# For a normal downstream commit:
git revert --no-commit <commit>
# For an upstream merge commit, use its first parent as the downstream base:
# git revert --no-commit -m 1 <merge-commit>
git commit -m "revert(pi-per): <subject>" \
  --trailer "Upstream-Status: not-applicable" \
  --trailer "Pi-Per-Reason: rollback <release-or-topic> after <reason>"
git push -u origin HEAD:contrib/revert-<release-or-topic>
```

Open and merge the rollback PR into `pi-per/main`. If a released artifact is
unsafe, revoke or mark that immutable release as withdrawn in the distribution
channel, then publish a new release with a new artifact and checksum. Do not
retarget a tag, overwrite a checksum, or rewrite the history that explains the
rollback.
