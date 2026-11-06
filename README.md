# Shared CodeQL workflows

## Centralized organization PR CodeQL scanning

These workflows run CodeQL from a central repository, without an organization
ruleset required workflow or a workflow file in every target repository.

- [`codeql-org-pr-dispatch.yml`](.github/workflows/codeql-org-pr-dispatch.yml)
  enumerates organization repositories and their open PRs, then dispatches one
  independent worker run per eligible PR.
- [`codeql-pr-scan.yml`](.github/workflows/codeql-pr-scan.yml) resolves an immutable
  PR merge snapshot, detects its languages, creates a language matrix, and uploads
  results to **the target repository's PR**, not this repository.

The dispatcher paginates repository and PR lists instead of using the search API
with its 1,000-result cap. Independent worker runs avoid the 256-job matrix limit
across the organization; each worker has only its own language matrix.

### Setup

1. Install a GitHub App on **all repositories** in the target organization.
   Grant repository permissions **Contents: read**, **Pull requests: read**, and
   **Code scanning alerts: write** (the API permission is `security_events`).
   Metadata read access is implicit. An installation on selected repositories
   cannot provide organization-wide coverage.
2. In this central repository, configure the Actions variable `CODEQL_APP_ID`
   and Actions secret `CODEQL_APP_PRIVATE_KEY`. Optionally set `CODEQL_ORG`;
   otherwise the central repository's owner is used.
3. Ensure code scanning is available and enabled for each target: public
   repositories are supported; private/internal repositories require the
   appropriate GitHub Code Security entitlement. Disable CodeQL **default setup**
   in targets before using these externally uploaded CodeQL analyses. Default
   setup rejects external CodeQL SARIF uploads.
4. Put both workflows and the script on this repository's default branch. Allow
   the referenced actions under organization Actions policy. Run
   **Dispatch organization PR CodeQL scans** manually for an initial sweep.

The central repository's `GITHUB_TOKEN` dispatches worker workflows with
`actions: write`. The App does **not** need Actions write permission. It supplies
read-only tokens for discovery/source retrieval and a target-scoped write token
only in the separate upload job.

No live scans run merely by adding these files. Deployment, App configuration,
and enabling the workflows on the default branch are required.

### Polling interval

The default is **every 15 minutes**. Edit `on.schedule[0].cron` in the dispatcher:

```yaml
schedule:
  - cron: '*/10 * * * *'  # Every 10 minutes
```

GitHub schedules are static UTC cron expressions, not dynamically configurable
through workflow inputs or repository variables. The minimum interval is five
minutes. Use `*/N` for intervals dividing an hour (5, 10, 15, 20, 30); expressions
such as `*/45` do not mean a uniform 45-minute interval across hour boundaries.
For arbitrary uniform intervals, have an external scheduler send the repository
dispatch event described below. Scheduled runs can be delayed or dropped under
load; this is not a real-time SLA.

Each sweep rescans **all** eligible open PRs, including drafts and unchanged PRs.
There is deliberately no successful-SHA deduplication. Repeated scans consume
central Actions minutes/storage, and Swift uses higher-cost macOS runners.
Dispatches are paced to one per second. Normal Actions concurrency, API rate
limits, the dispatcher's one-hour timeout/App token lifetime, and artifact
limits still apply; dispatch/API failures fail the sweep rather than silently
claiming full coverage.

Per-PR concurrency prevents overlapping workers for the same PR without cancelling
an active scan. GitHub concurrency keeps at most one pending run in a group;
repeated queued sweeps can replace an older pending run. The dispatcher reports
dispatch acceptance, **not completion**; inspect worker runs for scan/upload
outcomes.

### PR eligibility and languages

Only open PRs whose head and base are in the **same repository** are scanned.
Fork contributions are excluded both during discovery and again in the worker
and uploader. Archived/disabled repositories are not polled. Conflicting PRs are
reported as skipped because no valid merge snapshot exists. Pending/stale merge
metadata fails the worker explicitly; rerun it or allow the next poll to retry.
Closed or changed PRs are rejected before upload to prevent attaching stale
results to a new snapshot.

