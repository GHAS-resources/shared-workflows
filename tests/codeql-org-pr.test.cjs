'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { gunzipSync } = require('node:zlib');
const {
  validateTarget, eligible, dispatch, treePaths, languageMatrix, prepare, upload,
} = require('../.github/scripts/codeql-org-pr.cjs');

function pull(overrides = {}) {
  return {
    number: 42, state: 'open', mergeable: true, merge_commit_sha: 'merge',
    head: { sha: 'head', repo: { id: 1 } },
    base: { sha: 'base', ref: 'main', repo: { id: 1 } },
    ...overrides,
  };
}

function logger() {
  const outputs = {};
  const messages = [];
  const summary = {
    addHeading() { return this; },
    addRaw() { return this; },
    async write() {},
  };
  return {
    outputs, messages, summary,
    setOutput(key, value) { outputs[key] = value; },
    info(message) { messages.push(message); },
    error(message) { messages.push(message); },
    warning(message) { messages.push(message); },
    notice(message) { messages.push(message); },
  };
}

function prepareApi(pr = pull(), filenames = ['app.py'], commitOverrides = {}) {
  return {
    rest: {
      pulls: { get: async () => ({ data: pr }) },
      git: {
        getCommit: async () => ({
          data: {
            sha: 'merge', tree: { sha: 'tree' },
            parents: [{ sha: 'base' }, { sha: 'head' }], ...commitOverrides,
          },
        }),
        getTree: async () => ({
          data: { truncated: false, tree: filenames.map((filename) => ({ type: 'blob', path: filename })) },
        }),
      },
    },
  };
}

test('scope validation rejects foreign owners, malformed names and unsafe PR numbers', () => {
  assert.deepEqual(validateTarget('ACME/a.b-c_d', '42', 'acme'), {
    owner: 'ACME', repo: 'a.b-c_d', pull_number: 42,
  });
  for (const [repository, number] of [
    ['other/repo', '42'], ['acme/repo/extra', '42'], ['acme/repo;echo', '42'],
    ['acme/.', '42'], ['acme/..', '42'],
    ['acme/repo', '0'], ['acme/repo', '1e2'], ['acme/repo', '-1'],
    ['acme/repo', '9007199254740992'], ['acme/repo', ''],
  ]) assert.throws(() => validateTarget(repository, number, 'acme'));
});

test('only same-repository open PRs are eligible, including drafts', () => {
  assert.equal(eligible(pull({ draft: true })), true);
  assert.equal(eligible(pull({ state: 'closed' })), false);
  assert.equal(eligible(pull({ head: { repo: { id: 2 } } })), false);
  assert.equal(eligible(pull({ head: { repo: null } })), false);
});

test('language matrix includes every supported family and uses isolated runners', () => {
  const matrix = languageMatrix([
    'src/a.cpp', 'include/a.h', 'src/a.cs', 'src/main.go', 'src/a.java',
    'src/a.tsx', 'src/a.py', 'src/a.rb', 'src/main.rs', 'src/a.swift',
    '.github/workflows/test.yml', 'custom/action.yaml', 'docs/readme.md',
  ]);
  assert.equal(matrix.include.length, 10);
  const modes = Object.fromEntries(matrix.include.map((row) => [row.language, row.build_mode]));
  assert.equal(modes['java-kotlin'], 'none');
  assert.equal(modes['c-cpp'], 'none');
  assert.equal(modes.csharp, 'none');
  assert.equal(modes.rust, 'none');
  assert.equal(modes.go, 'autobuild');
  assert.equal(modes.swift, 'autobuild');
  assert.equal(matrix.include.find((row) => row.language === 'swift').runner, 'macos-latest');
  assert.ok(matrix.include.filter((row) => row.language !== 'swift')
    .every((row) => row.runner === 'ubuntu-latest'));
});

test('Kotlin forces autobuild even when Java is also present', () => {
  for (const kotlin of ['src/Main.kt', 'build.gradle.kts']) {
    assert.equal(languageMatrix(['A.java', kotlin]).include[0].build_mode, 'autobuild');
  }
});

test('detects supported suffix variants without treating arbitrary YAML as Actions', () => {
  assert.equal(languageMatrix(['a.mts', 'a.cts', 'a.cjs', 'a.vue']).include[0].language,
    'javascript-typescript');
  assert.equal(languageMatrix(['source.CXX']).include[0].language, 'c-cpp');
  assert.deepEqual(languageMatrix(['readme.md', 'config.yaml', 'file.txt']), { include: [] });
});

