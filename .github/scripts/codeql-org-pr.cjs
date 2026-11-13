'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { gzipSync } = require('node:zlib');

const WORKER = 'codeql-pr-scan.yml';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function validateTarget(repository, pullNumber, org) {
  const match = /^([a-z0-9][a-z0-9-]*)\/([a-z0-9_.-]+)$/i.exec(repository || '');
  if (!match || match[2] === '.' || match[2] === '..' ||
      match[1].toLowerCase() !== org?.toLowerCase() ||
      !/^[1-9]\d*$/.test(String(pullNumber)) ||
      !Number.isSafeInteger(Number(pullNumber))) {
    throw new Error('Expected an organization-owned repository and a positive integer PR number.');
  }
  return { owner: match[1], repo: match[2], pull_number: Number(pullNumber) };
}

function eligible(pr) {
  // To include fork contributions, change this check AND review the upload
  // revalidation and runner isolation. Fork code must never receive secrets.
  return pr.state === 'open' && pr.head.repo != null &&
    pr.head.repo.id === pr.base.repo.id;
}

async function dispatch({ github, dispatcher, context, core, org, pause = sleep }) {
  const { data: central } = await dispatcher.rest.repos.get(context.repo);
  const failures = [];
  let dispatched = 0;
  let skipped = 0;

  async function send(repository, pr) {
    if (!eligible(pr)) {
      skipped++;
      core.info(`Skipping ${repository}#${pr.number}: closed PR or fork contribution.`);
      return;
    }
    try {
      await dispatcher.rest.actions.createWorkflowDispatch({
        ...context.repo, workflow_id: WORKER, ref: central.default_branch,
        inputs: { repository, pull_number: String(pr.number) },
      });
      dispatched++;
      core.info(`Dispatched ${repository}#${pr.number}.`);
    } catch (error) {
      failures.push(`${repository}#${pr.number}: ${error.message}`);
      core.error(failures.at(-1));
    }
    // Keep fan-out below the workflow-dispatch secondary rate limit.
    await pause(1000);
  }

  if (context.eventName === 'repository_dispatch') {
    const payload = context.payload.client_payload || {};
    const target = validateTarget(payload.repository, payload.pull_number, org);
    const { data: pr } = await github.rest.pulls.get(target);
    await send(`${target.owner}/${target.repo}`, pr);
  } else {
    // Iterate repositories rather than search: search results have a 1,000-hit cap.
    for await (const page of github.paginate.iterator(github.rest.repos.listForOrg, {
      org, type: 'all', per_page: 100,
    })) {
      for (const repo of page.data) {
        if (repo.archived || repo.disabled) continue;
        try {
          for await (const pulls of github.paginate.iterator(github.rest.pulls.list, {
            owner: org, repo: repo.name, state: 'open', per_page: 100,
          })) {
            for (const pr of pulls.data) await send(repo.full_name, pr);
          }
        } catch (error) {
          failures.push(`${repo.full_name}: ${error.message}`);
          core.error(failures.at(-1));
        }
      }
    }
  }
  await core.summary.addHeading('Centralized CodeQL dispatch')
    .addRaw(`Dispatched: ${dispatched}. Skipped fork/closed PRs: ${skipped}. Errors: ${failures.length}.`)
    .write();
  if (failures.length) throw new Error(`Dispatch incomplete:\n${failures.join('\n')}`);
}

async function treePaths(github, target, treeSha) {
  const params = { owner: target.owner, repo: target.repo };
  const { data } = await github.rest.git.getTree({
    ...params, tree_sha: treeSha, recursive: '1',
  });
  if (!data.truncated) {
    return data.tree.filter((entry) => entry.type === 'blob').map((entry) => entry.path);
  }
  // GitHub truncates large recursive trees. Walk subtrees instead of silently
  // omitting languages in large monorepositories.
  const paths = [];
  const pending = [{ sha: treeSha, prefix: '' }];
  while (pending.length) {
    const { sha, prefix } = pending.pop();
    const { data: subtree } = await github.rest.git.getTree({ ...params, tree_sha: sha });
    if (subtree.truncated) throw new Error(`Non-recursive tree ${sha} was truncated.`);
    for (const entry of subtree.tree) {
      if (entry.type === 'tree') pending.push({ sha: entry.sha, prefix: `${prefix}${entry.path}/` });
      if (entry.type === 'blob') paths.push(`${prefix}${entry.path}`);
    }
  }
  return paths;
}

function languageMatrix(paths) {
  const extensions = {
    'c-cpp': ['.c', '.cc', '.cpp', '.cxx', '.c++', '.h', '.hh', '.hpp', '.hxx', '.h++'],
    csharp: ['.cs'],
    go: ['.go'],
    'java-kotlin': ['.java', '.kt', '.kts'],
    'javascript-typescript': ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts', '.vue'],
    python: ['.py', '.pyw'],
    ruby: ['.rb'],
    rust: ['.rs'],
    swift: ['.swift'],
  };
  const found = new Set();
  let kotlin = false;
  for (const filename of paths) {
    const extension = path.posix.extname(filename).toLowerCase();
    if (/^\.github\/workflows\/[^/]+\.ya?ml$/i.test(filename) ||
        /(^|\/)action\.ya?ml$/i.test(filename)) found.add('actions');
    for (const [language, suffixes] of Object.entries(extensions)) {
      if (suffixes.includes(extension)) found.add(language);
    }
    if (extension === '.kt' || extension === '.kts') kotlin = true;
  }
  return matrixFor(found, kotlin);
}