Language discovery examines file paths in the **entire PR merge tree**, not just
changed files or the default branch's language statistics. This includes newly
introduced languages and allows cross-file analysis. Large truncated recursive
trees fall back to a complete non-recursive tree walk.

| CodeQL language | Build mode | Runner |
| --- | --- | --- |
| Actions workflows/actions | `none` | Ubuntu |
| C/C++ | `none` | Ubuntu |
| C# | `none` | Ubuntu |
| Java without Kotlin | `none` | Ubuntu |
| Java/Kotlin when Kotlin is present | `autobuild` | Ubuntu |
| JavaScript/TypeScript | `none` | Ubuntu |
| Python | `none` | Ubuntu |
| Ruby | `none` | Ubuntu |
| Rust | `none` | Ubuntu |
| Go | `autobuild` | Ubuntu |
| Swift | `autobuild` | macOS |

Detection uses the source suffixes and Actions paths in `languageMatrix` in
`.github/scripts/codeql-org-pr.cjs`. It is not a full GitHub Linguist implementation:
unusual extensions, extensionless scripts, generated/vendor code and
`.gitattributes` classifications can require adjustments. A detected language
with no extractable code fails visibly rather than producing a false success.
No supported files is reported as a skip.

`none` is preferred where CodeQL supports it. Kotlin requires building the
Java/Kotlin database. Rust's `none` mode can still execute `build.rs` and procedural
macros; **none is not a sandbox**. Autobuild is best effort, not a universal build
system: private dependencies, custom toolchains, multiple project roots, native
dependencies, Windows-only projects, submodules, and Git LFS may require explicit
central build configuration. This implementation deliberately does not fetch
submodules/LFS, inject dependency credentials, or execute PR-provided CodeQL
configuration/custom queries.

### Credential isolation and results

Source is checked out at the verified merge SHA in a read-only preparation job,
then transferred as a short-lived source artifact, including Git metadata.
The scan matrix runs on fresh GitHub-hosted runners with **no App private key or
target write token**. It receives only the central repository's read-only Actions
token and the normal job runtime credentials, so keep the central repository
free of unrelated sensitive content. Do not move these builds to persistent
self-hosted runners without equivalent isolation. All artifacts, including
private source/SARIF, are stored in the central repository for one day; control
who can read that repository.

The CodeQL action uses `upload: never` and `upload-database: false`. A clean,
separate job uploads SARIF with the REST API using the target repository,
`refs/pull/<number>/merge`, the exact scanned merge SHA and base metadata.
It waits for server processing and surfaces entitlement, default-setup,
authorization, processing and missing-language failures. Successful language
results are still uploaded when another language's scan fails.

Categories are `centralized-pr-codeql/<language>`. For reliable "new in PR"
comparison, maintain matching-category **base/default-branch analyses** separately;
this PR-only scanner does not create that baseline. Existing analyses using
different categories are not a substitute. Not using a ruleset required workflow
avoids that particular execution model, but does not bypass target licensing,
default setup restrictions, repository policies, or CodeQL's usage terms.
This does not configure a required check or block merges, and it does not create
ordinary target-repository Actions check runs.

### Optional organization webhook relay

A workflow in this repository cannot directly subscribe to `pull_request` events
from every other repository. Use a GitHub App/organization webhook receiver to
translate events into this central repository's `repository_dispatch`:

```json
{
  "event_type": "codeql-pull-request",
  "client_payload": {
    "repository": "YOUR-ORG/target-repo",
    "pull_number": 42
  }
}
```

Send this to `POST /repos/OWNER/CENTRAL-REPO/dispatches` with an App installation
token authorized for **Contents: write on the central repository**. Use a separate
relay App if you do not want to grant this permission to the scanner App.
Alternatively dispatch `codeql-pr-scan.yml` directly using **Actions: write** and
the `repository` and string `pull_number` workflow inputs.

