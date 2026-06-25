#!/usr/bin/env node

import { Octokit } from "@octokit/rest";

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  printUsage();
  process.exit(0);
}

const token = process.env.GITHUB_TOKEN;
const owner = args.owner;
const repo = args.repo;
const mode = args.mode ?? "read";
const branches = normalizeList(args.branch);
const prNumber = args.pr ? Number(args.pr) : null;
const runId = new Date().toISOString().replace(/[:.]/g, "-");

if (!token) {
  fail("GITHUB_TOKEN is required.");
}

if (!owner || !repo) {
  fail("--owner and --repo are required.");
}

if (!["read", "execute"].includes(mode)) {
  fail("--mode must be either read or execute.");
}

if (branches.length === 0) {
  fail("At least one --branch value is required.");
}

for (const branch of branches) {
  if (typeof branch !== "string" || branch.trim() === "") {
    fail("--branch values must be non-empty strings.");
  }
}

if (prNumber !== null && (!Number.isInteger(prNumber) || prNumber <= 0)) {
  fail("--pr must be a positive integer.");
}

const octokit = new Octokit({ auth: token });

try {
  const results = await main();
  const failedCount = results.filter((result) => result.status === "failed").length;

  if (failedCount > 0) {
    process.exit(1);
  }
} catch (error) {
  errorLog("Run failed", { error: serializeError(error) });
  process.exit(1);
}

async function main() {
  info("Run started", {
    owner,
    repo,
    mode,
    branches,
    prNumber,
  });

  const results = [];

  for (const branch of branches) {
    const result = await reviveBranch(branch);
    results.push(result);
  }

  const summary = summarizeResults(results);

  info("Run complete", {
    ...summary,
    results,
  });

  return results;
}

async function reviveBranch(branch) {
  info("Processing branch", { branch });

  const existingRef = await getExistingBranchRef(branch);

  if (existingRef) {
    const result = {
      branch,
      status: "skipped",
      reason: "branch_already_exists",
      sha: existingRef.object.sha,
      url: existingRef.url,
    };

    info("Branch already exists, skipping", result);
    return result;
  }

  const pullRequests = await listPullRequestsByBaseBranch(branch);
  const exactBasePullRequests = pullRequests.filter(
    (pullRequest) => pullRequest.base.ref === branch,
  );
  const candidatePullRequests = getCandidatePullRequests(exactBasePullRequests);

  if (candidatePullRequests.length === 0) {
    const result = {
      branch,
      status: "failed",
      reason: prNumber ? "pr_not_found_for_branch" : "no_matching_pull_requests",
      requestedPrNumber: prNumber,
      matchedPullRequestCount: exactBasePullRequests.length,
      matchedPullRequestNumbers: exactBasePullRequests.map(
        (pullRequest) => pullRequest.number,
      ),
    };

    errorLog("No matching pull requests found for branch and PR selection", result);
    return result;
  }

  const baseShas = new Set(candidatePullRequests.map((pullRequest) => pullRequest.base.sha));

  if (baseShas.size > 1) {
    const result = {
      branch,
      status: "failed",
      reason: "ambiguous_base_sha",
      pullRequests: candidatePullRequests.map(summarizePullRequest),
    };

    errorLog("Matched pull requests disagree on base SHA", result);
    return result;
  }

  const sha = candidatePullRequests[0].base.sha;
  const selectedPullRequest = candidatePullRequests[0];
  const result = {
    branch,
    status: mode === "read" ? "would_create" : "created",
    sha,
    selectedPullRequest: summarizePullRequest(selectedPullRequest),
    matchedPullRequests: candidatePullRequests.map(summarizePullRequest),
  };

  if (mode === "read") {
    info("Read mode: branch would be recreated", result);
    return result;
  }

  await octokit.rest.git.createRef({
    owner,
    repo,
    ref: `refs/heads/${branch}`,
    sha,
  });

  info("Branch recreated", result);
  return result;
}

async function getExistingBranchRef(branch) {
  try {
    const { data } = await octokit.rest.git.getRef({
      owner,
      repo,
      ref: `heads/${branch}`,
    });

    return data;
  } catch (error) {
    if (error.status === 404) {
      return null;
    }

    throw error;
  }
}

