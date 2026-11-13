'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { gzipSync } = require('node:zlib');
const { validateTarget, treePaths, languageMatrix, matrixFor } = require('./codeql-org-pr.cjs');

const WORKER = 'codeql-branch-scan.yml';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hash = (value) => createHash('sha256').update(value).digest('hex');

function configuration(env) {
  const config = {
    org: env.CODEQL_ORG,
    interval: Number(env.CODEQL_INTERVAL_MINUTES || '60'),
    property: env.CODEQL_CUSTOM_PROPERTY || '',
    branches: env.CODEQL_BRANCHES || 'default',
    changesOnly: env.CODEQL_CHANGES_ONLY || 'true',
    detection: env.CODEQL_DETECTION_MODE || 'automatic',
    destination: env.CODEQL_DESTINATION || 'github',
    format: env.CODEQL_EXPORT_FORMAT || 'sarif',
    endpoint: env.CODEQL_EXPORT_ENDPOINT || '',
  };
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(config.org || '') ||
      !Number.isSafeInteger(config.interval) || config.interval < 5 ||
      !['default', 'all'].includes(config.branches) ||
      !['true', 'false'].includes(config.changesOnly) ||
      !['automatic', 'computed'].includes(config.detection) ||
      !['github', 'endpoint'].includes(config.destination) ||
      !['sarif', 'json'].includes(config.format)) {
    throw new Error('Invalid scheduled CodeQL configuration; see docs/codeql-org-scheduled/README.md.');
  }
  if (config.destination === 'endpoint') {
    const url = new URL(config.endpoint);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
      throw new Error('The export endpoint must be HTTPS without credentials or a fragment.');
    }
  }
  return config;
}

function checkpoint(repository, branch, config) {
  return `codeql-branch-${hash(JSON.stringify([repository.toLowerCase(), branch, config]))}`;
}

async function artifacts(github, central) {
  return github.paginate(github.rest.actions.listArtifactsForRepo, {
    ...central, per_page: 100,
  });
}

async function completed(github, central, artifact, runs) {
  const id = artifact.workflow_run?.id;
  if (!id || artifact.expired) return false;
  if (!runs.has(id)) {
    const { data } = await github.rest.actions.getWorkflowRun({ ...central, run_id: id });
    runs.set(id, data.conclusion === 'success' && data.path === `.github/workflows/${WORKER}`);
  }
  return runs.get(id);
}

async function alreadyDelivered(github, central, available, name, runs = new Map()) {
  for (const artifact of available.filter((item) => item.name === name)) {
    if (await completed(github, central, artifact, runs)) return true;
  }
  return false;
}

async function selectedRepository(github, repo, config) {
  if (repo.archived || repo.disabled || !repo.default_branch || repo.size === 0) return false;
  if (!config.property) return true;
  const { data } = await github.rest.repos.getAllCustomPropertyValues({
    owner: config.org, repo: repo.name,
  });
  return data.some((item) => item.property_name === config.property &&
    (item.value === true || item.value === 'true'));
}

async function dispatch({ github, dispatcher, context, core, config, pause = sleep, now = Date.now() }) {
  const central = context.repo;
  const available = await artifacts(dispatcher, central);
  const pollName = `codeql-org-poll-${hash(JSON.stringify(config))}`;
  if (context.eventName === 'schedule' && available.some((item) =>
    item.name === pollName && !item.expired &&
    now - Date.parse(item.created_at) < config.interval * 60000)) {
    core.info('Configured polling interval has not elapsed.');
    core.setOutput('polled', 'false');
    return;
  }
  const { data: controller } = await dispatcher.rest.repos.get(central);
  const runs = new Map();
  const failures = [];
  let count = 0;
  for await (const page of github.paginate.iterator(github.rest.repos.listForOrg, {
    org: config.org, type: 'all', per_page: 100,
  })) {
    for (const repo of page.data) {
      try {
        if (!await selectedRepository(github, repo, config)) continue;
        const branches = config.branches === 'all'
          ? await github.paginate(github.rest.repos.listBranches, {
            owner: config.org, repo: repo.name, per_page: 100,
          })
          : [{ name: repo.default_branch }];
        for (const branch of branches) {
          // Resolve the branch now; the worker independently resolves an immutable snapshot.
          const { data } = await github.rest.repos.getBranch({
            owner: config.org, repo: repo.name, branch: branch.name,
          });
          const name = `${checkpoint(repo.full_name, branch.name, config)}-${data.commit.sha}`;
          if (config.changesOnly === 'true' &&
              await alreadyDelivered(dispatcher, central, available, name, runs)) continue;
          await dispatcher.rest.actions.createWorkflowDispatch({
            ...central, workflow_id: WORKER, ref: controller.default_branch,
            inputs: { repository: repo.full_name, branch: branch.name },
          });
          count++;
          await pause(1000);
        }
      } catch (error) {
        failures.push(`${repo.full_name}: ${error.message}`);
        core.error(failures.at(-1));
      }
    }
  }
  await core.summary.addHeading('Scheduled organization CodeQL discovery')
    .addRaw(`Dispatched ${count} branch workers. Errors: ${failures.length}.`).write();
  if (failures.length) throw new Error(`Discovery incomplete:\n${failures.join('\n')}`);
  core.setOutput('polled', 'true');
  core.setOutput('poll_name', pollName);
}

