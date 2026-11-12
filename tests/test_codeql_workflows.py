import io
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import textwrap
import unittest
from unittest.mock import patch
from urllib.error import HTTPError


ROOT = Path(__file__).resolve().parents[1]
WORKFLOWS = ROOT / ".github" / "workflows"


def run_block(workflow, step_name):
    lines = (WORKFLOWS / workflow).read_text().splitlines()
    start = lines.index(f"      - name: {step_name}")
    run = next(index for index in range(start, len(lines)) if lines[index] == "        run: |")
    end = run + 1
    while end < len(lines) and (not lines[end].strip() or lines[end].startswith("          ")):
        end += 1
    return textwrap.dedent("\n".join(lines[run + 1:end])) + "\n"


def load_detection():
    block = run_block("codeql-language-detection.yml", "Select languages")
    source = block.split("python3 - <<'PY'\n", 1)[1].rsplit("\nPY", 1)[0]
    namespace = {"__name__": "workflow_test"}
    exec(compile(source, "codeql-language-detection.yml", "exec"), namespace)
    return namespace


class DetectionTests(unittest.TestCase):
    def setUp(self):
        self.code = load_detection()
        self.environment = patch.dict(os.environ, {
            "GITHUB_EVENT_NAME": "pull_request",
            "GITHUB_SHA": "merge-sha",
            "GITHUB_REPOSITORY": "owner/repo",
            "GITHUB_API_URL": "https://api.github.com",
            "GH_TOKEN": "test-token",
        })
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.event = {"pull_request": {"number": 42, "head": {"sha": "head-sha"}}}

    def computed(self, files, languages=None, total=None, head="head-sha"):
        calls = []

        def api(path, **parameters):
            calls.append((path, parameters))
            if path == "pulls/42":
                return {"head": {"sha": head}, "changed_files": len(files) if total is None else total}
            if path == "pulls/42/files":
                start = (parameters["page"] - 1) * 100
                return files[start:start + 100]
            if path == "languages":
                return languages or {}
            self.fail(f"Unexpected API call: {path}")

        self.code["api"] = api
        matrix = self.code["detect"]("computed", self.event)
        return matrix, calls

    def test_automatic_normalizes_and_deduplicates_all_languages(self):
        def api(path, **parameters):
            if path == "languages":
                return {name: 100 for name in [*self.code["API_LANGUAGES"], "HTML", "YAML"]}
            self.assertEqual(path, "contents/.github/workflows")
            self.assertEqual(parameters, {"ref": "merge-sha"})
            return [{"type": "file", "path": ".github/workflows/ci.yml"}]

        self.code["api"] = api
        entries = self.code["detect"]("automatic", {})["include"]
        self.assertEqual(len(entries), 10)
        self.assertEqual(len({entry["language"] for entry in entries}), 10)
        self.assertEqual(next(entry for entry in entries if entry["language"] == "java-kotlin")["build-mode"], "autobuild")
        self.assertEqual(next(entry for entry in entries if entry["language"] == "swift")["runner"], "macos-15-intel")
        self.assertTrue(all(
            entry["build-mode"] == "none"
            for entry in entries if entry["language"] not in {"go", "java-kotlin", "swift"}
        ))

    def test_automatic_no_workflow_directory_and_java_none(self):
        def api(path, **parameters):
            if path == "languages":
                return {"Java": 100}
            raise HTTPError("test", 404, "Not Found", {}, None)

        self.code["api"] = api
        self.assertEqual(self.code["detect"]("automatic", {})["include"], [
            {"language": "java-kotlin", "build-mode": "none", "runner": "ubuntu-latest"},
        ])

    def test_api_errors_are_not_hidden(self):
        def api(path, **parameters):
            if path == "languages":
                return {}
            raise HTTPError("test", 403, "Forbidden", {}, None)

        self.code["api"] = api
        with self.assertRaises(HTTPError):
            self.code["detect"]("automatic", {})

    def test_file_extensions_and_workflow_paths(self):
        cases = {
            "src/a.C": "c-cpp", "include/a.hpp": "c-cpp", "a.cs": "csharp",
            "a.go": "go", "a.java": "java-kotlin", "a.kt": "java-kotlin",
            "build.gradle.kts": "java-kotlin", "a.tsx": "javascript-typescript",
            "a.mts": "javascript-typescript", "a.cjs": "javascript-typescript",
            "a.pyw": "python", "a.rb": "ruby", "Gemfile": "ruby", "Rakefile": "ruby",
            "a.rs": "rust", "a.swift": "swift", ".github/workflows/ci.yaml": "actions",
            "config.yaml": None, ".github/workflows/subdir/a.yml": None,
            "readme.md": None,
        }
        for filename, expected in cases.items():
            with self.subTest(filename=filename):
                self.assertEqual(self.code["file_language"](filename), expected)

    def test_computed_filters_removed_unsupported_and_uses_renamed_file(self):
        matrix, _ = self.computed([
            {"filename": "old.swift", "status": "removed"},
            {"filename": "README.md", "status": "modified"},
            {"filename": "new.py", "previous_filename": "old.js", "status": "renamed"},
            {"filename": "other.py", "status": "added"},
        ])
        self.assertEqual(matrix["include"], [
            {"language": "python", "build-mode": "none", "runner": "ubuntu-latest"},
        ])

    def test_computed_paginates_past_first_page(self):
        files = [{"filename": f"doc/{index}.md", "status": "modified"} for index in range(200)]
        files.append({"filename": "src/main.rs", "status": "added"})
        matrix, calls = self.computed(files)
        self.assertEqual(matrix["include"][0]["language"], "rust")
        self.assertEqual([parameters["page"] for path, parameters in calls if path.endswith("/files")], [1, 2, 3])

    def test_computed_exact_page_boundary_and_limit(self):
        for count in (100, 3000):
            with self.subTest(count=count):
                matrix, calls = self.computed([
                    {"filename": f"{index}.py", "status": "modified"} for index in range(count)
                ])
                self.assertEqual(matrix["include"][0]["language"], "python")
                self.assertEqual(len([path for path, _ in calls if path.endswith("/files")]), count // 100 + 1)
        with self.assertRaisesRegex(ValueError, "3,000-file"):
            self.computed([], total=3001)

    def test_computed_kotlin_new_and_existing(self):
        matrix, calls = self.computed([{"filename": "src/New.kt", "status": "added"}])
        self.assertEqual(matrix["include"][0]["build-mode"], "autobuild")
        self.assertNotIn("languages", [path for path, _ in calls])
        matrix, _ = self.computed([{"filename": "src/Main.java", "status": "modified"}], {"Kotlin": 100})
        self.assertEqual(matrix["include"][0]["build-mode"], "autobuild")
        matrix, _ = self.computed([{"filename": "src/Main.java", "status": "modified"}], {"Java": 100})
        self.assertEqual(matrix["include"][0]["build-mode"], "none")

    def test_empty_selection(self):
        matrix, _ = self.computed([{"filename": "deleted.py", "status": "removed"}])
        self.assertEqual(matrix, {"include": []})

    def test_invalid_modes_events_and_stale_prs(self):
        with self.assertRaisesRegex(ValueError, "mode must"):
            self.code["detect"]("invalid", {})
        with self.assertRaisesRegex(ValueError, "requires a pull_request"):
            self.code["detect"]("computed", {})
        with patch.dict(os.environ, {"GITHUB_EVENT_NAME": "pull_request_target"}):
            with self.assertRaisesRegex(ValueError, "privileged"):
                self.code["detect"]("automatic", self.event)
        with self.assertRaisesRegex(ValueError, "changed since"):
            self.computed([], head="new-sha")
        with self.assertRaisesRegex(ValueError, "incomplete"):
            self.computed([], total=1)

    def test_pr_updated_during_pagination(self):
        pulls = iter([
            {"head": {"sha": "head-sha"}, "changed_files": 0},
            {"head": {"sha": "new-sha"}, "changed_files": 0},
        ])
        self.code["api"] = lambda path, **kwargs: next(pulls) if path == "pulls/42" else []
        with self.assertRaisesRegex(ValueError, "changed during"):
            self.code["detect"]("computed", self.event)

    def test_main_writes_valid_outputs_and_skip_summary(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "event.json").write_text(json.dumps(self.event))
            self.code["detect"] = lambda mode, event: {"include": []}
            with patch.dict(os.environ, {
                "DETECTION_MODE": "computed",
                "GITHUB_EVENT_PATH": str(root / "event.json"),
                "GITHUB_OUTPUT": str(root / "output"),
                "GITHUB_STEP_SUMMARY": str(root / "summary"),
            }):
                self.code["main"]()
            self.assertEqual((root / "output").read_text(), 'matrix={"include":[]}\nhas-languages=false\n')
            self.assertIn("analysis will be skipped", (root / "summary").read_text())

    def test_api_authentication_and_query_encoding(self):
        requests = []

        def urlopen(request, timeout):
            requests.append(request)
            self.assertEqual(timeout, 60)
            return io.StringIO('{"Python":42}')

        self.code["urlopen"] = urlopen
        self.assertEqual(self.code["api"]("languages", ref="refs/pull/42/merge"), {"Python": 42})
        self.assertIn("ref=refs%2Fpull%2F42%2Fmerge", requests[0].full_url)
        self.assertEqual(requests[0].get_header("Authorization"), "Bearer test-token")


class ScanTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.workspace = self.root / "repo"
        self.workspace.mkdir()
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.environment = {
            **os.environ,
            "PATH": f"{self.bin}:{os.environ['PATH']}",
            "GITHUB_WORKSPACE": str(self.workspace),
            "RUNNER_TEMP": str(self.root),
            "CODEQL_LANGUAGE": "python",
            "BUILD_MODE": "none",
            "CONFIG_FILE": "",
            "CLI_LOG": str(self.root / "cli.jsonl"),
            "GITHUB_SHA": "abc123",
            "GITHUB_REF": "refs/pull/42/merge",
            "GITHUB_REPOSITORY": "owner/repo",
            "GITHUB_SERVER_URL": "https://github.com",
            "GH_TOKEN": "test-token",
            "GITHUB_STEP_SUMMARY": str(self.root / "summary"),
            "GITHUB_PATH": str(self.root / "github-path"),
            "SEVERITY_RESULT": "success",
        }
        self.stub("codeql", """#!/usr/bin/env python3
import json, os, sys
with open(os.environ["CLI_LOG"], "a") as log:
    log.write(json.dumps(sys.argv[1:]) + "\\n")
if sys.argv[1:3] == ["github", "upload-results"]:
    assert sys.stdin.read() == os.environ["GH_TOKEN"]
sys.exit(int(os.environ.get("CLI_EXIT", "0")))
""")
        self.stub("git", "#!/bin/sh\nprintf '%s\\n' \"${CHECKOUT_SHA:-abc123}\"\n")

    def stub(self, name, content):
        path = self.bin / name
        path.write_text(content)
        path.chmod(0o755)

    def step(self, name, **environment):
        return subprocess.run(
            ["bash", "-c", run_block("codeql-cli.yml", name)],
            cwd=self.workspace, env={**self.environment, **environment},
            text=True, capture_output=True,
        )

    def calls(self):
        return [json.loads(line) for line in (self.root / "cli.jsonl").read_text().splitlines()]

    def test_create_none_and_autobuild(self):
        for language, mode in (("python", "none"), ("c-cpp", "none"), ("rust", "none"), ("java-kotlin", "autobuild"), ("swift", "autobuild"), ("go", "autobuild")):
            with self.subTest(language=language):
                result = self.step("Create CodeQL database", CODEQL_LANGUAGE=language, BUILD_MODE=mode)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn(f"--language={language}", self.calls()[-1])
                self.assertIn(f"--build-mode={mode}", self.calls()[-1])

    def test_config_is_passed_without_overriding_queries(self):
        config = self.workspace / "codeql config.yml"
        config.write_text("queries:\n  - uses: security-extended\n")
        created = self.step("Create CodeQL database", CONFIG_FILE=config.name)
        self.assertEqual(created.returncode, 0, created.stderr)
        self.assertIn(f"--codescanning-config={config.resolve()}", self.calls()[-1])
        analyzed = self.step("Analyze CodeQL database", CONFIG_FILE=config.name)
        self.assertEqual(analyzed.returncode, 0, analyzed.stderr)
        self.assertFalse(any(argument.endswith("-queries") for argument in self.calls()[-1]))

    def test_invalid_config_paths_fail_before_cli(self):
        outside = self.root / "outside.yml"
        outside.write_text("name: outside")
        (self.workspace / "link.yml").symlink_to(outside)
        for filename in ("missing.yml", "../outside.yml", str(outside), "link.yml", "."):
            with self.subTest(filename=filename):
                result = self.step("Create CodeQL database", CONFIG_FILE=filename)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse((self.root / "cli.jsonl").exists())

    def test_query_pack_aliases_and_separate_categories(self):
        for language, pack in (("c-cpp", "cpp"), ("java-kotlin", "java"), ("javascript-typescript", "javascript"), ("actions", "actions"), ("python", "python")):
            with self.subTest(language=language):
                result = self.step("Analyze CodeQL database", CODEQL_LANGUAGE=language)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn(f"codeql/{pack}-queries", self.calls()[-1])
                self.assertIn(f"--sarif-category=codeql-cli/{language}", self.calls()[-1])

    def test_upload_matches_merge_commit_and_ref(self):
        result = self.step("Upload code scanning results with the CLI")
        self.assertEqual(result.returncode, 0, result.stderr)
        arguments = self.calls()[-1]
        self.assertIn("--commit=abc123", arguments)
        self.assertIn("--ref=refs/pull/42/merge", arguments)
        self.assertIn("--github-auth-stdin", arguments)
        self.assertNotIn("test-token", arguments)

    def test_wrong_commit_and_cli_errors_fail(self):
        result = self.step("Upload code scanning results with the CLI", CHECKOUT_SHA="wrong")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.root / "cli.jsonl").exists())
        for step in ("Create CodeQL database", "Analyze CodeQL database", "Upload code scanning results with the CLI"):
            with self.subTest(step=step):
                self.assertEqual(self.step(step, CLI_EXIT="7").returncode, 7)

    def test_final_status_does_not_mask_failures(self):
        for detection, analysis, selected, expected in (
            ("success", "success", "true", 0),
            ("success", "skipped", "false", 0),
            ("failure", "skipped", "", 1),
            ("success", "failure", "true", 1),
            ("success", "cancelled", "true", 1),
            ("success", "skipped", "true", 1),
        ):
            with self.subTest(detection=detection, analysis=analysis, selected=selected):
                result = self.step("Report analysis outcome", DETECTION_RESULT=detection, ANALYSIS_RESULT=analysis, HAS_LANGUAGES=selected)
                self.assertEqual(result.returncode, expected, result.stderr)
        for gate in ("failure", "cancelled", "skipped"):
            result = self.step(
                "Report analysis outcome", DETECTION_RESULT="success",
                ANALYSIS_RESULT="success", HAS_LANGUAGES="true", SEVERITY_RESULT=gate,
            )
            self.assertEqual(result.returncode, 1)

    def test_install_rejects_invalid_release_tags(self):
        result = self.step("Install CodeQL CLI and bundled queries", CODEQL_VERSION="v2; echo injected", RUNNER_OS="Linux")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("::error::codeql-version", result.stdout)

    def test_install_checks_bundle_and_exports_cli_path_on_both_runners(self):
        content = b"#!/bin/sh\nprintf 'CodeQL test CLI\\n'\n"
        archive = self.root / "fixture.tar.gz"
        with tarfile.open(archive, "w:gz") as bundle:
            info = tarfile.TarInfo("codeql/codeql")
            info.mode = 0o755
            info.size = len(content)
            bundle.addfile(info, io.BytesIO(content))
        digest = hashlib.sha256(archive.read_bytes()).hexdigest()
        self.environment.update({"FIXTURE_ARCHIVE": str(archive), "FIXTURE_DIGEST": digest})
        self.stub("curl", """#!/usr/bin/env python3
import os, pathlib, shutil, sys
output = pathlib.Path(sys.argv[sys.argv.index("--output") + 1])
url = next(argument for argument in sys.argv if argument.startswith("https://"))
with open(os.environ["RUNNER_TEMP"] + "/urls", "a") as urls:
    urls.write(url + "\\n")
if url.endswith(".checksum.txt"):
    name = url.rsplit("/", 1)[1].removesuffix(".checksum.txt")
    output.write_text(os.environ["FIXTURE_DIGEST"] + "  " + name + "\\n")
else:
    shutil.copyfile(os.environ["FIXTURE_ARCHIVE"], output)
""")
        self.stub("sha256sum", "#!/bin/sh\nexec shasum -a 256 \"$@\"\n")
        for runner, asset, version in (
            ("Linux", "linux64", "latest"),
            ("macOS", "osx64", "codeql-bundle-v2.27.4"),
        ):
            with self.subTest(runner=runner):
                result = self.step("Install CodeQL CLI and bundled queries", RUNNER_OS=runner, CODEQL_VERSION=version)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn("CodeQL test CLI", result.stdout)
                self.assertIn(f"codeql-bundle-{asset}.tar.gz", (self.root / "urls").read_text())
                self.assertIn(str(self.root / "codeql-install" / "codeql"), (self.root / "github-path").read_text())
        failed = self.step(
            "Install CodeQL CLI and bundled queries",
            RUNNER_OS="Linux", CODEQL_VERSION="latest", FIXTURE_DIGEST="0" * 64,
        )
        self.assertNotEqual(failed.returncode, 0)
        self.assertNotIn("CodeQL test CLI", failed.stdout)


