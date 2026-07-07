import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface GitHubEvent {
  type: string;
  repo: { name: string };
  payload: Record<string, unknown>;
  created_at: string;
}

export interface StandupRepo {
  repo: string;
  mergedPRs: { number: number; title: string }[];
  pushes: { branch: string; prNumber?: number; prTitle?: string }[];
}

export interface StandupActivity {
  date: string; // YYYY-MM-DD
  repos: StandupRepo[];
}

const DEFAULT_BRANCHES = new Set(['refs/heads/main', 'refs/heads/master', 'refs/heads/production', 'refs/heads/develop']);

// GitHub event timestamps are UTC (ISO 8601). Bucket them by the local calendar date of
// the machine running the tool so "last active day" matches the user's own day boundary
// rather than UTC's — otherwise evening work in US timezones (e.g. Central, Pacific) spills
// into the next UTC day and gets split across two standups.
export function toLocalDate(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export class GitHubService {
  constructor(private username: string) {}

  async fetchEvents(): Promise<GitHubEvent[]> {
    try {
      const { stdout } = await execFileAsync('gh', [
        'api', `users/${this.username}/events?per_page=100`,
        '--hostname', 'github.com',
      ]);
      return JSON.parse(stdout) as GitHubEvent[];
    } catch {
      return [];
    }
  }

  async findPRForBranch(repoFullName: string, branch: string): Promise<{ number: number; title: string } | null> {
    try {
      const owner = repoFullName.split('/')[0];
      const { stdout } = await execFileAsync('gh', [
        'api', `repos/${repoFullName}/pulls?head=${owner}:${branch}&state=all&per_page=1`,
        '--hostname', 'github.com',
      ]);
      const prs = JSON.parse(stdout);
      if (prs.length === 0) return null;
      return { number: prs[0].number, title: prs[0].title };
    } catch {
      return null;
    }
  }

  async fetchPRTitle(repoFullName: string, prNumber: number): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync('gh', [
        'api', `repos/${repoFullName}/pulls/${prNumber}`,
        '--hostname', 'github.com',
      ]);
      const pr = JSON.parse(stdout);
      return pr.title ?? null;
    } catch {
      return null;
    }
  }

  async getStandupActivity(): Promise<StandupActivity | null> {
    const events = await this.fetchEvents();

    // Filter to relevant event types
    const relevant = events.filter(
      (e) => e.type === 'PullRequestEvent' || e.type === 'PushEvent'
    );
    if (relevant.length === 0) return null;

    // Find the last active day (local calendar date of most recent event)
    const lastDate = toLocalDate(relevant[0].created_at);

    // Filter to only that day
    const dayEvents = relevant.filter((e) => toLocalDate(e.created_at) === lastDate);

    // Separate merged PRs and pushes
    const mergedPREvents = dayEvents.filter(
      (e) => e.type === 'PullRequestEvent' && (e.payload as any).action === 'merged'
    );
    const pushEvents = dayEvents.filter(
      (e) => e.type === 'PushEvent' && !DEFAULT_BRANCHES.has((e.payload as any).ref)
    );

    if (mergedPREvents.length === 0 && pushEvents.length === 0) return null;

    // Group by repo
    const repoMap = new Map<string, StandupRepo>();

    const getRepo = (name: string): StandupRepo => {
      if (!repoMap.has(name)) {
        repoMap.set(name, { repo: name, mergedPRs: [], pushes: [] });
      }
      return repoMap.get(name)!;
    };

    // Process merged PRs — fetch titles
    for (const event of mergedPREvents) {
      const prPayload = event.payload as any;
      const prNumber = prPayload.number ?? prPayload.pull_request?.number;
      const title = await this.fetchPRTitle(event.repo.name, prNumber);
      const repo = getRepo(event.repo.name);
      // Deduplicate
      if (!repo.mergedPRs.some((p) => p.number === prNumber)) {
        repo.mergedPRs.push({ number: prNumber, title: title ?? `PR #${prNumber}` });
      }
    }

    // Process pushes — deduplicate by branch, find associated PRs
    const seenBranches = new Set<string>();
    for (const event of pushEvents) {
      const ref = (event.payload as any).ref as string;
      const branch = ref.replace('refs/heads/', '');
      const key = `${event.repo.name}:${branch}`;
      if (seenBranches.has(key)) continue;
      seenBranches.add(key);

      // Skip if this branch was already merged (avoid double-reporting)
      const repo = getRepo(event.repo.name);
      const pr = await this.findPRForBranch(event.repo.name, branch);
      if (pr && repo.mergedPRs.some((p) => p.number === pr.number)) continue;

      repo.pushes.push({
        branch,
        prNumber: pr?.number,
        prTitle: pr?.title,
      });
    }

    // Filter out empty repos
    const repos = Array.from(repoMap.values()).filter(
      (r) => r.mergedPRs.length > 0 || r.pushes.length > 0
    );

    if (repos.length === 0) return null;

    return { date: lastDate, repos };
  }
}
