# Shared CodeQL CLI workflows

Reusable workflows for language detection and CodeQL analysis without invoking
any `github/codeql-action` action. The analysis workflow downloads the official
CodeQL bundle from that repository's releases, verifies its SHA-256 checksum,
creates one database per selected language, runs queries, and uploads SARIF using
`codeql github upload-results`.

## Call the analysis workflow

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

### Inputs

| Input | Default | Behavior |
| --- | --- | --- |
| `detection-mode` | `automatic` | Select all supported repository languages, or use `computed` for PR file extensions. |
| `codeql-version` | `latest` | Official bundle release tag, for example `codeql-bundle-v2.27.4`. Pin a supported release for reproducibility. |
| `config-file` | Empty | Optional repository-local CodeQL configuration file for queries, packs, filters, and supported path exclusions. With no file, run each language pack's default code-scanning suite. |

## Language detection

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

## Build modes and runners

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

## Requirements and limitations

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

## Local tests

```sh
python3 -m unittest discover -s tests -v
```

The tests execute the embedded language-detection code with mocked GitHub API
responses and exercise the scan shell steps with a stub CLI, without downloading
the multi-gigabyte bundle or uploading results.
