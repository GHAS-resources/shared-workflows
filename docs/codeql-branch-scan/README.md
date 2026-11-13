# Centralized branch CodeQL worker

[Workflow](../../.github/workflows/codeql-branch-scan.yml): `Centralized branch CodeQL scan`.
It accepts two required manual-dispatch string inputs: `repository`
(`owner/name`) and `branch` (a short name such as `main` or `release/1.x`).
Normal operation uses the [scheduled organization dispatcher](../codeql-org-scheduled/README.md);
that guide defines shared App credentials and configuration.
Direct dispatch still honors organization/property/branch scope and change skipping.

## Detection and analysis

`automatic` mirrors the [CLI workflow's automatic language selection](../codeql-language-detection/README.md):
normalize the repository Languages API's Linguist names to CodeQL extractors,
deduplicate aliases, and detect Actions workflow files on the actual branch.
Linguist statistics describe the default branch and can miss languages introduced
only on other branches; use `computed` when that matters.

`computed` uses the existing centralized PR scanner's `treePaths` and
`languageMatrix` helpers on the **entire immutable branch tree**. Unlike the
CLI workflow's PR-computed mode, it needs no PR and does not limit discovery
to changed files. Truncated recursive trees fall back to complete subtree
enumeration. Both modes reuse that matrix's build-mode/runner selection.

| Language | Build mode | Runner |
| --- | --- | --- |
| Actions, C/C++, C#, Java-only, JavaScript/TypeScript, Python, Ruby, Rust | `none` | `ubuntu-latest` |
| Java/Kotlin with Kotlin, Go | `autobuild` | `ubuntu-latest` |
| Swift | `autobuild` | `macos-latest` |

No supported languages is an explicit skip, without a successful-delivery
checkpoint. Each selected language scans the whole source tree. Custom builds,
private dependencies, uncommon suffixes, submodules, Git LFS, and platform-specific
toolchains may require additional central configuration. Failed builds are not
silently skipped. Queries are centrally fixed to `security-extended`; target
CodeQL configuration/custom queries are not loaded.

The worker resolves a commit SHA, checks it out with a read-only target token,
and transfers the source (including Git metadata) through a one-day artifact.
Fresh scan runners receive **no App key, target token, or export credential**.
They run `github/codeql-action/init`, optional `autobuild`, and `analyze` with
`upload: never` and `upload-database: false`. Builds can execute repository code
(even Rust `none` mode); do not use persistent self-hosted runners without
equivalent isolation. The scan still has central read-only Actions/runtime
credentials, so do not put unrelated sensitive content in the controller.
Private source and SARIF artifacts live in the central repository: restrict its
read access accordingly.

## Default: GitHub code scanning

Only after all language scans succeed does a clean delivery job create a new,
target-scoped token with code-scanning write permission. It uploads each SARIF
to the **target repository**, `refs/heads/<branch>`, and the exact scanned commit
SHA, with the original checkout URI. Branch movement does not relabel old
results as a new commit; the next sweep scans the new SHA.
The uploader waits for server processing and fails on upload, authorization,
entitlement, default-setup, processing, timeout, or missing-result errors.
No successful checkpoint is written until every delivery succeeds.

Categories are `centralized-pr-codeql/<language>`, matching the centralized PR
worker so default-branch scans can supply its comparison baseline. Coordinate
this deliberately with other CodeQL configurations to avoid conflicting
analyses. Uploading alerts is not a failure or merge gate.

## Alternative: HTTPS export

Set `CODEQL_DESTINATION=endpoint`, `CODEQL_EXPORT_ENDPOINT=https://...`, and
`CODEQL_EXPORT_FORMAT=sarif` or `json`. Optionally store a bearer credential
in the central Actions secret `CODEQL_EXPORT_TOKEN`; it is passed only to
the clean delivery step. Never put credentials in the endpoint URL or variables.

There is **one HTTP POST per language**, including clean scans with zero findings:

- `sarif`: `Content-Type: application/sarif+json`, body is the complete SARIF 2.1.0 document.
- `json`: `Content-Type: application/json`, body is the envelope below, preserving
  the complete SARIF rather than losing rule/location/flow metadata.

```json
{
  "repository": "YOUR-ORG/repository",
  "ref": "refs/heads/main",
  "commit_sha": "the-scanned-commit",
  "language": "python",
  "sarif": { "version": "2.1.0", "runs": [] }
}
```

SARIF itself is JSON; the `json` option adds explicit source identity.
No results are uploaded to GitHub in endpoint mode. HTTPS is required,
redirects are rejected (to avoid forwarding credentials/results), requests
time out after 60 seconds, and any non-2xx response fails delivery.
A 2xx response is treated as endpoint acceptance; the workflow cannot verify
downstream asynchronous processing. Partial delivery is possible: a later
language failure retries the entire branch on a future sweep. Receivers should
deduplicate by repository/ref/SHA/language (available in the JSON envelope)
and accept the potentially large payloads. SARIF consumers can use stable
run categories plus commit information contained in CodeQL's SARIF; choose the
JSON envelope when explicit target identity is required.

Changing destination, endpoint, format, language mode, or other shared settings
changes the checkpoint key and forces a fresh delivery. The endpoint must be
trusted to receive private source details and vulnerability findings.

## Local tests

```sh
node --test tests/codeql-org-scheduled.test.cjs tests/codeql-org-pr.test.cjs
```
