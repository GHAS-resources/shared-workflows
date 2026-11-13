# Centralized PR CodeQL worker

Use `.github/workflows/codeql-pr-scan.yml` to scan one open same-repository PR.
It accepts `repository` (`owner/name`) and `pull_number` (a positive integer).
For installation, credentials, polling, and webhook setup, see the
[organization PR dispatcher guide](../codeql-org-pr-dispatch/README.md).

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
this PR-only scanner does not create that baseline. The
[scheduled branch scanner](../codeql-org-scheduled/README.md) can maintain it
with matching categories. Existing analyses using
different categories are not a substitute. Not using a ruleset required workflow
avoids that particular execution model, but does not bypass target licensing,
default setup restrictions, repository policies, or CodeQL's usage terms.
This does not configure a required check or block merges, and it does not create
ordinary target-repository Actions check runs.


### Local tests

```sh
node --test tests/codeql-org-pr.test.cjs
```

### References

- [CodeQL compiled-language build modes](https://docs.github.com/en/code-security/code-scanning/codeql-code-scanning-for-compiled-languages)
- [Uploading SARIF through the REST API](https://docs.github.com/en/rest/code-scanning/code-scanning#upload-an-analysis-as-sarif-data)
- [Troubleshooting default-setup SARIF rejection](https://docs.github.com/en/code-security/code-scanning/troubleshooting-sarif-uploads/default-setup-enabled)
- [GitHub Actions schedule trigger](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)
- [Repository dispatch trigger](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#repository_dispatch)