function matrixFor(languages, kotlin) {
  return {
    include: [...languages].sort().map((language) => ({
      language,
      build_mode: language === 'go' || language === 'swift' ||
        (language === 'java-kotlin' && kotlin) ? 'autobuild' : 'none',
      runner: language === 'swift' ? 'macos-latest' : 'ubuntu-latest',
    })),
  };
}

async function prepare({ github, core, repository, pullNumber, org }) {
  const target = validateTarget(repository, pullNumber, org);
  core.setOutput('scan', 'false');
  core.setOutput('matrix', { include: [] });
  const { data: pr } = await github.rest.pulls.get(target);
  if (!eligible(pr)) {
    core.notice('Skipping closed PR or fork contribution.');
    return;
  }
  if (pr.mergeable === false) {
    core.warning('Skipping PR with merge conflicts; it will be reconsidered on the next poll.');
    return;
  }
  if (pr.mergeable == null || !pr.merge_commit_sha) {
    throw new Error('GitHub has not computed the PR merge commit. Retry this run or wait for the next poll.');
  }
  const { data: commit } = await github.rest.git.getCommit({
    owner: target.owner, repo: target.repo, commit_sha: pr.merge_commit_sha,
  });
  if (commit.parents.length !== 2 || commit.parents[0].sha !== pr.base.sha ||
      commit.parents[1].sha !== pr.head.sha) {
    throw new Error('PR merge commit is stale. Retry after GitHub updates the merge ref.');
  }
  const matrix = languageMatrix(await treePaths(github, target, commit.tree.sha));
  if (!matrix.include.length) {
    core.notice('No supported CodeQL source files found in the PR merge tree.');
    return;
  }
  core.info(`Scanning ${repository}#${pullNumber}: ${JSON.stringify(matrix)}`);
  for (const [name, value] of Object.entries({
    scan: 'true', matrix, sha: commit.sha, head: pr.head.sha,
    base: pr.base.sha, base_ref: `refs/heads/${pr.base.ref}`,
    repository: `${target.owner}/${target.repo}`, pull_number: target.pull_number,
  })) core.setOutput(name, value);
}

async function upload({ github, core, env, pause = sleep }) {
  const target = validateTarget(env.TARGET_REPOSITORY, env.PULL_NUMBER, env.CODEQL_ORG);
  const { data: pr } = await github.rest.pulls.get(target);
  if (!eligible(pr) || pr.head.sha !== env.HEAD_SHA || pr.base.sha !== env.BASE_SHA ||
      pr.merge_commit_sha !== env.MERGE_SHA) {
    throw new Error('PR closed, became ineligible, or changed during scanning. Refusing stale upload.');
  }
  const expected = JSON.parse(env.LANGUAGE_MATRIX).include.map((row) => row.language);
  const directories = await fs.readdir(env.SARIF_DIRECTORY);
  const failures = [];
  for (const language of expected) {
    const directory = `sarif-${language}`;
    if (!directories.includes(directory)) {
      failures.push(`Missing SARIF for ${language}; its scan may have failed.`);
      continue;
    }
    try {
      const location = path.join(env.SARIF_DIRECTORY, directory);
      const files = (await fs.readdir(location)).filter((file) => file.endsWith('.sarif'));
      if (files.length !== 1) throw new Error(`Expected one SARIF file, found ${files.length}.`);
      const sarif = await fs.readFile(path.join(location, files[0]));
      const checkoutUri = (await fs.readFile(path.join(location, 'checkout-uri.txt'), 'utf8')).trim();
      if (new URL(checkoutUri).protocol !== 'file:') throw new Error('Expected a file source URI.');
      const { data: submitted } = await github.rest.codeScanning.uploadSarif({
        owner: target.owner, repo: target.repo,
        commit_sha: env.MERGE_SHA, ref: `refs/pull/${target.pull_number}/merge`,
        base_ref: env.BASE_REF, base_sha: env.BASE_SHA,
        checkout_uri: checkoutUri,
        sarif: gzipSync(sarif).toString('base64'),
      });
      let completed = false;
      for (let attempt = 0; attempt < 60; attempt++) {
        await pause(5000);
        const { data: status } = await github.rest.codeScanning.getSarif({
          owner: target.owner, repo: target.repo, sarif_id: submitted.id,
        });
        if (status.processing_status === 'failed') {
          throw new Error(`SARIF processing failed: ${JSON.stringify(status.errors)}`);
        }
        if (status.processing_status === 'complete') {
          completed = true;
          break;
        }
      }
      if (!completed) throw new Error('SARIF processing did not complete within five minutes.');
      core.info(`Uploaded ${language} to ${env.TARGET_REPOSITORY}#${target.pull_number}.`);
    } catch (error) {
      failures.push(`${language}: ${error.message}`);
    }
  }
  if (failures.length) throw new Error(`Upload incomplete:\n${failures.join('\n')}`);
}

module.exports = { validateTarget, eligible, dispatch, treePaths, languageMatrix, matrixFor, prepare, upload };