The receiver must validate `X-Hub-Signature-256` against the raw body, validate the
organization/repository, and deduplicate webhook deliveries. Relay `pull_request`
actions `opened`, `reopened`, `synchronize`, `ready_for_review`, and `edited`
(which can retarget the base). Changes to the base branch do not necessarily
send a PR event, so retaining polling provides reconciliation. Webhook delivery
can also precede merge-ref generation; retry failed/pending merge snapshots.
The receiver itself is deployment-specific and is **not included** here.

Fork exclusions are centralized in `eligible`, with a comment indicating where
to change the behavior. Including forks requires reviewing the whole isolation
and upload path, not switching to `pull_request_target` and exposing secrets to
fork build code.

### Local tests

Run the dependency-free script tests with Node.js 24 or newer:

```sh
node --test tests/codeql-org-pr.test.cjs
```

### References

- [CodeQL compiled-language build modes](https://docs.github.com/en/code-security/code-scanning/codeql-code-scanning-for-compiled-languages)
- [Uploading SARIF through the REST API](https://docs.github.com/en/rest/code-scanning/code-scanning#upload-an-analysis-as-sarif-data)
- [Troubleshooting default-setup SARIF rejection](https://docs.github.com/en/code-security/code-scanning/troubleshooting-sarif-uploads/default-setup-enabled)
- [GitHub Actions schedule trigger](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)
- [Repository dispatch trigger](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#repository_dispatch)
## Shared CodeQL CLI workflows

Reusable workflows for language detection and CodeQL analysis without invoking
any `github/codeql-action` action. The analysis workflow downloads the official
CodeQL bundle from that repository's releases, verifies its SHA-256 checksum,
creates one database per selected language, runs queries, and uploads SARIF using
`codeql github upload-results`.

### Call the analysis workflow

```yaml
name: CodeQL
on:
  pull_request:
  push:
    branches: [main]
  merge_group:

permissions:
  contents: read
  pull-requests: read
  security-events: write

jobs:
  codeql:
    uses: GHAS-resources/shared-workflows/.github/workflows/codeql-cli.yml@main
    with:
      detection-mode: automatic
      codeql-version: latest
      # Optional: file in the repository being analyzed, not shared-workflows.
      # config-file: .github/codeql/codeql-config.yml
```

Pin the reusable workflow to a reviewed commit SHA for production. The nested
language-detection workflow resolves from the same commit as the analysis
workflow. `actions/checkout` is the only action used and must be allowed by the
organization's action policy.

For an organization ruleset's required workflow, configure the caller workflow
with these triggers and permissions, then select it in the ruleset. This avoids
the CodeQL action restriction; it does not bypass other ruleset, runner, license,
or token restrictions. The reusable workflow itself is triggered by
`workflow_call`, not directly by pull requests.

#### Inputs

| Input | Default | Behavior |
| --- | --- | --- |
| `detection-mode` | `automatic` | Select all supported repository languages, or use `computed` for PR file extensions. |
| `codeql-version` | `latest` | Official bundle release tag, for example `codeql-bundle-v2.27.4`. Pin a supported release for reproducibility. |
| `config-file` | Empty | Optional repository-local CodeQL configuration file for queries, packs, filters, and supported path exclusions. With no file, run each language pack's default code-scanning suite. |

### Language detection

`.github/workflows/codeql-language-detection.yml` is independently reusable.
Its input is `mode` (`automatic` or `computed`); outputs are `matrix` (a JSON
`include` matrix) and `has-languages` (the string `true` or `false`). Each matrix
entry contains `language`, `build-mode`, and `runner`.

- **Automatic:** Call `GET /repos/{owner}/{repo}/languages`, normalize Linguist
  names to supported CodeQL language identifiers, and deduplicate shared
  extractors (C/C++, Java/Kotlin, JavaScript/TypeScript). This API reflects the
  default branch, not necessarily newly added PR languages. Check
  `.github/workflows` at the analyzed commit separately to detect Actions YAML.
- **Computed:** Require a PR event, paginate `GET /repos/{owner}/{repo}/pulls/{number}/files`,
  and map the current filenames' extensions to CodeQL languages. Ignore removed
  files and unsupported extensions. Renamed files use their new names. Actions
  detection applies only to `.github/workflows/*.yml` and `*.yaml`. Also recognize
  the Ruby filenames `Gemfile` and `Rakefile`. A Java selection checks the
  repository language API for existing Kotlin so that it is not silently
  excluded. PRs exceeding the API's 3,000-file cap, incomplete API results, and
  PRs updated during detection fail explicitly.

Computed mode selects **languages**, not source paths: each selected language
is analyzed throughout the checked-out repository. Dependency/build-file-only
changes, removed-only changes, and unrecognized source extensions may select
no languages. Use automatic mode for complete coverage and for required
workflows on merge queues (`merge_group` has no PR file list). To use computed
mode for PRs and automatic mode otherwise, set:

```yaml
with:
  detection-mode: ${{ github.event_name == 'pull_request' && 'computed' || 'automatic' }}
```

An empty matrix skips analysis and reports the skip explicitly. The final
`CodeQL CLI result` job fails if detection, analysis, or upload fails.

### Build modes and runners

| CodeQL language | Build mode | Runner |
| --- | --- | --- |
| Actions, C/C++, C#, Java-only, JavaScript/TypeScript, Python, Ruby, Rust | `none` | `ubuntu-latest` |
| Java/Kotlin when Kotlin is detected | `autobuild` | `ubuntu-latest` |
| Go | `autobuild` | `ubuntu-latest` |
| Swift | `autobuild` | `macos-15-intel` |

Kotlin and Swift require a build today. A comment beside the language matrix's build-mode selection marks them
for migration to `none` when supported. Go also currently requires a build.
Autobuild attempts to discover the build system; projects requiring additional
SDKs, credentials, custom build steps, or dependencies may fail and need a
project-specific workflow. The workflow does not silently skip failed builds.
Swift uses an Intel macOS runner to match the official `osx64` bundle.

### Requirements and limitations

- Private/internal repositories require GitHub Code Security enabled and an
  appropriate license. Public repositories can use CodeQL without that license.
- The caller must grant `contents: read`, `pull-requests: read`, and
  `security-events: write`. Nested workflows cannot elevate caller permissions.
  Fork PRs and Dependabot runs can have restricted tokens; GitHub's PR-specific
  SARIF upload rules still apply. Upload errors fail the workflow.
- `pull_request_target` is deliberately rejected: Kotlin, Go, and Swift
  autobuild can execute untrusted PR code. Do not use elevated tokens or
  repository secrets to work around fork restrictions.
- Analysis checks out `github.sha` and uploads with the matching commit and
  `github.ref` (the merge ref for a normal PR event). A stable, separate SARIF
  category per language prevents one language's upload replacing another's.
- The bundle must support the selected languages/build modes. Older bundles
  may lack Rust, Actions, or newer `none` modes. Runners need network access to
  GitHub releases and build dependencies.
- If another CodeQL configuration already scans the repository, coordinate
  its categories/configuration rather than inadvertently maintaining duplicate
  analyses. Computed mode alone is not a complete replacement for a full
  default-branch scan.

References: [CodeQL build modes](https://docs.github.com/en/code-security/how-tos/find-and-fix-code-vulnerabilities/manage-your-configuration/codeql-for-compiled-languages),
[CodeQL configuration](https://docs.github.com/en/code-security/reference/code-scanning/workflow-configuration-options),
[CLI SARIF upload](https://docs.github.com/en/code-security/tutorials/customize-code-scanning/upload-results).

### Local tests

```sh
python3 -m unittest discover -s tests -v
```

The tests execute the embedded language-detection code with mocked GitHub API
responses and exercise the scan shell steps with a stub CLI, without downloading
the multi-gigabyte bundle or uploading results.
