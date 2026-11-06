/**
 * GitHub client: GitHub Actions read-only (workflow runs and their jobs).
 *
 * Used by the command center System health page to show the CI status of
 * `main` (workflow "CI", job "check"). Read-only; the token needs only
 * Actions read access on the repo (a fine-grained token with
 * "Actions: Read-only", or any token for a public repo).
 *
 * Docs: https://docs.github.com/en/rest/actions/workflow-runs
 */

import { VendorHttpError } from './errors.js';

export interface GitHubConfig {
  token: string;
  owner: string;
  repo: string;
  /** Override for tests / GHES. Default https://api.github.com. */
  baseUrl?: string;
}

export interface WorkflowRun {
  id: number;
  run_number: number;
  name?: string | null;
  display_title?: string;
  head_branch: string | null;
  head_sha: string;
  /** queued | in_progress | completed | ... */
  status: string | null;
  /** success | failure | cancelled | skipped | timed_out | ... (null until completed). */
  conclusion: string | null;
  created_at: string;
  updated_at: string;
  html_url: string;
}

export interface WorkflowJobStep {
  name: string;
  number: number;
  status: string;
  conclusion: string | null;
}

export interface WorkflowJob {
  id: number;
  run_id: number;
  name: string;
  status: string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
  html_url: string | null;
  steps?: WorkflowJobStep[];
}

export interface ListWorkflowRunsOptions {
  branch?: string;
  /** 1-100, default 10. */
  perPage?: number;
}

export class GitHubClient {
  private readonly baseUrl: string;

  constructor(private config: GitHubConfig) {
    this.baseUrl = (config.baseUrl ?? 'https://api.github.com').replace(/\/$/, '');
  }

  /** Newest first. `workflow` is the workflow file name (e.g. "ci.yml") or its numeric id. */
  async listWorkflowRuns(workflow: string | number, opts: ListWorkflowRunsOptions = {}): Promise<WorkflowRun[]> {
    const params = new URLSearchParams({ per_page: String(Math.min(100, Math.max(1, opts.perPage ?? 10))) });
    if (opts.branch) params.set('branch', opts.branch);
    const body = await this.get<{ workflow_runs: WorkflowRun[] }>(
      `/actions/workflows/${encodeURIComponent(String(workflow))}/runs?${params}`,
    );
    return body.workflow_runs ?? [];
  }

  /** The jobs of one run (latest attempt). */
  async listRunJobs(runId: number): Promise<WorkflowJob[]> {
    const body = await this.get<{ jobs: WorkflowJob[] }>(`/actions/runs/${runId}/jobs?per_page=100`);
    return body.jobs ?? [];
  }

  private async get<T>(path: string): Promise<T> {
    const { owner, repo, token } = this.config;
    const res = await fetch(`${this.baseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}${path}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'aac-command-center',
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new VendorHttpError('github', res.status, `GitHub API error: ${res.status} - ${text.slice(0, 300)}`);
    }
    return (await res.json()) as T;
  }
}
