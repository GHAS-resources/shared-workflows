# Scheduled organization CodeQL scans

[Workflow](../../.github/workflows/codeql-org-scheduled.yml):
`Scheduled organization CodeQL scans`. No PR event, organization webhook,
ruleset, or target-repository workflow is required. Each selected branch is
dispatched to an independent [branch worker](../codeql-branch-scan/README.md), avoiding
an organization-wide 256-job matrix limit.

## Setup

1. Install a GitHub App on **all repositories** in the organization. Grant
   **Contents: read** and, for GitHub uploads, **Code scanning alerts: write**
   (`security_events`). Metadata read is implicit and allows reading repository
   custom properties. Selected-repository installations cannot cover the org.
2. Set central Actions variable `CODEQL_APP_ID` and secret
   `CODEQL_APP_PRIVATE_KEY`. Set the variables below as needed under
   **Settings > Secrets and variables > Actions > Variables**.
3. Deploy both new workflows and both `.github/scripts/codeql-org-*.cjs`
   scripts to the central repository's default branch. Allow the referenced
   actions under organization policy. Use fresh GitHub-hosted runners.
4. Ensure target repositories are entitled to CodeQL. For GitHub uploads,
   enable code scanning and disable CodeQL default setup, which rejects external
   CodeQL SARIF. Exporting elsewhere does not waive CodeQL licensing/usage terms.
5. Manually run **Scheduled organization CodeQL scans** for the initial sweep.
   The scheduled heartbeat handles later sweeps. Inspect worker runs for actual
   scan/delivery outcomes; a successful dispatcher only confirms dispatch.

## Configuration

Defaults are declared in the dispatcher and worker `env` blocks; repository
variables override them consistently without editing either workflow.

| Actions variable | Default | Meaning |
| --- | --- | --- |
| `CODEQL_ORG` | Central repository owner | Organization to enumerate; workers reject foreign repository owners. |
| `CODEQL_INTERVAL_MINUTES` | `60` | Integer at least `5`; minimum elapsed minutes between successful discovery sweeps. |
| `CODEQL_CUSTOM_PROPERTY` | Empty | Empty means all eligible repositories. Otherwise require this named property to have boolean `true` or the API string `"true"`. Missing, unset, false, or other values exclude the repository. |
| `CODEQL_BRANCHES` | `default` | `default` scans only each repository's current default branch; `all` enumerates all ordinary branches, not tags or PR merge refs. |
| `CODEQL_CHANGES_ONLY` | `true` | Scan new branch SHAs or changed configuration; `false` rescans even previously successful SHAs on every sweep. |
| `CODEQL_DETECTION_MODE` | `automatic` | `automatic` uses repository Linguist languages plus branch workflow/Kotlin detection; `computed` detects languages from the entire branch tree. |
| `CODEQL_DESTINATION` | `github` | `github` uploads to each target repository; `endpoint` sends results only to the configured endpoint. |
| `CODEQL_EXPORT_FORMAT` | `sarif` | `sarif` or `json`; only affects endpoint delivery. |
| `CODEQL_EXPORT_ENDPOINT` | Empty | Required HTTPS URL when destination is `endpoint`; must not contain credentials or a fragment. |

For example, set `CODEQL_CUSTOM_PROPERTY=codeql-enabled`, `CODEQL_BRANCHES=all`,
`CODEQL_INTERVAL_MINUTES=30`, and `CODEQL_DETECTION_MODE=computed` to scan all
branches of repositories opted in through that boolean custom property.
The worker rechecks scope and property eligibility before fetching source.
Archived, disabled, and empty repositories are skipped.

### Scheduling and change tracking

GitHub cron cannot interpolate workflow configuration. A static five-minute
heartbeat (`2/5 * * * *`) checks a persisted discovery marker against
`CODEQL_INTERVAL_MINUTES`. `60` therefore means no more often than hourly;
arbitrary intervals (for example `17` or `90`) run on the next available
heartbeat after becoming due, not at an exact wall-clock cadence. GitHub may
delay/drop scheduled runs. Manual sweeps bypass the interval gate, but still
honor successful-SHA skipping.

Successful deliveries create a central artifact whose name identifies the
repository, branch, configuration hash, and exact scanned SHA. Discovery and
worker preparation skip a matching checkpoint only from a successfully
completed branch-worker run. First-time branches, missing/expired checkpoints,
and changed settings scan again. Failed scans/uploads/exports never advance
the checkpoint and are retried on a later sweep. Changed-only mode compares
against **successfully delivered snapshots**, not the previous failed attempt.
It does not detect query-pack changes when the source/configuration is
unchanged; use `CODEQL_CHANGES_ONLY=false` for periodic fresh analysis.

Markers/checkpoints have a requested 90-day retention (subject to repository
policy). Deleting artifacts, expiring retention, or moving the deployment to a
new controller safely causes rescanning. Do not treat artifacts as permanent
audit storage. Repository/branch lists and artifact lists are paginated; there
is no search-API 1,000-result cap.

Discovery concurrency prevents overlapping sweeps. Per-branch concurrency
serializes scans without cancelling an active run; Actions can replace an
older pending run with a newer pending run. Long scans may be redispatched
before their checkpoint exists. Dispatches are paced to one per second; org
size, API rate limits, one-hour discovery timeout/App-token lifetime, Actions
quotas, artifact storage, and macOS minutes are practical limits. Discovery
errors fail visibly rather than reporting full coverage.

## Results and export

See the [branch worker guide](../codeql-branch-scan/README.md) for credential isolation,
language/build behavior, upload metadata, the HTTPS contract, and limitations.
The scheduled scanner does not enforce required checks or block merges.
