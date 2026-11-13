'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { gunzipSync } = require('node:zlib');
const {
  configuration, checkpoint, selectedRepository, dispatch, detect, prepare, deliver,
} = require('../.github/scripts/codeql-org-scheduled.cjs');

const config = (overrides = {}) => ({ ...configuration({ CODEQL_ORG: 'acme' }), ...overrides });
const core = () => ({
  outputs: {}, messages: [],
  setOutput(key, value) { this.outputs[key] = value; },
  info(message) { this.messages.push(message); },
  error(message) { this.messages.push(message); },
  notice(message) { this.messages.push(message); },
  summary: { addHeading() { return this; }, addRaw() { return this; }, async write() {} },
});
const repository = (name = 'repo', overrides = {}) => ({
  name, full_name: `acme/${name}`, default_branch: 'main', size: 1, ...overrides,
});
const artifact = (name, overrides = {}) => ({
  name, expired: false, workflow_run: { id: 1 }, ...overrides,
});

function controllerFixture(available = []) {
  const calls = [];
  const listArtifactsForRepo = () => {};
  const controller = {
    async paginate(method, args) {
      assert.equal(method, listArtifactsForRepo);
      assert.equal(args.per_page, 100);
      return available;
    },
    rest: {
      repos: { get: async () => ({ data: { default_branch: 'production' } }) },
      actions: {
        listArtifactsForRepo,
        getWorkflowRun: async () => ({
          data: { conclusion: 'success', path: '.github/workflows/codeql-branch-scan.yml' },
        }),
        createWorkflowDispatch: async (args) => { calls.push(args); },
      },
    },
  };
  return { controller, calls };
}

function sourceFixture(pages = [[repository()]]) {
  const listForOrg = () => {};
  const github = {
    rest: {
      repos: {
        listForOrg, listBranches: () => {},
        get: async () => ({ data: repository() }),
        getBranch: async ({ branch }) => ({ data: { commit: { sha: branch === 'main' ? 'sha' : 'other' } } }),
        getAllCustomPropertyValues: async () => ({ data: [{ property_name: 'scan', value: 'true' }] }),
        listLanguages: async () => ({ data: { Java: 10, Python: 5, Markdown: 20 } }),
      },
      git: {
        getCommit: async () => ({ data: { sha: 'sha', tree: { sha: 'tree' } } }),
        getTree: async () => ({
          data: { truncated: false, tree: [
            { type: 'blob', path: 'branch-only.rs' },
            { type: 'blob', path: 'Main.kt' },
            { type: 'blob', path: '.github/workflows/check.yml' },
          ] },
        }),
      },
    },
    paginate: Object.assign(async (method) => {
      assert.equal(method, github.rest.repos.listBranches);
      return [{ name: 'main' }, { name: 'feature/slash' }];
    }, { async *iterator(method) {
      assert.equal(method, listForOrg);
      for (const data of pages) yield { data };
    } }),
  };
  return github;
}

test('configuration defaults and invalid values, including endpoint credential leakage', () => {
  const defaults = config();
  assert.equal(defaults.interval, 60);
  assert.equal(defaults.property, '');
  assert.equal(defaults.branches, 'default');
  assert.equal(defaults.changesOnly, 'true');
  assert.equal(defaults.destination, 'github');
  for (const environment of [
    { CODEQL_INTERVAL_MINUTES: '4' }, { CODEQL_INTERVAL_MINUTES: '1.5' },
    { CODEQL_INTERVAL_MINUTES: 'NaN' }, { CODEQL_BRANCHES: 'tags' },
    { CODEQL_CHANGES_ONLY: 'yes' }, { CODEQL_DETECTION_MODE: 'manual' },
    { CODEQL_DESTINATION: 'ftp' }, { CODEQL_EXPORT_FORMAT: 'xml' },
    { CODEQL_ORG: '../bad' },
    ...['', 'http://example.test', 'https://user:secret@example.test', 'https://example.test/#secret']
      .map((endpoint) => ({ CODEQL_DESTINATION: 'endpoint', CODEQL_EXPORT_ENDPOINT: endpoint })),
  ]) assert.throws(() => configuration({ CODEQL_ORG: 'acme', ...environment }));
  assert.equal(configuration({ CODEQL_ORG: 'acme', CODEQL_INTERVAL_MINUTES: '90' }).interval, 90);
});