test('tree fallback walks every subtree and ignores submodules', async () => {
  const calls = [];
  const github = {
    rest: { git: { async getTree(args) {
      calls.push(args);
      if (args.recursive) return { data: { truncated: true, tree: [{ type: 'blob', path: 'incomplete.py' }] } };
      if (args.tree_sha === 'root') return { data: { tree: [
        { type: 'tree', sha: 'sub', path: 'src' },
        { type: 'blob', path: 'main.go' },
        { type: 'commit', path: 'submodule' },
      ] } };
      return { data: { tree: [{ type: 'blob', path: 'new.kt' }] } };
    } } },
  };
  assert.deepEqual(await treePaths(github, { owner: 'acme', repo: 'repo' }, 'root'),
    ['main.go', 'src/new.kt']);
  assert.equal(calls.length, 3);
});

test('non-recursive truncation is an explicit error', async () => {
  const github = { rest: { git: { getTree: async () => ({ data: { truncated: true, tree: [] } }) } } };
  await assert.rejects(treePaths(github, { owner: 'acme', repo: 'repo' }, 'root'), /truncated/);
});

test('prepare snapshots merge parents and detects languages introduced on the PR', async () => {
  const core = logger();
  await prepare({
    github: prepareApi(pull(), ['existing.js', 'new-language.py']), core,
    repository: 'acme/repo', pullNumber: '42', org: 'acme',
  });
  assert.equal(core.outputs.scan, 'true');
  assert.equal(core.outputs.sha, 'merge');
  assert.equal(core.outputs.head, 'head');
  assert.equal(core.outputs.base_ref, 'refs/heads/main');
  assert.deepEqual(core.outputs.matrix.include.map((row) => row.language),
    ['javascript-typescript', 'python']);
});

test('prepare skips fork, closed, conflicting, and unsupported-language PRs', async () => {
  for (const pr of [
    pull({ head: { repo: { id: 2 } } }), pull({ state: 'closed' }), pull({ mergeable: false }),
  ]) {
    const core = logger();
    await prepare({ github: prepareApi(pr), core, repository: 'acme/repo', pullNumber: '42', org: 'acme' });
    assert.equal(core.outputs.scan, 'false');
    assert.ok(core.messages.length);
  }
  const core = logger();
  await prepare({
    github: prepareApi(pull(), ['README.md']), core,
    repository: 'acme/repo', pullNumber: '42', org: 'acme',
  });
  assert.equal(core.outputs.scan, 'false');
});

test('prepare refuses pending and stale merge snapshots', async () => {
  await assert.rejects(prepare({
    github: prepareApi(pull({ mergeable: null })), core: logger(),
    repository: 'acme/repo', pullNumber: '42', org: 'acme',
  }), /not computed/);
  await assert.rejects(prepare({
    github: prepareApi(pull(), ['a.py'], { parents: [{ sha: 'old-base' }, { sha: 'head' }] }),
    core: logger(), repository: 'acme/repo', pullNumber: '42', org: 'acme',
  }), /stale/);
});

function dispatchFixture({ eventName = 'schedule', clientPayload, failDispatch = false, failRepo = false } = {}) {
  const calls = [];
  const pauses = [];
  const core = logger();
  const listForOrg = () => {};
  const list = () => {};
  const github = {
    rest: {
      repos: { listForOrg },
      pulls: { list, get: async () => ({ data: pull() }) },
    },
    paginate: {
      async *iterator(method, args) {
        if (method === listForOrg) {
          yield { data: [{ name: 'one', full_name: 'acme/one' }] };
          yield { data: [
            { name: 'archived', archived: true },
            { name: 'disabled', disabled: true },
            { name: 'two', full_name: 'acme/two' },
          ] };
        } else {
          if (failRepo && args.repo === 'one') throw new Error('Repository inaccessible');
          yield { data: [pull()] };
          yield { data: [pull({ number: 43, head: { repo: { id: 2 } } })] };
        }
      },
    },
  };
  const dispatcher = {
    rest: {
      repos: { get: async () => ({ data: { default_branch: 'production' } }) },
      actions: { async createWorkflowDispatch(args) {
        calls.push(args);
        if (failDispatch && args.inputs.repository === 'acme/one') throw new Error('Forbidden');
      } },
    },
  };
  const options = {
    github, dispatcher, core, org: 'acme',
    context: {
      repo: { owner: 'central', repo: 'controller' },
      eventName, payload: { client_payload: clientPayload },
    },
    pause: async (ms) => { pauses.push(ms); },
  };
  return { calls, pauses, core, options };
}

test('dispatcher traverses all pages, excludes forks, and dispatches to default branch', async () => {
  const fixture = dispatchFixture();
  await dispatch(fixture.options);
  assert.equal(fixture.calls.length, 2);
  assert.deepEqual(fixture.calls.map((call) => call.inputs.repository), ['acme/one', 'acme/two']);
  assert.ok(fixture.calls.every((call) => call.ref === 'production' &&
    call.workflow_id === 'codeql-pr-scan.yml' &&
    call.owner === 'central'));
  assert.deepEqual(fixture.pauses, [1000, 1000]);
});

