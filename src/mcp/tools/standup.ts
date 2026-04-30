import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { GitHubService } from '../../services/github.js';
import type { StandupActivity } from '../../services/github.js';

const execFileAsync = promisify(execFile);

function formatStandup(activity: StandupActivity): string {
  const date = new Date(activity.date + 'T12:00:00Z');
  const dayName = date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  const lines: string[] = [`## Activity for ${dayName}`, ''];

  for (const repo of activity.repos) {
    const shortName = repo.repo.split('/')[1] ?? repo.repo;
    lines.push(`**${shortName}**`);

    for (const pr of repo.mergedPRs) {
      lines.push(`- Merged PR #${pr.number}: ${pr.title}`);
    }

    for (const push of repo.pushes) {
      if (push.prNumber) {
        lines.push(`- Pushed to PR #${push.prNumber}: ${push.prTitle ?? push.branch}`);
      } else {
        lines.push(`- Pushed to branch: ${push.branch}`);
      }
    }

    lines.push('');
  }

  return lines.join('\n');
}

export function registerStandupTools(server: McpServer): void {
  server.registerTool(
    'get_standup',
    {
      description:
        'Get a standup summary of recent GitHub activity. Shows merged PRs and commits pushed to PR branches. Auto-detects the last active day. Defaults to the currently authenticated gh CLI user if no username is provided.',
      inputSchema: {
        username: z.string().optional().describe('GitHub username to fetch activity for (defaults to the authenticated gh CLI user)'),
      },
    },
    async ({ username }) => {
      try {
        let ghUser = username;
        if (!ghUser) {
          const { stdout } = await execFileAsync('gh', ['api', 'user', '--jq', '.login']);
          ghUser = stdout.trim();
        }
        const github = new GitHubService(ghUser);
        const activity = await github.getStandupActivity();

        if (!activity) {
          return { content: [{ type: 'text' as const, text: 'No recent GitHub activity found.' }] };
        }

        const formatted = formatStandup(activity);
        return { content: [{ type: 'text' as const, text: formatted }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text' as const, text: `Error fetching standup: ${message}` }],
          isError: true,
        };
      }
    }
  );
}