async function detect(github, target, commit, mode) {
  const paths = await treePaths(github, target, commit.tree.sha);
  if (mode === 'computed') return languageMatrix(paths);
  // Match the CLI workflow's Linguist aliases and build modes. Tree detection
  // additionally identifies Actions and whether this branch contains Kotlin.
  const aliases = {
    C: 'c-cpp', 'C++': 'c-cpp', 'C#': 'csharp', Go: 'go',
    Java: 'java-kotlin', Kotlin: 'java-kotlin',
    JavaScript: 'javascript-typescript', TypeScript: 'javascript-typescript',
    Python: 'python', Ruby: 'ruby', Rust: 'rust', Swift: 'swift',
  };
  const { data } = await github.rest.repos.listLanguages(target);
  const selected = new Set(Object.keys(data).filter((name) => aliases[name]).map((name) => aliases[name]));
  if (paths.some((filename) => /^\.github\/workflows\/[^/]+\.ya?ml$/i.test(filename))) {
    selected.add('actions');
  }
  return matrixFor(selected, 'Kotlin' in data || paths.some((filename) => /\.kts?$/i.test(filename)));
}

async function prepare({ github, controller, context, core, config, repository, branch }) {
  const { owner, repo } = validateTarget(repository, '1', config.org);
  if (!branch || branch.startsWith('refs/') || /[\x00-\x20\x7f]/.test(branch)) {
    throw new Error('Expected a short branch name, not a ref or whitespace.');
  }
  core.setOutput('scan', 'false');
  const { data: metadata } = await github.rest.repos.get({ owner, repo });
  if (!await selectedRepository(github, metadata, config) ||
      (config.branches === 'default' && metadata.default_branch !== branch)) {
    core.notice('Repository or branch no longer matches the configured selection.');
    return;
  }
  const { data: head } = await github.rest.repos.getBranch({ owner, repo, branch });
  const { data: commit } = await github.rest.git.getCommit({
    owner, repo, commit_sha: head.commit.sha,
  });
  const name = `${checkpoint(repository, branch, config)}-${commit.sha}`;
  if (config.changesOnly === 'true' &&
      await alreadyDelivered(controller, context.repo, await artifacts(controller, context.repo), name)) {
    core.notice('This branch snapshot has already been delivered successfully.');
    return;
  }
  const matrix = await detect(github, { owner, repo }, commit, config.detection);
  if (!matrix.include.length) {
    core.notice('No supported CodeQL languages; no checkpoint will be recorded.');
    return;
  }
  for (const [key, value] of Object.entries({
    scan: 'true', owner, repo, repository: metadata.full_name, branch,
    sha: commit.sha, matrix, checkpoint: name,
  })) core.setOutput(key, value);
}

async function deliver({ github, core, env, config, fetchImpl = fetch, pause = sleep }) {
  const { owner, repo } = validateTarget(env.TARGET_REPOSITORY, '1', config.org);
  const expected = JSON.parse(env.LANGUAGE_MATRIX).include.map((row) => row.language);
  for (const language of expected) {
    const directory = path.join(env.SARIF_DIRECTORY, `sarif-${language}`);
    const files = (await fs.readdir(directory)).filter((file) => file.endsWith('.sarif'));
    if (files.length !== 1) throw new Error(`Expected one SARIF file for ${language}.`);
    const sarif = JSON.parse(await fs.readFile(path.join(directory, files[0]), 'utf8'));
    if (sarif.version !== '2.1.0' || !Array.isArray(sarif.runs)) throw new Error('Invalid SARIF.');
    // CodeQL runs in the controller's Actions context, not the target's.
    for (const run of sarif.runs) {
      run.versionControlProvenance = [{
        repositoryUri: `${env.GITHUB_SERVER_URL}/${owner}/${repo}`,
        revisionId: env.TARGET_SHA, branch: env.TARGET_BRANCH,
      }];
    }
    const checkoutUri = (await fs.readFile(path.join(directory, 'checkout-uri.txt'), 'utf8')).trim();
    if (new URL(checkoutUri).protocol !== 'file:') throw new Error('Expected a file checkout URI.');
    if (config.destination === 'endpoint') {
      const body = config.format === 'sarif' ? sarif : {
        repository: env.TARGET_REPOSITORY, ref: `refs/heads/${env.TARGET_BRANCH}`,
        commit_sha: env.TARGET_SHA, language, sarif,
      };
      const headers = { 'Content-Type': config.format === 'sarif' ? 'application/sarif+json' : 'application/json' };
      if (env.EXPORT_TOKEN) headers.Authorization = `Bearer ${env.EXPORT_TOKEN}`;
      const response = await fetchImpl(config.endpoint, {
        method: 'POST', headers, body: JSON.stringify(body), redirect: 'error',
        signal: AbortSignal.timeout(60000),
      });
      if (!response.ok) throw new Error(`Endpoint delivery failed: HTTP ${response.status}.`);
    } else {
      const { data } = await github.rest.codeScanning.uploadSarif({
        owner, repo, commit_sha: env.TARGET_SHA, ref: `refs/heads/${env.TARGET_BRANCH}`,
        checkout_uri: checkoutUri, sarif: gzipSync(JSON.stringify(sarif)).toString('base64'),
      });
      let done = false;
      for (let attempt = 0; attempt < 60; attempt++) {
        await pause(5000);
        const { data: status } = await github.rest.codeScanning.getSarif({
          owner, repo, sarif_id: data.id,
        });
        if (status.processing_status === 'failed') {
          throw new Error(`SARIF processing failed: ${JSON.stringify(status.errors)}`);
        }
        if (status.processing_status === 'complete') { done = true; break; }
      }
      if (!done) throw new Error('SARIF processing timed out after five minutes.');
    }
    core.info(`Delivered ${language} for ${env.TARGET_REPOSITORY} at ${env.TARGET_SHA}.`);
  }
}

module.exports = {
  configuration, checkpoint, alreadyDelivered, selectedRepository, dispatch, detect, prepare, deliver,
};