async function listPullRequestsByBaseBranch(branch) {
  const pullRequests = await octokit.paginate(octokit.rest.pulls.list, {
    owner,
    repo,
    state: "all",
    base: branch,
    sort: "updated",
    direction: "desc",
    per_page: 100,
  });

  info("Loaded pull requests for base branch", {
    branch,
    pullRequestCount: pullRequests.length,
  });

  return pullRequests;
}

function getCandidatePullRequests(pullRequests) {
  if (prNumber) {
    return pullRequests.filter((pullRequest) => pullRequest.number === prNumber);
  }

  const openPullRequests = pullRequests.filter((pullRequest) => pullRequest.state === "open");

  if (openPullRequests.length > 0) {
    return openPullRequests;
  }

  return pullRequests;
}

function summarizePullRequest(pullRequest) {
  return {
    number: pullRequest.number,
    title: pullRequest.title,
    state: pullRequest.state,
    draft: pullRequest.draft,
    url: pullRequest.html_url,
    baseRef: pullRequest.base.ref,
    baseSha: pullRequest.base.sha,
    headRef: pullRequest.head.ref,
    headSha: pullRequest.head.sha,
    updatedAt: pullRequest.updated_at,
  };
}

function summarizeResults(results) {
  return {
    branchCount: results.length,
    createdCount: results.filter((result) => result.status === "created").length,
    wouldCreateCount: results.filter((result) => result.status === "would_create").length,
    skippedCount: results.filter((result) => result.status === "skipped").length,
    failedCount: results.filter((result) => result.status === "failed").length,
  };
}

function normalizeList(value) {
  if (!value) {
    return [];
  }

  return Array.isArray(value) ? value : [value];
}

function parseArgs(argv) {
  const parsed = {};
  const allowedKeys = new Set(["owner", "repo", "branch", "mode", "pr", "help"]);

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--") {
      continue;
    }

    if (!arg.startsWith("--")) {
      fail(`Unexpected argument: ${arg}`);
    }

    const key = arg.slice(2);
    const next = argv[i + 1];

    if (!allowedKeys.has(key)) {
      fail(`Unexpected option: --${key}`);
    }

    if (!next || next.startsWith("--")) {
      if (key !== "help") {
        fail(`--${key} requires a value.`);
      }

      parsed[key] = true;
    } else {
      if (key === "branch") {
        parsed.branch = normalizeList(parsed.branch);
        parsed.branch.push(next);
      } else {
        parsed[key] = next;
      }

      i += 1;
    }
  }

  return parsed;
}

function serializeError(error) {
  return {
    name: error.name,
    message: error.message,
    status: error.status,
    response: error.response?.data ?? null,
  };
}

function info(message, fields = {}) {
  console.log(JSON.stringify({
    level: "info",
    timestamp: new Date().toISOString(),
    runId,
    message,
    ...fields,
  }));
}

function errorLog(message, fields = {}) {
  console.error(JSON.stringify({
    level: "error",
    timestamp: new Date().toISOString(),
    runId,
    message,
    ...fields,
  }));
}

function fail(message) {
  console.error(message);
  printUsage();
  process.exit(1);
}

function printUsage() {
  console.log(`
Usage:
  GITHUB_TOKEN=ghp_xxx node revive-pr-base-branches.js --owner <owner> --repo <repo> --branch <branch> [--branch <branch>] [options]

Options:
  --mode read|execute      Defaults to read.
  --branch <branch>        Branch name to revive. Can be provided multiple times.
  --pr <number>            Optional PR number to use when a base branch matches multiple PRs.
  --help                   Show this help text.

Examples:
  GITHUB_TOKEN=ghp_xxx node revive-pr-base-branches.js --owner 142w57th --repo wts-systems --branch new-payment-lifecycle/feature --pr 4925 --mode read

Safety:
  Read mode never creates branches.
  Execute mode recreates missing branches at the SHA recorded on matching PR base metadata.
  If multiple matching PRs disagree on the base SHA, the branch is skipped.
`);
}
