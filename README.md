# Shared CodeQL workflows

Reusable and centralized CodeQL scanning workflows. Each workflow has its own
guide with configuration, permissions, examples, and limitations.

| Workflow | Purpose | Guide |
| --- | --- | --- |
| [`codeql-cli.yml`](.github/workflows/codeql-cli.yml) | Reusable CLI analysis and SARIF upload, including organization required-workflow setup. | [CLI analysis](docs/codeql-cli/README.md) |
| [`codeql-language-detection.yml`](.github/workflows/codeql-language-detection.yml) | Reusable automatic or PR-computed language/build matrix. | [Language detection](docs/codeql-language-detection/README.md) |
| [`codeql-org-pr-dispatch.yml`](.github/workflows/codeql-org-pr-dispatch.yml) | Poll organization PRs or receive relayed webhook events and dispatch scans. | [PR dispatcher](docs/codeql-org-pr-dispatch/README.md) |
| [`codeql-pr-scan.yml`](.github/workflows/codeql-pr-scan.yml) | Isolated CodeQL Action analysis of one PR merge snapshot, uploading to that PR. | [PR worker](docs/codeql-pr-scan/README.md) |
| [`codeql-org-scheduled.yml`](.github/workflows/codeql-org-scheduled.yml) | Periodically discover organization repositories/branches with optional custom-property filtering and successful-SHA deduplication. | [Scheduled organization scans](docs/codeql-org-scheduled/README.md) |
| [`codeql-branch-scan.yml`](.github/workflows/codeql-branch-scan.yml) | Isolated CodeQL Action analysis of one branch; upload to its repository or export to HTTPS. | [Branch worker](docs/codeql-branch-scan/README.md) |

Centralized scanners require a GitHub App and deployment on the central
repository's default branch. Adding these files alone does not start scans.

## Local checks

```sh
node --test tests/*.test.cjs
python3 -m unittest discover -s tests -v
```
