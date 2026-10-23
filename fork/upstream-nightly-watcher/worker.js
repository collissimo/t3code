// Starts fork-release.yml once per new upstream nightly. GitHub cannot notify a fork of upstream
// releases and scheduled runs in a fork are unreliable, so this checks every minute.
// Secret GITHUB_TOKEN: fine-grained token for the fork with Contents read/write (dispatch) and
// Actions read (runs); the unauthenticated API limit (60/h) is too low for these reads.

async function github(env, path, init = {}) {
  const response = await fetch(`https://api.github.com/${path}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      // Piping the secret in can leave a trailing newline.
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

// GraphQL, not REST: the REST release list carries every asset and took ~8 ms of CPU to parse,
// against the free plan's 10 ms per cron run.
const RELEASES = `query (
  $upstreamOwner: String!
  $upstreamName: String!
  $forkOwner: String!
  $forkName: String!
) {
  upstream: repository(owner: $upstreamOwner, name: $upstreamName) {
    releases(first: 30, orderBy: { field: CREATED_AT, direction: DESC }) {
      nodes { tagName isDraft publishedAt }
    }
  }
  fork: repository(owner: $forkOwner, name: $forkName) {
    releases(first: 1, orderBy: { field: CREATED_AT, direction: DESC }) {
      nodes { description }
    }
  }
}`;

async function releases(env) {
  const [upstreamOwner, upstreamName] = env.UPSTREAM.split("/");
  const [forkOwner, forkName] = env.FORK.split("/");
  const { data, errors } = await github(env, "graphql", {
    method: "POST",
    body: JSON.stringify({
      query: RELEASES,
      variables: { upstreamOwner, upstreamName, forkOwner, forkName },
    }),
  });
  if (errors) throw new Error(`graphql: ${JSON.stringify(errors)}`);
  return { upstream: data.upstream.releases.nodes, latest: data.fork.releases.nodes[0] };
}

async function check(env) {
  const { upstream, latest } = await releases(env);
  // Same choice as fork-release.yml: the newest published nightly.
  const nightly = upstream
    .filter((release) => !release.isDraft && release.tagName.includes("-nightly."))
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))[0];
  if (!nightly) return "no upstream nightly";
  const tag = nightly.tagName;

  // fork/release-notes.sh ends each release with a hidden "upstream-tag=<tag> " marker.
  if (latest?.description?.includes(`upstream-tag=${tag} `)) return `${tag} already released`;

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
