#!/usr/bin/env node

import { Octokit } from "@octokit/rest";
import fs from "node:fs/promises";
import path from "node:path";

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  printUsage();
  process.exit(0);
}

const token = process.env.GITHUB_TOKEN;
const owner = args.owner;
const repo = args.repo;
const mode = args.mode ?? "read";
const months = Number(args.months ?? 3);
const outputDir = args["output-dir"] ?? "branch-cleanup-runs";
const prDetectionMethod = "repository_pull_requests_by_head_ref";

if (!token) {
  fail("GITHUB_TOKEN is required.");
}

if (!owner || !repo) {
  fail("--owner and --repo are required.");
}

if (!["read", "execute"].includes(mode)) {
  fail("--mode must be either read or execute.");
}

if (!Number.isInteger(months) || months <= 0) {
  fail("--months must be a positive integer.");
}

const octokit = new Octokit({ auth: token });
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const startedAt = new Date().toISOString();
const cutoffDate = subtractMonths(new Date(), months);
const safeRepoName = `${sanitizePathPart(owner)}-${sanitizePathPart(repo)}`;
const runDir = path.resolve(outputDir, `${safeRepoName}-${runId}`);
const reportPath = path.join(runDir, "report.json");
const auditLogPath = path.join(runDir, "audit.jsonl");
const summaryPath = path.join(runDir, "summary.json");

try {
  await main();
} catch (error) {
  await fs.mkdir(runDir, { recursive: true }).catch(() => {});
  await audit({
    event: "run_failed",
    error: serializeError(error),
  }).catch(() => {});

  errorLog("Run failed", { error: error.message });
  process.exit(1);
}

async function main() {
  await fs.mkdir(runDir, { recursive: true });

  info("Run started", {
    owner,
    repo,
    mode,
    months,
    cutoffDate: cutoffDate.toISOString(),
    runDir,
  });

  await audit({
    event: "run_started",
    cutoffDate: cutoffDate.toISOString(),
    months,
    outputDir: path.resolve(outputDir),
    runDir,
  });

  info("Loading branches from GitHub", { owner, repo });
  const { defaultBranchName, branches: branchRefs } = await listBranches(owner, repo);

  await audit({
    event: "branches_loaded",
    defaultBranchName,
    branchCount: branchRefs.length,
  });

  info("Loading open pull requests from GitHub", { owner, repo });
  const openPullRequests = await listOpenPullRequests(owner, repo);
  const openPrCounts = summarizeOpenPullRequests(openPullRequests);

  info("Loaded open pull requests", openPrCounts);

  await audit({
    event: "open_prs_loaded",
    prDetectionMethod,
    ...openPrCounts,
  });

  const branches = attachOpenPullRequests(branchRefs, openPullRequests);

  const staleBranches = branches
    .map((branch) => classifyBranch(branch, defaultBranchName))
    .filter((branch) => branch.isStale);
  const branchCounts = summarizeBranches(branches, staleBranches);

  info("Classified branches", branchCounts);

  await audit({
    event: "classification_completed",
    ...branchCounts,
  });

  for (const [index, branch] of staleBranches.entries()) {
    await audit({
      event: "stale_branch_detected",
      branch: branch.name,
      lastCommitSha: branch.lastCommitSha,
      lastCommitDate: branch.lastCommitDate,
      openPrCount: branch.openPrCount,
      openPrs: branch.openPrs,
      hasDraftPr: branch.hasDraftPr,
      prDetectionMethod: branch.prDetectionMethod,
      isDefaultBranch: branch.isDefaultBranch,
      isProtected: branch.isProtected,
      deleteEligible: branch.deleteEligible,
      skipReasons: branch.skipReasons,
    });

    if ((index + 1) % 100 === 0 || index + 1 === staleBranches.length) {
      info("Audited stale branches", {
        auditedCount: index + 1,
        staleBranchCount: staleBranches.length,
      });
    }
  }

  const report = buildReport({
    defaultBranchName,
    branches,
    staleBranches,
    openPullRequests,
  });

  info("Writing report", { reportPath });
  await writeJson(reportPath, report);
  info("Wrote report", { reportPath });

  let deleteStats = {
    attempted: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
  };

  if (mode === "read") {
    info("Read mode complete. No branches were deleted.", {
      staleBranchCount: staleBranches.length,
      deleteEligibleCount: branchCounts.deleteEligibleCount,
      skippedCount: branchCounts.skippedCount,
    });
  } else {
    info("Starting execute mode", {
      staleBranchCount: staleBranches.length,
      deleteEligibleCount: branchCounts.deleteEligibleCount,
      skipCount: branchCounts.skippedCount,
    });
    deleteStats = await executeDeletes(staleBranches);
  }

  const summary = buildSummary({
    defaultBranchName,
    staleBranches,
    openPullRequests,
    deleteStats,
  });

  info("Writing summary", { summaryPath });
  await writeJson(summaryPath, summary);
  info("Wrote summary", { summaryPath });

  await audit({
    event: "run_completed",
    prDetectionMethod,
    ...openPrCounts,
    staleBranchCount: staleBranches.length,
    deleteEligibleCount: staleBranches.filter((branch) => branch.deleteEligible).length,
    deleteStats,
    reportPath,
    summaryPath,
    auditLogPath,
  });

  info("Run complete", {
    summaryPath,
    auditLogPath,
    staleBranchCount: staleBranches.length,
    deleteEligibleCount: staleBranches.filter((branch) => branch.deleteEligible).length,
  });
}