test('property is opt-in only when configured and API errors propagate', async () => {
  const github = sourceFixture();
  github.rest.repos.getAllCustomPropertyValues = async () => { throw new Error('Forbidden'); };
  assert.equal(await selectedRepository(github, repository(), config()), true);
  await assert.rejects(selectedRepository(github, repository(), config({ property: 'scan' })), /Forbidden/);
  for (const value of [true, 'true', false, 'false', null, '', 'TRUE', ['true']]) {
    github.rest.repos.getAllCustomPropertyValues = async () => ({
      data: [{ property_name: 'scan', value }],
    });
    assert.equal(await selectedRepository(github, repository(), config({ property: 'scan' })),
      value === true || value === 'true');
    assert.equal(await selectedRepository(github, repository(), config({ property: 'missing' })), false);
  }
  for (const override of [{ archived: true }, { disabled: true }, { size: 0 }, { default_branch: null }]) {
    assert.equal(await selectedRepository(github, repository('repo', override), config()), false);
  }
});

test('dispatcher visits every repo page and every branch without a global matrix', async () => {
  const fixture = controllerFixture();
  const github = sourceFixture([[repository('one')], [
    repository('archived', { archived: true }), repository('two'),
  ]]);
  const log = core();
  await dispatch({
    github, dispatcher: fixture.controller, context: { repo: { owner: 'central', repo: 'control' } },
    core: log, config: config({ branches: 'all' }), pause: async () => {},
  });
  assert.deepEqual(fixture.calls.map((call) => call.inputs), [
    { repository: 'acme/one', branch: 'main' }, { repository: 'acme/one', branch: 'feature/slash' },
    { repository: 'acme/two', branch: 'main' }, { repository: 'acme/two', branch: 'feature/slash' },
  ]);
  assert.ok(fixture.calls.every((call) => call.ref === 'production' && call.workflow_id === 'codeql-branch-scan.yml'));
  assert.equal(log.outputs.polled, 'true');
});

test('interval gates scheduled sweeps at exact thresholds; manual sweeps bypass it', async () => {
  const fixture = controllerFixture();
  const log = core();
  const options = {
    github: sourceFixture(), dispatcher: fixture.controller,
    context: { repo: { owner: 'central', repo: 'control' }, eventName: 'schedule' },
    core: log, config: config({ interval: 17 }), pause: async () => {},
    now: Date.parse('2026-11-12T12:00:00Z'),
  };
  await dispatch(options);
  const marker = artifact(log.outputs.poll_name, { created_at: '2026-11-12T12:00:00Z' });
  fixture.controller.paginate = async () => [marker];
  fixture.calls.length = 0;
  await dispatch({ ...options, now: options.now + 17 * 60000 - 1 });
  assert.equal(fixture.calls.length, 0);
  assert.equal(log.outputs.polled, 'false');
  await dispatch({ ...options, now: options.now + 17 * 60000 });
  assert.equal(fixture.calls.length, 1);
  await dispatch({ ...options, context: { ...options.context, eventName: 'workflow_dispatch' } });
  assert.equal(fixture.calls.length, 2);
});

test('skip only successful current-config SHAs; forced scans, new SHAs and failed runs retry', async () => {
  const cfg = config();
  const name = `${checkpoint('acme/repo', 'main', cfg)}-sha`;
  const fixture = controllerFixture([artifact(name)]);
  const options = {
    github: sourceFixture(), dispatcher: fixture.controller,
    context: { repo: { owner: 'central', repo: 'control' } }, core: core(),
    config: cfg, pause: async () => {},
  };
  await dispatch(options);
  assert.equal(fixture.calls.length, 0);
  await dispatch({ ...options, config: config({ changesOnly: 'false' }) });
  assert.equal(fixture.calls.length, 1);
  assert.notEqual(checkpoint('acme/repo', 'main', cfg),
    checkpoint('acme/repo', 'main', config({ destination: 'endpoint', endpoint: 'https://example.test' })));
  fixture.controller.rest.actions.getWorkflowRun = async () => ({ data: { conclusion: 'failure' } });
  await dispatch(options);
  assert.equal(fixture.calls.length, 2);
  fixture.controller.paginate = async () => [artifact(name.replace(/-sha$/, '-old'))];
  await dispatch(options);
  assert.equal(fixture.calls.length, 3);
});

