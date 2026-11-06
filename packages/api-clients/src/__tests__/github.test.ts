import { describe, it, expect, vi, afterEach } from 'vitest';
import { GitHubClient } from '../github.js';
import { isVendorHttpError } from '../errors.js';

const originalFetch = globalThis.fetch;

function mockFetch(body: unknown, status = 200) {
  const mock = vi.fn().mockImplementation(
    async () =>
      new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  );
  globalThis.fetch = mock as unknown as typeof fetch;
  return mock;
}

const client = () => new GitHubClient({ token: 'ghp_test', owner: 'mrjmd', repo: 'aac' });

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('GitHubClient', () => {
  it('lists workflow runs for a branch with the auth and API version headers', async () => {
    const fetchMock = mockFetch({
      total_count: 1,
      workflow_runs: [{ id: 7, run_number: 42, head_branch: 'main', head_sha: 'abc', status: 'completed', conclusion: 'failure', created_at: 't', updated_at: 't', html_url: 'u' }],
    });
    const runs = await client().listWorkflowRuns('ci.yml', { branch: 'main', perPage: 5 });
    expect(runs).toHaveLength(1);
    expect(runs[0].conclusion).toBe('failure');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.github.com/repos/mrjmd/aac/actions/workflows/ci.yml/runs?per_page=5&branch=main');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer ghp_test');
    expect(headers['X-GitHub-Api-Version']).toBe('2022-11-28');
    expect(headers.Accept).toBe('application/vnd.github+json');
  });

  it('clamps perPage and defaults to 10', async () => {
    const fetchMock = mockFetch({ workflow_runs: [] });
    await client().listWorkflowRuns(123);
    expect((fetchMock.mock.calls[0] as [string])[0]).toContain('/actions/workflows/123/runs?per_page=10');
    await client().listWorkflowRuns('ci.yml', { perPage: 500 });
    expect((fetchMock.mock.calls[1] as [string])[0]).toContain('per_page=100');
  });

  it('lists a run\'s jobs with their steps', async () => {
    const fetchMock = mockFetch({
      jobs: [{ id: 1, run_id: 7, name: 'check', status: 'completed', conclusion: 'failure', started_at: null, completed_at: null, html_url: 'j', steps: [{ name: 'Test', number: 6, status: 'completed', conclusion: 'failure' }] }],
    });
    const jobs = await client().listRunJobs(7);
    expect(jobs[0].steps?.[0].name).toBe('Test');
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe('https://api.github.com/repos/mrjmd/aac/actions/runs/7/jobs?per_page=100');
  });

  it('throws a VendorHttpError on a non-2xx answer', async () => {
    mockFetch('{"message":"Bad credentials"}', 401);
    const err = await client().listRunJobs(1).catch((e: unknown) => e);
    expect(isVendorHttpError(err)).toBe(true);
    expect((err as Error).message).toContain('GitHub API error: 401');
  });
});