test('dispatch failures remain visible while later repositories still dispatch', async () => {
  for (const failure of [{ failDispatch: true }, { failRepo: true }]) {
    const fixture = dispatchFixture(failure);
    await assert.rejects(dispatch(fixture.options), /Dispatch incomplete/);
    assert.ok(fixture.calls.some((call) => call.inputs.repository === 'acme/two'));
  }
});

test('webhook dispatch targets one validated PR without enumerating the organization', async () => {
  const fixture = dispatchFixture({
    eventName: 'repository_dispatch',
    clientPayload: { repository: 'acme/repo', pull_number: 42 },
  });
  await dispatch(fixture.options);
  assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.calls[0].inputs.repository, 'acme/repo');
  fixture.options.context.payload.client_payload.repository = 'other/repo';
  await assert.rejects(dispatch(fixture.options), /organization-owned/);
});

async function uploadFixture(t, { pr = pull(), languages = ['javascript-typescript'], status = 'complete' } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'central-codeql-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const sarif = JSON.stringify({ version: '2.1.0', runs: [] });
  // CodeQL normalizes language aliases: javascript-typescript produces javascript.sarif.
  await fs.mkdir(path.join(directory, 'sarif-javascript-typescript'));
  await fs.writeFile(path.join(directory, 'sarif-javascript-typescript', 'javascript.sarif'), sarif);
  await fs.writeFile(path.join(directory, 'sarif-javascript-typescript', 'checkout-uri.txt'),
    'file:///Users/runner/work/controller/source/\n');
  const uploads = [];
  let polls = 0;
  const github = {
    rest: {
      pulls: { get: async () => ({ data: pr }) },
      codeScanning: {
        async uploadSarif(args) { uploads.push(args); return { data: { id: 'sarif-id' } }; },
        async getSarif() {
          polls++;
          return { data: { processing_status: status, errors: ['rejected'] } };
        },
      },
    },
  };
  return {
    uploads, sarif, get polls() { return polls; },
    options: {
      github, core: logger(), pause: async () => {},
      env: {
        TARGET_REPOSITORY: 'acme/repo', PULL_NUMBER: '42', CODEQL_ORG: 'acme',
        MERGE_SHA: 'merge', HEAD_SHA: 'head', BASE_SHA: 'base', BASE_REF: 'refs/heads/main',
        LANGUAGE_MATRIX: JSON.stringify({ include: languages.map((language) => ({ language })) }),
        SARIF_DIRECTORY: directory, GITHUB_WORKSPACE: '/work/controller',
      },
    },
  };
}

test('uploads gzip/base64 SARIF to the target merge ref and waits for processing', async (t) => {
  const fixture = await uploadFixture(t);
  await upload(fixture.options);
  assert.equal(fixture.uploads.length, 1);
  const submitted = fixture.uploads[0];
  assert.equal(submitted.owner, 'acme');
  assert.equal(submitted.repo, 'repo');
  assert.equal(submitted.ref, 'refs/pull/42/merge');
  assert.equal(submitted.commit_sha, 'merge');
  assert.equal(submitted.base_sha, 'base');
  assert.equal(submitted.checkout_uri, 'file:///Users/runner/work/controller/source/');
  assert.equal(gunzipSync(Buffer.from(submitted.sarif, 'base64')).toString(), fixture.sarif);
  assert.equal(fixture.polls, 1);
});

test('upload rejects moved, closed, and fork PRs before sending results', async (t) => {
  for (const pr of [
    pull({ state: 'closed' }), pull({ merge_commit_sha: 'new-merge' }),
    pull({ head: { sha: 'new-head', repo: { id: 1 } } }),
    pull({ base: { sha: 'new-base', repo: { id: 1 } } }),
    pull({ head: { sha: 'head', repo: { id: 2 } } }),
  ]) {
    const fixture = await uploadFixture(t, { pr });
    await assert.rejects(upload(fixture.options), /Refusing stale upload/);
    assert.equal(fixture.uploads.length, 0);
  }
});

test('upload preserves successful language results but reports missing ones', async (t) => {
  const fixture = await uploadFixture(t, { languages: ['python', 'javascript-typescript'] });
  await assert.rejects(upload(fixture.options), /Missing SARIF for python/);
  assert.equal(fixture.uploads.length, 1);
});

test('upload surfaces server processing failures and timeouts', async (t) => {
  for (const [status, message] of [
    ['failed', /SARIF processing failed/], ['pending', /within five minutes/],
  ]) {
    const fixture = await uploadFixture(t, { status });
    await assert.rejects(upload(fixture.options), message);
    assert.equal(fixture.polls, status === 'pending' ? 60 : 1);
  }
});

test('upload surfaces permission failures instead of reporting success', async (t) => {
  const fixture = await uploadFixture(t);
  fixture.options.github.rest.codeScanning.uploadSarif = async () => { throw new Error('Resource not accessible'); };
  await assert.rejects(upload(fixture.options), /Resource not accessible/);
});
