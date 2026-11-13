# CodeQL CLI analysis

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

For organization-wide enforcement without a caller file in every target
repository, use the required-workflow setup below. The reusable workflow itself
is triggered by `workflow_call`, not directly by pull requests.

#### Inputs

| Input | Default | Behavior |
| --- | --- | --- |
| `detection-mode` | `automatic` | Select all supported repository languages, or use `computed` for PR file extensions. |
| `codeql-version` | `latest` | Official bundle release tag, for example `codeql-bundle-v2.27.4`. Pin a supported release for reproducibility. |
| `config-file` | Empty | Optional repository-local CodeQL configuration file for queries, packs, filters, and supported path exclusions. With no file, run each language pack's default code-scanning suite. |

### Set up an organization required workflow

Use an organization branch ruleset's **Require workflows to pass before
merging** rule, not just a required status check. You need permission to manage
organization rulesets and a plan that exposes this rule.

1. In the source repository (`GHAS-resources/shared-workflows`, or an accessible
   workflow repository in your organization), create
   `.github/workflows/codeql-required.yml` on its default branch using the
   example below. This is a **new wrapper workflow**, not one of the existing
   `workflow_call`-only files. Pin the reusable workflow reference to a reviewed
   commit SHA for production.
2. Check source-repository visibility and access. Public source workflows can
   run in public, internal, or private targets; internal sources can run in
   internal/private targets; private sources can run only in private targets.
   For an internal/private source, open **Settings > Actions > General > Access**
   and allow access from repositories in the organization. Ensure organization
   Actions policy allows the reusable workflow and its pinned `actions/checkout`.
3. Ensure target repositories have Actions and code scanning available. For
   private/internal targets, enable GitHub Code Security with the appropriate
   entitlement. Disable CodeQL **default setup** before uploading these external
   CodeQL results; default setup rejects them. The wrapper declares the required
   token permissions, but cannot override organization token restrictions.
4. Open **Organization Settings > Repository > Rulesets > New ruleset >
   New branch ruleset**. Name the ruleset and start with **Evaluate** where
   available. Select a small set of pilot repositories and target their
   **default branches**, or other branches changed through PRs, rather than
   every branch.
5. Under branch protections, enable **Require workflows to pass before
   merging** and add the source repository, ref, and
   `.github/workflows/codeql-required.yml`. Select the wrapper, **not**
   `codeql-cli.yml`, `codeql-language-detection.yml`, or the centralized PR
   workflows. Configure a deliberate administrator/team bypass policy, then
   save the ruleset.
6. Open a new PR in a pilot target. For a PR already open when the rule was
   created, push a new commit, update the branch, or close and reopen the PR to
   trigger it. Confirm the required workflow runs in the target context and
   results appear in that target's code scanning UI. Test a merge queue if used.
   Once scan/upload behavior is confirmed, set enforcement to **Active** and
   expand repository targeting.

```yaml
# Source repository: .github/workflows/codeql-required.yml
name: Required CodeQL CLI
on:
  pull_request:
  merge_group:

permissions:
  contents: read
  pull-requests: read
  security-events: write

jobs:
  codeql:
    if: ${{ true }}
    uses: GHAS-resources/shared-workflows/.github/workflows/codeql-cli.yml@main
    with:
      detection-mode: automatic
      codeql-version: latest
```

The explicit job condition supports using a source workflow for ruleset runs
outside its source repository. No wrapper file is needed in each target
repository. Keep `merge_group` for merge queues, use `automatic` for coverage
across supported events, and do **not** use `pull_request_target`: this
implementation explicitly rejects it. A `push` trigger is not used by the
required-workflow rule; maintain default-branch scans separately for baselines.
Ruleset runs ignore event filters such as `paths`, `branches`, and `types`.
Do not add `cancel-in-progress` concurrency to the required workflow.

This rule requires successful workflow execution, **not zero CodeQL findings**.
The CLI scan can pass while uploading alerts, and this implementation also
passes with an explicit skip when no supported languages are selected. To
enforce alert-severity thresholds, configure **Require code scanning results**
for CodeQL separately and maintain suitable base/default-branch analyses.
The CLI approach avoids the prohibited CodeQL actions in ruleset workflows;
it does not bypass licensing, runner, token, or other policy restrictions.
The [centralized PR scanner](../codeql-pr-scan/README.md) is not a substitute for this required workflow.

Sources: [Require workflows to pass before merging](https://docs.github.com/en/enterprise-cloud@latest/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#require-workflows-to-pass-before-merging),
[Create an organization ruleset](https://docs.github.com/en/enterprise-cloud@latest/organizations/managing-organization-settings/creating-rulesets-for-repositories-in-your-organization),
[Troubleshoot ruleset workflows](https://docs.github.com/en/enterprise-cloud@latest/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/troubleshooting-rules#troubleshooting-ruleset-workflows).

### Language detection

See [the language-detection workflow guide](../codeql-language-detection/README.md) for
selection modes, matrix outputs, and independent reuse.

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