async function listBranches(owner, repo) {
  const query = `
    query Branches($owner: String!, $repo: String!, $cursor: String) {
      repository(owner: $owner, name: $repo) {
        defaultBranchRef {
          name
        }
        refs(
          refPrefix: "refs/heads/"
          first: 100
          after: $cursor
          orderBy: { field: TAG_COMMIT_DATE, direction: ASC }
        ) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            name
            branchProtectionRule {
              id
              pattern
            }
            target {
              ... on Commit {
                oid
                committedDate
                url
              }
            }
          }
        }
      }
    }
  `;

  const branches = [];
  let cursor = null;
  let defaultBranchName = null;
  let page = 0;

  do {
    page += 1;

    info("Fetching branch page", {
      page,
      branchCountSoFar: branches.length,
      cursor,
    });

    const result = await octokit.graphql(query, { owner, repo, cursor });
    const repository = result.repository;
    defaultBranchName ??= repository.defaultBranchRef?.name ?? null;

    for (const ref of repository.refs.nodes) {
      if (!ref.target?.oid) {
        await audit({
          event: "branch_skipped_non_commit_ref",
          branch: ref.name,
        });
        continue;
      }

      branches.push({
        name: ref.name,
        lastCommitSha: ref.target.oid,
        lastCommitDate: ref.target.committedDate,
        lastCommitUrl: ref.target.url,
        isProtected: Boolean(ref.branchProtectionRule),
        branchProtectionRule: ref.branchProtectionRule
          ? {
              id: ref.branchProtectionRule.id,
              pattern: ref.branchProtectionRule.pattern,
            }
          : null,
      });
    }

    info("Fetched branch page", {
      page,
      pageBranchCount: repository.refs.nodes.length,
      branchCountSoFar: branches.length,
      hasNextPage: repository.refs.pageInfo.hasNextPage,
    });

    await audit({
      event: "branch_page_fetched",
      page,
      pageBranchCount: repository.refs.nodes.length,
      branchCountSoFar: branches.length,
      hasNextPage: repository.refs.pageInfo.hasNextPage,
    });

    cursor = repository.refs.pageInfo.hasNextPage
      ? repository.refs.pageInfo.endCursor
      : null;
  } while (cursor);

  return { defaultBranchName, branches };
}

async function listOpenPullRequests(owner, repo) {
  const query = `
    query OpenPullRequests($owner: String!, $repo: String!, $cursor: String) {
      repository(owner: $owner, name: $repo) {
        pullRequests(
          states: [OPEN]
          first: 100
          after: $cursor
          orderBy: { field: UPDATED_AT, direction: DESC }
        ) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            number
            title
            url
            state
            isDraft
            headRefName
            headRefOid
            headRepository {
              nameWithOwner
            }
            author {
              login
            }
            createdAt
            updatedAt
          }
        }
      }
    }
  `;

  const pullRequests = [];
  let cursor = null;
  let page = 0;

  do {
    page += 1;

    info("Fetching open PR page", {
      page,
      openPrCountSoFar: pullRequests.length,
      cursor,
    });

    const result = await octokit.graphql(query, { owner, repo, cursor });
    const connection = result.repository.pullRequests;

    for (const pullRequest of connection.nodes) {
      pullRequests.push(normalizePullRequest(pullRequest));
    }

    info("Fetched open PR page", {
      page,
      pageOpenPrCount: connection.nodes.length,
      openPrCountSoFar: pullRequests.length,
      hasNextPage: connection.pageInfo.hasNextPage,
    });

    await audit({
      event: "open_pr_page_fetched",
      page,
      pageOpenPrCount: connection.nodes.length,
      openPrCountSoFar: pullRequests.length,
      hasNextPage: connection.pageInfo.hasNextPage,
    });

    cursor = connection.pageInfo.hasNextPage
      ? connection.pageInfo.endCursor
      : null;
  } while (cursor);

  return pullRequests;
}

