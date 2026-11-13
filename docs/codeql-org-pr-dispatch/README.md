# Organization PR CodeQL dispatcher


These workflows run CodeQL from a central repository, without an organization
ruleset required workflow or a workflow file in every target repository.

- [`codeql-org-pr-dispatch.yml`](../../.github/workflows/codeql-org-pr-dispatch.yml)
  enumerates organization repositories and their open PRs, then dispatches one
  independent worker run per eligible PR.
- [`codeql-pr-scan.yml`](../../.github/workflows/codeql-pr-scan.yml) resolves an immutable
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


See the [PR scan worker guide](../codeql-pr-scan/README.md) for eligibility, language
detection, credential isolation, and results.

### References

- [CodeQL compiled-language build modes](https://docs.github.com/en/code-security/code-scanning/codeql-code-scanning-for-compiled-languages)
- [Uploading SARIF through the REST API](https://docs.github.com/en/rest/code-scanning/code-scanning#upload-an-analysis-as-sarif-data)
- [Troubleshooting default-setup SARIF rejection](https://docs.github.com/en/code-security/code-scanning/troubleshooting-sarif-uploads/default-setup-enabled)
- [GitHub Actions schedule trigger](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)
- [Repository dispatch trigger](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#repository_dispatch)
