# CodeQL language detection

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


See the [CLI analysis guide](../codeql-cli/README.md) for build modes, runners, requirements,
and the calling workflow.