function classifyBranch(branch, defaultBranchName) {
  const isDefaultBranch = branch.name === defaultBranchName;
  const isStale = new Date(branch.lastCommitDate) < cutoffDate;
  const skipReasons = [];

  if (isDefaultBranch) {
    skipReasons.push("default_branch");
  }

  if (branch.isProtected) {
    skipReasons.push("protected_branch");
  }

  if (branch.openPrCount > 0) {
    skipReasons.push("has_open_prs");
  }

  if (branch.hasDraftPr) {
    skipReasons.push("has_draft_prs");
  }

  return {
    ...branch,
    isDefaultBranch,
    isStale,
    skipReasons,
    deleteEligible: isStale && skipReasons.length === 0,
  };
}

function attachOpenPullRequests(branches, openPullRequests) {
  const pullRequestsByBranch = buildPullRequestsByBranch(openPullRequests);

  return branches.map((branch) => {
    const branchKey = getBranchKey(owner, repo, branch.name);
    const openPrs = pullRequestsByBranch.get(branchKey) ?? [];
    const hasDraftPr = openPrs.some((pullRequest) => pullRequest.isDraft);

    return {
      ...branch,
      openPrCount: openPrs.length,
      openPrs,
      hasDraftPr,
      prDetectionMethod,
    };
  });
}

function buildPullRequestsByBranch(openPullRequests) {
  const pullRequestsByBranch = new Map();

  for (const pullRequest of openPullRequests) {
    if (!pullRequest.headRepository || !pullRequest.headRefName) {
      continue;
    }

    const branchKey = getBranchKey(
      pullRequest.headRepository,
      null,
      pullRequest.headRefName,
    );
    const existingPullRequests = pullRequestsByBranch.get(branchKey) ?? [];
    existingPullRequests.push(pullRequest);
    pullRequestsByBranch.set(branchKey, existingPullRequests);
  }

  return pullRequestsByBranch;
}

function normalizePullRequest(pullRequest) {
  return {
    number: pullRequest.number,
    title: pullRequest.title,
    url: pullRequest.url,
    state: pullRequest.state,
    isDraft: pullRequest.isDraft,
    headRefName: pullRequest.headRefName,
    headRefOid: pullRequest.headRefOid,
    headRepository: pullRequest.headRepository?.nameWithOwner ?? null,
    author: pullRequest.author?.login ?? null,
    createdAt: pullRequest.createdAt,
    updatedAt: pullRequest.updatedAt,
  };
}

function getBranchKey(repositoryOwnerOrNameWithOwner, repositoryName, branchName) {
  const nameWithOwner = repositoryName
    ? `${repositoryOwnerOrNameWithOwner}/${repositoryName}`
    : repositoryOwnerOrNameWithOwner;

  return `${nameWithOwner}:${branchName}`;
}

async function executeDeletes(staleBranches) {
  const stats = {
    attempted: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
  };

  for (const branch of staleBranches) {
    if (!branch.deleteEligible) {
      stats.skipped += 1;

      await audit({
        event: "branch_delete_skipped",
        branch: branch.name,
        reasons: branch.skipReasons,
        lastCommitSha: branch.lastCommitSha,
        lastCommitDate: branch.lastCommitDate,
        openPrCount: branch.openPrCount,
        openPrs: branch.openPrs,
        hasDraftPr: branch.hasDraftPr,
        prDetectionMethod: branch.prDetectionMethod,
      });

      info("Skipped branch deletion", {
        branch: branch.name,
        reasons: branch.skipReasons,
      });
      continue;
    }

    stats.attempted += 1;

    await audit({
      event: "branch_delete_started",
      branch: branch.name,
      lastCommitSha: branch.lastCommitSha,
      lastCommitDate: branch.lastCommitDate,
      openPrCount: branch.openPrCount,
      openPrs: branch.openPrs,
      hasDraftPr: branch.hasDraftPr,
      prDetectionMethod: branch.prDetectionMethod,
    });

    info("Deleting stale branch", {
      branch: branch.name,
      lastCommitSha: branch.lastCommitSha,
      lastCommitDate: branch.lastCommitDate,
    });

    try {
      await octokit.rest.git.deleteRef({
        owner,
        repo,
        ref: `heads/${branch.name}`,
      });

      stats.succeeded += 1;

      await audit({
        event: "branch_delete_succeeded",
        branch: branch.name,
        lastCommitSha: branch.lastCommitSha,
      });

      info("Deleted branch", { branch: branch.name });
    } catch (error) {
      stats.failed += 1;

      await audit({
        event: "branch_delete_failed",
        branch: branch.name,
        lastCommitSha: branch.lastCommitSha,
        error: serializeError(error),
      });

      errorLog("Failed to delete branch", {
        branch: branch.name,
        error: error.message,
      });
    }
  }

  info("Finished execute mode", { deleteStats: stats });

  return stats;
}