test('discovery continues past inaccessible repos but does not advance polling marker', async () => {
  const fixture = controllerFixture();
  const github = sourceFixture([[repository('bad'), repository('good')]]);
  github.rest.repos.getBranch = async ({ repo }) => {
    if (repo === 'bad') throw new Error('Forbidden');
    return { data: { commit: { sha: 'sha' } } };
  };
  const log = core();
  await assert.rejects(dispatch({
    github, dispatcher: fixture.controller, context: { repo: {} }, core: log,
    config: config(), pause: async () => {},
  }), /Discovery incomplete/);
  assert.equal(fixture.calls[0].inputs.repository, 'acme/good');
  assert.equal(log.outputs.polled, undefined);
});

test('expired checkpoints and artifacts from other workflows never suppress scanning', async () => {
  const cfg = config();
  const name = `${checkpoint('acme/repo', 'main', cfg)}-sha`;
  for (const [available, result] of [
    [[artifact(name, { expired: true })], { conclusion: 'success', path: '.github/workflows/codeql-branch-scan.yml' }],
    [[artifact(name)], { conclusion: 'success', path: '.github/workflows/other.yml' }],
    [[artifact(name)], { conclusion: null, path: '.github/workflows/codeql-branch-scan.yml' }],
  ]) {
    const fixture = controllerFixture(available);
    fixture.controller.rest.actions.getWorkflowRun = async () => ({ data: result });
    await dispatch({
      github: sourceFixture(), dispatcher: fixture.controller,
      context: { repo: {} }, core: core(), config: cfg, pause: async () => {},
    });
    assert.equal(fixture.calls.length, 1);
  }
});

test('automatic matches CLI aliases; computed sees languages only present on this branch', async () => {
  const github = sourceFixture();
  const target = { owner: 'acme', repo: 'repo' };
  const commit = { tree: { sha: 'tree' } };
  const automatic = await detect(github, target, commit, 'automatic');
  assert.deepEqual(automatic.include.map((row) => row.language), ['actions', 'java-kotlin', 'python']);
  assert.equal(automatic.include.find((row) => row.language === 'java-kotlin').build_mode, 'autobuild');
  const computed = await detect(github, target, commit, 'computed');
  assert.deepEqual(computed.include.map((row) => row.language), ['actions', 'java-kotlin', 'rust']);
  github.rest.repos.listLanguages = async () => ({
    data: { JavaScript: 100, TypeScript: 100, C: 100, 'C++': 100, YAML: 100 },
  });
  assert.deepEqual((await detect(github, target, commit, 'automatic')).include.map((row) => row.language),
    ['actions', 'c-cpp', 'javascript-typescript']);
});

test('preparation pins SHA and revalidates property, branch scope and successful checkpoints', async () => {
  const github = sourceFixture();
  const fixture = controllerFixture();
  const options = {
    github, controller: fixture.controller, context: { repo: {} }, core: core(),
    config: config(), repository: 'acme/repo', branch: 'main',
  };
  await prepare(options);
  assert.equal(options.core.outputs.sha, 'sha');
  assert.equal(options.core.outputs.scan, 'true');
  const savedCheckpoint = options.core.outputs.checkpoint;
  fixture.controller.paginate = async () => [artifact(savedCheckpoint)];
  options.core = core();
  await prepare(options);
  assert.equal(options.core.outputs.scan, 'false');
  for (const overrides of [
    { branch: 'feature/slash' },
    { config: config({ property: 'not-set' }) },
  ]) {
    const log = core();
    await prepare({ ...options, ...overrides, core: log });
    assert.equal(log.outputs.scan, 'false');
  }
  await assert.rejects(prepare({ ...options, repository: 'foreign/repo' }), /organization-owned/);
  await assert.rejects(prepare({ ...options, branch: 'refs/heads/main' }), /short branch/);
});

test('unsupported branch trees are explicit skips without checkpoints', async () => {
  const github = sourceFixture();
  github.rest.git.getTree = async () => ({
    data: { truncated: false, tree: [{ type: 'blob', path: 'README.md' }] },
  });
  const log = core();
  await prepare({
    github, controller: controllerFixture().controller, context: { repo: {} }, core: log,
    config: config({ detection: 'computed' }), repository: 'acme/repo', branch: 'main',
  });
  assert.equal(log.outputs.scan, 'false');
  assert.equal(log.outputs.checkpoint, undefined);
  assert.match(log.messages[0], /No supported/);
});

