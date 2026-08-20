export const DEFAULT_WORKSPACE_ID = 'default';
export const GITHUB_APP_SETUP_MESSAGE =
  'GitHub is not connected. Connect GitHub at /admin/integrations. Personal GitHub accounts cannot publish.';
export const NO_SERVER_MESSAGE = 'No server is available — talk to an admin';
export const PREVIEW_BASIC_USER = 'preview';
/**
 * The branch a deploy repo is published on when `Deployment.repoBranch` is unset.
 *
 * One constant on purpose: Coolify was told to build `deployment.repoBranch || 'main'`
 * while the push hardcoded `refs/heads/main`, so a non-default `repoBranch` would have
 * made Coolify deploy a branch the push never wrote (F-253).
 */
export const DEFAULT_DEPLOY_BRANCH = 'main';
/**
 * Where the node-stack preview gate's plaintext lives: an env var on the Coolify
 * application, and nowhere else. `Deployment.passwordHash` is a bcrypt hash, which the
 * generated middleware cannot verify.
 */
export const PREVIEW_PASSWORD_ENV = 'PREVIEW_PASSWORD';
export const PUBLISH_POLL_MS = 5_000;
export const PUBLISH_POLL_TIMEOUT_MS = 10 * 60 * 1000;
/**
 * How many consecutive "Coolify answered but named no status" reads the poll absorbs
 * before it gives up.
 *
 * A partial response or an API shape change used to be read as a queue state, so the poll
 * waited the full ten minutes and then blamed the build (F-218). Three reads is enough to
 * ride out one bad response without pretending the provider is talking to us.
 */
export const PUBLISH_UNREPORTED_STATUS_READS = 3;

/**
 * The wait between those reads — shorter than `PUBLISH_POLL_MS` because this is a re-read
 * of a broken answer, not a wait for a build to progress.
 */
export const PUBLISH_UNREPORTED_RETRY_MS = 2_000;