class SeverityTests(unittest.TestCase):
    def setUp(self):
        source = run_block("codeql-cli.yml", "Enforce security severity threshold")
        source = source.split("python3 - <<'PY'\n", 1)[1].rsplit("\nPY", 1)[0]
        self.code = {"__name__": "severity_test"}
        exec(compile(source, "severity-gate", "exec"), self.code)
        self.environment = patch.dict(os.environ, {
            "GITHUB_REF": "refs/pull/42/merge", "GITHUB_SHA": "merge",
            "GITHUB_API_URL": "https://api.github.com", "GITHUB_REPOSITORY": "owner/repo",
            "GH_TOKEN": "token",
        })
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.matrix = {"include": [{"language": "python"}]}
        self.event = {"pull_request": {"base": {"ref": "main", "sha": "base"}}}
        self.category = "codeql-cli/python/"
        self.current = "refs/pull/42/merge"
        self.base = "refs/heads/main"
        self.data = {}
        self.calls = []
        self.set_analysis(self.current, "merge", 2)
        self.set_analysis(self.base, "base", 1)

        def api(path, **parameters):
            self.calls.append((path, parameters))
            items = self.data.get((path, parameters["ref"]), [])
            offset = (parameters["page"] - 1) * 100
            return items[offset:offset + 100]

        self.code["api"] = api

    def set_analysis(self, ref, sha, identifier, error=""):
        self.data[("code-scanning/analyses", ref)] = [{
            "id": identifier, "category": self.category, "commit_sha": sha, "error": error,
        }]

    def add_alert(self, number, severity, ref=None, sha="merge", category=None, state="open", dismissed=False):
        ref = ref or self.current
        self.data.setdefault(("code-scanning/alerts", ref), []).append({
            "number": number, "rule": {"security_severity_level": severity},
            "state": "dismissed" if dismissed else "open",
        })
        self.data.setdefault((f"code-scanning/alerts/{number}/instances", ref), []).append({
            "category": category or self.category, "commit_sha": sha, "state": state,
        })

    def evaluate(self, threshold="high", scope="new", event=None, matrix=None):
        return self.code["evaluate"](
            threshold, scope, self.matrix if matrix is None else matrix,
            self.event if event is None else event,
        )

    def test_inclusive_threshold_boundaries(self):
        levels = ["low", "medium", "high", "critical"]
        for threshold_index, threshold in enumerate(levels):
            for severity_index, severity in enumerate(levels):
                with self.subTest(threshold=threshold, severity=severity):
                    self.data[("code-scanning/alerts", self.current)] = []
                    self.add_alert(1, severity)
                    message, blocked = self.evaluate(threshold, "all")
                    self.assertEqual(blocked, severity_index >= threshold_index)
                    self.assertIn(f"threshold={threshold} (inclusive)", message)

    def test_default_new_excludes_baseline_and_all_includes_it(self):
        self.add_alert(1, "critical")
        self.add_alert(1, "critical", ref=self.base, sha="base")
        self.assertFalse(self.evaluate()[1])
        self.assertTrue(self.evaluate(scope="all")[1])
        self.add_alert(2, "high")
        self.assertTrue(self.evaluate()[1])

    def test_existing_lower_severity_is_still_existing(self):
        self.add_alert(1, "high")
        self.add_alert(1, "low", ref=self.base, sha="base")
        self.assertFalse(self.evaluate()[1])

    def test_fixed_on_base_is_reintroduced(self):
        self.add_alert(1, "high")
        self.add_alert(1, "high", ref=self.base, sha="base", state="fixed")
        self.assertTrue(self.evaluate()[1])

    def test_dismissed_fixed_other_category_and_stale_instances_do_not_block(self):
        self.add_alert(1, "critical", dismissed=True)
        self.add_alert(2, "critical", state="fixed")
        self.add_alert(3, "critical", category="some-other-scan/")
        self.add_alert(4, "critical", sha="old")
        self.add_alert(5, None)
        self.assertFalse(self.evaluate()[1])

    def test_uses_all_instances_not_most_recent(self):
        self.add_alert(1, "high", category="unrelated/")
        self.data[("code-scanning/alerts/1/instances", self.current)].append({
            "category": self.category, "commit_sha": "merge", "state": "open",
        })
        self.assertTrue(self.evaluate()[1])

    def test_missing_stale_failed_and_wrong_category_baselines_fail(self):
        for records in (
            [],
            [{"id": 1, "category": self.category, "commit_sha": "old", "error": ""}],
            [{"id": 1, "category": self.category, "commit_sha": "base", "error": "failed"}],
            [{"id": 1, "category": "wrong/", "commit_sha": "base", "error": ""}],
        ):
            with self.subTest(records=records):
                self.data[("code-scanning/analyses", self.base)] = records
                with self.assertRaises(ValueError):
                    self.evaluate()

    def test_latest_analysis_must_match_expected_commit(self):
        self.data[("code-scanning/analyses", self.current)].append({
            "id": 3, "category": self.category, "commit_sha": "new-merge", "error": "",
        })
        with self.assertRaisesRegex(ValueError, "stale"):
            self.evaluate()

    def test_merge_group_and_branch_behavior(self):
        self.add_alert(1, "high")
        self.add_alert(1, "high", ref=self.base, sha="base")
        event = {"merge_group": {"base_ref": self.base, "base_sha": "base"}}
        self.assertFalse(self.evaluate(event=event)[1])
        message, blocked = self.evaluate(event={})
        self.assertTrue(blocked)
        self.assertIn("scope=all", message)

    def test_disabled_empty_and_invalid_options(self):
        self.assertFalse(self.evaluate(threshold="none")[1])
        self.assertEqual(self.calls, [])
        self.assertFalse(self.evaluate(matrix={"include": []})[1])
        self.assertEqual(self.calls, [])
        for threshold, scope in (("typo", "new"), ("none", "typo"), ("high", "typo")):
            with self.subTest(threshold=threshold, scope=scope):
                with self.assertRaises(ValueError):
                    self.evaluate(threshold, scope)

    def test_paginates_alerts_instances_and_analyses(self):
        self.data[("code-scanning/analyses", self.current)] = [
            {"id": 10 + index, "category": "other/", "commit_sha": "merge", "error": ""}
            for index in range(100)
        ] + [{"id": 2, "category": self.category, "commit_sha": "merge", "error": ""}]
        for number in range(101):
            self.add_alert(number, "high", category="other/")
        self.data[("code-scanning/alerts/100/instances", self.current)] = [
            {"category": "other/", "commit_sha": "merge", "state": "open"}
            for _ in range(100)
        ] + [{"category": self.category, "commit_sha": "merge", "state": "open"}]
        self.assertTrue(self.evaluate()[1])
        for path in ("code-scanning/alerts", "code-scanning/analyses", "code-scanning/alerts/100/instances"):
            self.assertTrue(any(p == path and args["page"] == 2 for p, args in self.calls))

    def test_api_errors_and_unknown_severity_fail(self):
        self.add_alert(1, "unknown")
        with self.assertRaisesRegex(ValueError, "Unknown security severity"):
            self.evaluate()

        def forbidden(path, **parameters):
            raise HTTPError("test", 403, "Forbidden", {}, None)

        self.code["api"] = forbidden
        with self.assertRaises(HTTPError):
            self.evaluate()

    def test_changing_analysis_during_evaluation_fails(self):
        original = self.code["api"]
        calls = 0

        def api(path, **parameters):
            nonlocal calls
            if path == "code-scanning/analyses" and parameters["ref"] == self.current:
                calls += 1
                if calls > 1:
                    self.set_analysis(self.current, "merge", 3)
            return original(path, **parameters)

        self.code["api"] = api
        with self.assertRaisesRegex(ValueError, "changed during"):
            self.evaluate()

    def test_multi_language_violation_is_not_hidden_by_clean_language(self):
        matrix = {"include": [{"language": "python"}, {"language": "javascript-typescript"}]}
        for ref, sha in ((self.current, "merge"), (self.base, "base")):
            self.data[("code-scanning/analyses", ref)].append({
                "id": 3, "category": "codeql-cli/javascript-typescript/", "commit_sha": sha, "error": "",
            })
        self.add_alert(1, "critical", category="codeql-cli/javascript-typescript/")
        message, blocked = self.evaluate(matrix=matrix)
        self.assertTrue(blocked)
        self.assertIn("Blocking findings: 1", message)

    def test_main_writes_summary_and_fails_for_violations(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "event").write_text(json.dumps(self.event))
            with patch.dict(os.environ, {
                "GITHUB_EVENT_PATH": str(root / "event"),
                "GITHUB_STEP_SUMMARY": str(root / "summary"),
                "FAIL_ON_SEVERITY": "high", "FINDINGS_SCOPE": "new",
                "LANGUAGE_MATRIX": json.dumps(self.matrix),
            }):
                self.add_alert(1, "critical")
                with self.assertRaises(SystemExit) as exited:
                    self.code["main"]()
                self.assertEqual(exited.exception.code, 1)
                self.assertIn("critical=1", (root / "summary").read_text())


if __name__ == "__main__":
    unittest.main()