async function deliveryFixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'scheduled-codeql-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.mkdir(path.join(directory, 'sarif-python'));
  await fs.writeFile(path.join(directory, 'sarif-python', 'python.sarif'),
    JSON.stringify({ version: '2.1.0', runs: [{ results: [], versionControlProvenance: [{ repositoryUri: 'wrong' }] }] }));
  await fs.writeFile(path.join(directory, 'sarif-python', 'checkout-uri.txt'), 'file:///runner/source/\n');
  const uploads = [];
  const posts = [];
  const options = {
    github: { rest: { codeScanning: {
      uploadSarif: async (args) => { uploads.push(args); return { data: { id: 1 } }; },
      getSarif: async () => ({ data: { processing_status: 'complete' } }),
    } } },
    core: core(), config: config(), pause: async () => {},
    fetchImpl: async (url, request) => { posts.push({ url, ...request }); return { ok: true }; },
    env: {
      TARGET_REPOSITORY: 'acme/repo', TARGET_BRANCH: 'release/1', TARGET_SHA: 'immutable',
      GITHUB_SERVER_URL: 'https://github.com',
      LANGUAGE_MATRIX: JSON.stringify({ include: [{ language: 'python' }] }),
      SARIF_DIRECTORY: directory, EXPORT_TOKEN: 'export-only',
    },
  };
  return { directory, options, uploads, posts };
}

test('GitHub delivery targets branch and SHA and corrects central SARIF provenance', async (t) => {
  const fixture = await deliveryFixture(t);
  await deliver(fixture.options);
  assert.equal(fixture.posts.length, 0);
  assert.equal(fixture.uploads.length, 1);
  const upload = fixture.uploads[0];
  assert.equal(upload.ref, 'refs/heads/release/1');
  assert.equal(upload.commit_sha, 'immutable');
  assert.equal(upload.checkout_uri, 'file:///runner/source/');
  const sarif = JSON.parse(gunzipSync(Buffer.from(upload.sarif, 'base64')));
  assert.deepEqual(sarif.runs[0].versionControlProvenance, [{
    repositoryUri: 'https://github.com/acme/repo', revisionId: 'immutable', branch: 'release/1',
  }]);
});

test('both endpoint formats preserve results; JSON adds source metadata; neither uploads to GitHub', async (t) => {
  for (const format of ['sarif', 'json']) {
    const fixture = await deliveryFixture(t);
    fixture.options.config = config({ destination: 'endpoint', endpoint: 'https://example.test/ingest', format });
    await deliver(fixture.options);
    assert.equal(fixture.uploads.length, 0);
    const post = fixture.posts[0];
    assert.equal(post.method, 'POST');
    assert.equal(post.redirect, 'error');
    assert.equal(post.headers.Authorization, 'Bearer export-only');
    const body = JSON.parse(post.body);
    if (format === 'json') {
      assert.equal(body.repository, 'acme/repo');
      assert.equal(body.commit_sha, 'immutable');
      assert.equal(body.language, 'python');
      assert.equal(body.sarif.version, '2.1.0');
    } else assert.equal(body.version, '2.1.0');
  }
});

test('delivery fails on missing language, processing failures, timeout or endpoint rejection', async (t) => {
  const fixture = await deliveryFixture(t);
  const api = fixture.options.github.rest.codeScanning;
  api.getSarif = async () => ({ data: { processing_status: 'failed', errors: ['invalid'] } });
  await assert.rejects(deliver(fixture.options), /processing failed/);
  api.getSarif = async () => ({ data: { processing_status: 'pending' } });
  await assert.rejects(deliver(fixture.options), /timed out/);
  fixture.options.config = config({ destination: 'endpoint', endpoint: 'https://example.test' });
  fixture.options.fetchImpl = async () => ({ ok: false, status: 503 });
  await assert.rejects(deliver(fixture.options), /HTTP 503/);
  fixture.options.fetchImpl = async () => { throw new Error('Redirect rejected'); };
  await assert.rejects(deliver(fixture.options), /Redirect rejected/);
  fixture.options.env.LANGUAGE_MATRIX = JSON.stringify({ include: [{ language: 'missing' }] });
  await assert.rejects(deliver(fixture.options), /ENOENT/);
});
