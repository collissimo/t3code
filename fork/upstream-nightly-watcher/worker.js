// Starts fork-release.yml once per new upstream nightly. GitHub cannot notify a fork of upstream
// releases and scheduled runs in a fork are unreliable, so this checks every minute.
// Secret GITHUB_TOKEN: fine-grained token for the fork with Contents read/write (dispatch) and
// Actions read (runs); the unauthenticated API limit (60/h) is too low for these reads.

async function github(env, path, init = {}) {
  const response = await fetch(`https://api.github.com/${path}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      // A pasted secret can keep a trailing CR, which GitHub rejects with an empty 400.
      authorization: `Bearer ${env.GITHUB_TOKEN.trim()}`,
      "user-agent": "t3code-upstream-nightly-watcher",
      "x-github-api-version": "2022-11-28",
      ...init.headers,
    },
  });
  if (!response.ok) {
    throw new Error(`${init.method ?? "GET"} ${path}: ${response.status} ${await response.text()}`);
  }
  return response.status === 204 ? null : response.json();
}

async function check(env) {
  // Same choice as fork-release.yml: the newest published nightly.
  const upstream = await github(env, `repos/${env.UPSTREAM}/releases?per_page=30`);
  const nightly = upstream
    .filter((release) => !release.draft && release.tag_name.includes("-nightly."))
    .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at))[0];
  if (!nightly) return "no upstream nightly";
  const tag = nightly.tag_name;

  // fork-release.yml writes "builds of upstream <tag> with" into each release.
  const [latest] = await github(env, `repos/${env.FORK}/releases?per_page=1`);
  if (latest?.body?.includes(`upstream ${tag} `)) return `${tag} already released`;

  // A failed build must not be redispatched every minute; the workflow's cron retries it.
  const workflow = `repos/${env.FORK}/actions/workflows/fork-release.yml`;
  const runs = await github(env, `${workflow}/runs?event=repository_dispatch&per_page=5`);
  if (runs.workflow_runs.some((run) => run.display_title === `Fork release of ${tag}`)) {
    return `${tag} already dispatched`;
  }

  await github(env, `repos/${env.FORK}/dispatches`, {
    method: "POST",
    body: JSON.stringify({ event_type: "upstream-nightly", client_payload: { upstream_tag: tag } }),
  });
  return `dispatched ${tag}`;
}

export default {
  async scheduled(_controller, env) {
    console.log(await check(env));
  },
};