function summarizeBranches(branches, staleBranches) {
  return {
    branchCount: branches.length,
    staleBranchCount: staleBranches.length,
    deleteEligibleCount: staleBranches.filter((branch) => branch.deleteEligible).length,
    skippedCount: staleBranches.filter((branch) => !branch.deleteEligible).length,
    staleWithOpenPrCount: staleBranches.filter((branch) => branch.openPrCount > 0).length,
    staleWithDraftPrCount: staleBranches.filter((branch) => branch.hasDraftPr).length,
  };
}

function summarizeOpenPullRequests(openPullRequests) {
  return {
    openPrCount: openPullRequests.length,
    draftOpenPrCount: openPullRequests.filter((pullRequest) => pullRequest.isDraft).length,
  };
}

function buildReport({ defaultBranchName, branches, staleBranches, openPullRequests }) {
  const deleteEligibleBranches = staleBranches.filter((branch) => branch.deleteEligible);
  const staleBranchesWithOpenPrs = staleBranches.filter((branch) => branch.openPrCount > 0);
  const staleBranchesSkipped = staleBranches.filter((branch) => !branch.deleteEligible);
  const openPrCounts = summarizeOpenPullRequests(openPullRequests);

  return {
    runId,
    owner,
    repo,
    mode,
    startedAt,
    generatedAt: new Date().toISOString(),
    cutoffDate: cutoffDate.toISOString(),
    months,
    defaultBranchName,
    prDetectionMethod,
    pullRequestScan: {
      prDetectionMethod,
      ...openPrCounts,
    },
    totals: {
      branchCount: branches.length,
      staleBranchCount: staleBranches.length,
      staleBranchesWithOpenPrCount: staleBranchesWithOpenPrs.length,
      staleBranchesWithDraftPrCount: staleBranches.filter((branch) => branch.hasDraftPr).length,
      deleteEligibleCount: deleteEligibleBranches.length,
      skippedCount: staleBranchesSkipped.length,
    },
    staleBranches,
    deleteEligibleBranches,
    staleBranchesWithOpenPrs,
    staleBranchesSkipped,
  };
}

function buildSummary({ defaultBranchName, staleBranches, openPullRequests, deleteStats }) {
  const openPrCounts = summarizeOpenPullRequests(openPullRequests);

  return {
    runId,
    owner,
    repo,
    mode,
    startedAt,
    completedAt: new Date().toISOString(),
    cutoffDate: cutoffDate.toISOString(),
    months,
    defaultBranchName,
    prDetectionMethod,
    reportPath,
    auditLogPath,
    pullRequestScan: {
      prDetectionMethod,
      ...openPrCounts,
    },
    totals: {
      staleBranchCount: staleBranches.length,
      staleBranchesWithOpenPrCount: staleBranches.filter((branch) => branch.openPrCount > 0).length,
      staleBranchesWithDraftPrCount: staleBranches.filter((branch) => branch.hasDraftPr).length,
      deleteEligibleCount: staleBranches.filter((branch) => branch.deleteEligible).length,
      skippedCount: staleBranches.filter((branch) => !branch.deleteEligible).length,
    },
    deleteStats,
  };
}

async function audit(event) {
  const entry = {
    runId,
    timestamp: new Date().toISOString(),
    owner,
    repo,
    mode,
    ...event,
  };

  await fs.appendFile(auditLogPath, `${JSON.stringify(entry)}\n`);
}

async function writeJson(filePath, data) {
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

function parseArgs(argv) {
  const parsed = {};

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

    if (!next || next.startsWith("--")) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      i += 1;
    }
  }

  return parsed;
}

function subtractMonths(date, months) {
  const result = new Date(date);
  result.setMonth(result.getMonth() - months);
  return result;
}

function sanitizePathPart(value) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
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
  GITHUB_TOKEN=ghp_xxx node stale-branches.js --owner <owner> --repo <repo> [options]

Options:
  --mode read|execute      Defaults to read.
  --months <number>        Stale threshold in months. Defaults to 3.
  --output-dir <path>      Directory for per-run artifacts. Defaults to branch-cleanup-runs.
  --help                   Show this help text.

Safety:
  Read mode never deletes branches.
  Execute mode never deletes the default branch, protected branches, or branches with open PRs.
`);
}
