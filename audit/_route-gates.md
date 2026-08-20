# Independent route/gate scan (mechanical)

140 `route.ts` files. This is a **grep-level** scan: presence of a helper name, not
proof the gate is correct. Routes with no helper at all are listed first as read candidates.

## No gate helper found (47)

| route                                                                | methods          | LOC |
| -------------------------------------------------------------------- | ---------------- | --- |
| `app/api/admin/api-keys/route.ts`                                    | GET PUT          | 19  |
| `app/api/admin/deploy/route.ts`                                      | GET PUT          | 19  |
| `app/api/admin/deploy/test/route.ts`                                 | POST             | 10  |
| `app/api/admin/servers/[id]/route.ts`                                | PATCH DELETE     | 33  |
| `app/api/admin/servers/[id]/test/route.ts`                           | POST             | 14  |
| `app/api/admin/servers/route.ts`                                     | GET POST         | 15  |
| `app/api/auth/[...nextauth]/route.ts`                                | ?                | 4   |
| `app/api/auth/forgot-password/route.ts`                              | POST             | 27  |
| `app/api/auth/logout/route.ts`                                       | POST             | 8   |
| `app/api/auth/register/route.ts`                                     | POST             | 21  |
| `app/api/auth/reset-password/route.ts`                               | POST             | 22  |
| `app/api/auth/signup/route.ts`                                       | POST             | 9   |
| `app/api/deployments/[id]/route.ts`                                  | POST             | 28  |
| `app/api/deployments/route.ts`                                       | GET              | 9   |
| `app/api/github/disconnect/route.ts`                                 | POST             | 11  |
| `app/api/github/push/route.ts`                                       | POST             | 16  |
| `app/api/health/route.ts`                                            | GET              | 43  |
| `app/api/integrations/sentry/callback/route.ts`                      | GET              | 59  |
| `app/api/projects/[id]/assets/[assetId]/route.ts`                    | PATCH DELETE     | 25  |
| `app/api/projects/[id]/assets/route.ts`                              | GET POST         | 57  |
| `app/api/projects/[id]/audit/route.ts`                               | GET POST         | 24  |
| `app/api/projects/[id]/checkpoints/[checkpointId]/bookmark/route.ts` | POST             | 14  |
| `app/api/projects/[id]/checkpoints/[checkpointId]/preview/route.ts`  | POST             | 14  |
| `app/api/projects/[id]/checkpoints/[checkpointId]/restore/route.ts`  | POST             | 14  |
| `app/api/projects/[id]/checkpoints/exit/route.ts`                    | POST             | 14  |
| `app/api/projects/[id]/checkpoints/route.ts`                         | GET              | 14  |
| `app/api/projects/[id]/domains/[domainId]/route.ts`                  | POST DELETE      | 41  |
| `app/api/projects/[id]/domains/route.ts`                             | GET POST         | 27  |
| `app/api/projects/[id]/duplicate/route.ts`                           | POST             | 14  |
| `app/api/projects/[id]/plan/approve/route.ts`                        | POST             | 15  |
| `app/api/projects/[id]/plan/followup/route.ts`                       | POST             | 15  |
| `app/api/projects/[id]/plan/refine/route.ts`                         | POST             | 15  |
| `app/api/projects/[id]/plan/route.ts`                                | GET POST         | 26  |
| `app/api/projects/[id]/publish/password/route.ts`                    | POST DELETE      | 25  |
| `app/api/projects/[id]/restore/route.ts`                             | POST             | 14  |
| `app/api/projects/[id]/route.ts`                                     | GET PATCH DELETE | 71  |
| `app/api/projects/[id]/seo/route.ts`                                 | GET POST         | 24  |
| `app/api/projects/route.ts`                                          | GET POST         | 46  |
| `app/api/settings/api-keys/route.ts`                                 | GET PUT DELETE   | 26  |
| `app/api/settings/credits/route.ts`                                  | GET              | 9   |
| `app/api/settings/password/route.ts`                                 | PATCH            | 18  |
| `app/api/settings/profile/route.ts`                                  | PATCH            | 15  |
| `app/api/settings/usage/route.ts`                                    | GET              | 9   |
| `app/api/team/deactivate/route.ts`                                   | POST             | 12  |
| `app/api/team/reactivate/route.ts`                                   | POST             | 12  |
| `app/api/team/route.ts`                                              | GET PATCH        | 19  |
| `app/preview-static/[projectId]/[[...path]]/route.ts`                | GET              | 56  |

## All routes

| route                                                                | methods          | gate helpers present                            | LOC  |
| -------------------------------------------------------------------- | ---------------- | ----------------------------------------------- | ---- |
| `app/api/admin/api-keys/route.ts`                                    | GET PUT          | (NONE FOUND)                                    | 19   |
| `app/api/admin/audit/route.ts`                                       | GET              | requireAdmin                                    | 35   |
| `app/api/admin/backups/route.ts`                                     | GET              | requireAdmin                                    | 13   |
| `app/api/admin/backups/run/route.ts`                                 | POST             | requireAdmin                                    | 16   |
| `app/api/admin/deploy/route.ts`                                      | GET PUT          | (NONE FOUND)                                    | 19   |
| `app/api/admin/deploy/test/route.ts`                                 | POST             | (NONE FOUND)                                    | 10   |
| `app/api/admin/health/rollback/route.ts`                             | POST             | requireAdmin                                    | 66   |
| `app/api/admin/health/route.ts`                                      | GET              | requireAdmin                                    | 13   |
| `app/api/admin/health/sentry-test/route.ts`                          | POST             | requireAdmin                                    | 14   |
| `app/api/admin/integrations/check/route.ts`                          | POST             | requireAdmin                                    | 21   |
| `app/api/admin/integrations/disconnect/route.ts`                     | POST             | requireAdmin                                    | 61   |
| `app/api/admin/integrations/route.ts`                                | GET              | requireAdmin                                    | 11   |
| `app/api/admin/integrations/sentry/restart/route.ts`                 | POST             | requireAdmin                                    | 16   |
| `app/api/admin/invite/route.ts`                                      | POST             | requireAdmin                                    | 72   |
| `app/api/admin/jobs/[id]/abandon/route.ts`                           | POST             | requireAdmin                                    | 25   |
| `app/api/admin/jobs/route.ts`                                        | GET              | requireAdmin                                    | 14   |
| `app/api/admin/plans/route.ts`                                       | GET POST PATCH   | requireAdmin                                    | 77   |
| `app/api/admin/quality/route.ts`                                     | GET              | requireAdmin                                    | 27   |
| `app/api/admin/servers/[id]/route.ts`                                | PATCH DELETE     | (NONE FOUND)                                    | 33   |
| `app/api/admin/servers/[id]/test/route.ts`                           | POST             | (NONE FOUND)                                    | 14   |
| `app/api/admin/servers/route.ts`                                     | GET POST         | (NONE FOUND)                                    | 15   |
| `app/api/admin/settings/github-app/callback/route.ts`                | GET              | requireAdmin                                    | 57   |
| `app/api/admin/settings/github-app/start/route.ts`                   | GET              | requireAdmin                                    | 41   |
| `app/api/admin/settings/route.ts`                                    | GET PUT          | requireAdmin                                    | 38   |
| `app/api/admin/settings/test/route.ts`                               | POST             | requireAdmin                                    | 20   |
| `app/api/admin/team/[id]/reset-link/route.ts`                        | POST             | requireAdmin                                    | 21   |
| `app/api/admin/team/route.ts`                                        | GET              | requireAdmin                                    | 44   |
| `app/api/admin/templates/[id]/route.ts`                              | PATCH DELETE     | withRequest                                     | 24   |
| `app/api/admin/templates/[id]/test/route.ts`                         | POST             | withRequest                                     | 14   |
| `app/api/admin/templates/[id]/thumbnail/route.ts`                    | POST             | withRequest                                     | 24   |
| `app/api/admin/templates/route.ts`                                   | GET POST         | withRequest                                     | 31   |
| `app/api/admin/templates/thumbnails/route.ts`                        | POST             | withRequest                                     | 13   |
| `app/api/admin/usage/by-member/route.ts`                             | GET              | requireAdmin                                    | 19   |
| `app/api/admin/usage/project/[id]/route.ts`                          | GET              | requireAdmin                                    | 22   |
| `app/api/admin/usage/quality/route.ts`                               | GET              | requireAdmin                                    | 19   |
| `app/api/admin/usage/route.ts`                                       | GET              | requireAdmin                                    | 61   |
| `app/api/admin/usage/summary/route.ts`                               | GET              | requireAdmin                                    | 19   |
| `app/api/admin/workspace/route.ts`                                   | GET PATCH        | requireAdmin                                    | 25   |
| `app/api/analyze-edit-intent/route.ts`                               | POST             | requireSessionUser                              | 29   |
| `app/api/auth/[...nextauth]/route.ts`                                | ?                | (NONE FOUND)                                    | 4    |
| `app/api/auth/dev-login/route.ts`                                    | POST             | getSessionUser                                  | 46   |
| `app/api/auth/forgot-password/route.ts`                              | POST             | (NONE FOUND)                                    | 27   |
| `app/api/auth/login/route.ts`                                        | POST             | getSessionUser                                  | 59   |
| `app/api/auth/logout/route.ts`                                       | POST             | (NONE FOUND)                                    | 8    |
| `app/api/auth/me/route.ts`                                           | GET              | getSessionUser                                  | 18   |
| `app/api/auth/register/route.ts`                                     | POST             | (NONE FOUND)                                    | 21   |
| `app/api/auth/reset-password/route.ts`                               | POST             | (NONE FOUND)                                    | 22   |
| `app/api/auth/signup/route.ts`                                       | POST             | (NONE FOUND)                                    | 9    |
| `app/api/conversation-state/route.ts`                                | GET POST DELETE  | requireSessionUser                              | 171  |
| `app/api/cron/backup-db/route.ts`                                    | POST             | handleCron                                      | 9    |
| `app/api/cron/check-certs/route.ts`                                  | POST             | handleCron                                      | 9    |
| `app/api/cron/check-domains/route.ts`                                | POST             | handleCron                                      | 7    |
| `app/api/cron/check-integrations/route.ts`                           | POST             | handleCron                                      | 7    |
| `app/api/cron/check-uptime/route.ts`                                 | POST             | handleCron                                      | 9    |
| `app/api/cron/cleanup-orphans/route.ts`                              | POST             | handleCron                                      | 43   |
| `app/api/cron/observability-heartbeat/route.ts`                      | POST             | handleCron                                      | 9    |
| `app/api/cron/observability-quota/route.ts`                          | POST             | handleCron                                      | 28   |
| `app/api/cron/purge-projects/route.ts`                               | POST             | handleCron                                      | 22   |
| `app/api/cron/reap-jobs/route.ts`                                    | POST             | handleCron                                      | 17   |
| `app/api/cron/sweep-tmp/route.ts`                                    | POST             | handleCron                                      | 9    |
| `app/api/cron/system-checks-digest/route.ts`                         | POST             | handleCron                                      | 9    |
| `app/api/cron/thin-checkpoints/route.ts`                             | POST             | handleCron                                      | 7    |
| `app/api/cron/verify-storage/route.ts`                               | POST             | handleCron                                      | 9    |
| `app/api/deployments/[id]/route.ts`                                  | POST             | (NONE FOUND)                                    | 28   |
| `app/api/deployments/route.ts`                                       | GET              | (NONE FOUND)                                    | 9    |
| `app/api/extract-brand-styles/route.ts`                              | POST             | requireSessionUser                              | 90   |
| `app/api/generate-ai-code-stream/route.ts`                           | POST             | getSessionUser, withRequest                     | 2274 |
| `app/api/github/callback/route.ts`                                   | GET              | getSessionUser                                  | 99   |
| `app/api/github/connect/route.ts`                                    | GET              | getSessionUser                                  | 46   |
| `app/api/github/disconnect/route.ts`                                 | POST             | (NONE FOUND)                                    | 11   |
| `app/api/github/push/route.ts`                                       | POST             | (NONE FOUND)                                    | 16   |
| `app/api/github/status/route.ts`                                     | GET              | getSessionUser                                  | 18   |
| `app/api/health/route.ts`                                            | GET              | (NONE FOUND)                                    | 43   |
| `app/api/health/sentry-test/route.ts`                                | GET              | withRequest                                     | 27   |
| `app/api/integrations/cloudflare/route.ts`                           | POST             | requireAdmin                                    | 25   |
| `app/api/integrations/cloudflare/zone/route.ts`                      | POST             | requireAdmin                                    | 21   |
| `app/api/integrations/coolify/route.ts`                              | POST             | requireAdmin                                    | 41   |
| `app/api/integrations/coolify/select/route.ts`                       | POST             | requireAdmin                                    | 35   |
| `app/api/integrations/github/callback/route.ts`                      | GET              | requireAdmin                                    | 56   |
| `app/api/integrations/github/installed/route.ts`                     | GET              | requireAdmin                                    | 31   |
| `app/api/integrations/github/start/route.ts`                         | GET              | requireAdmin                                    | 37   |
| `app/api/integrations/sentry/callback/route.ts`                      | GET              | (NONE FOUND)                                    | 59   |
| `app/api/integrations/sentry/connect/route.ts`                       | POST             | requireAdmin                                    | 38   |
| `app/api/integrations/sentry/select/route.ts`                        | GET POST         | requireAdmin                                    | 47   |
| `app/api/integrations/sentry/settings/route.ts`                      | POST             | requireAdmin                                    | 43   |
| `app/api/integrations/sentry/start/route.ts`                         | POST             | requireAdmin                                    | 32   |
| `app/api/integrations/sentry/verify/route.ts`                        | POST             | requireAdmin                                    | 14   |
| `app/api/legal/accept/route.ts`                                      | GET POST         | getSessionUser, withRequest                     | 27   |
| `app/api/legal/data-request/route.ts`                                | POST             | getSessionUser, withRequest                     | 29   |
| `app/api/onboarding/route.ts`                                        | GET POST         | getSessionUser, withRequest                     | 34   |
| `app/api/projects/[id]/assets/[assetId]/route.ts`                    | PATCH DELETE     | (NONE FOUND)                                    | 25   |
| `app/api/projects/[id]/assets/route.ts`                              | GET POST         | (NONE FOUND)                                    | 57   |
| `app/api/projects/[id]/audit/route.ts`                               | GET POST         | (NONE FOUND)                                    | 24   |
| `app/api/projects/[id]/checkpoints/[checkpointId]/bookmark/route.ts` | POST             | (NONE FOUND)                                    | 14   |
| `app/api/projects/[id]/checkpoints/[checkpointId]/preview/route.ts`  | POST             | (NONE FOUND)                                    | 14   |
| `app/api/projects/[id]/checkpoints/[checkpointId]/restore/route.ts`  | POST             | (NONE FOUND)                                    | 14   |
| `app/api/projects/[id]/checkpoints/exit/route.ts`                    | POST             | (NONE FOUND)                                    | 14   |
| `app/api/projects/[id]/checkpoints/route.ts`                         | GET              | (NONE FOUND)                                    | 14   |
| `app/api/projects/[id]/domains/[domainId]/route.ts`                  | POST DELETE      | (NONE FOUND)                                    | 41   |
| `app/api/projects/[id]/domains/route.ts`                             | GET POST         | (NONE FOUND)                                    | 27   |
| `app/api/projects/[id]/duplicate/route.ts`                           | POST             | (NONE FOUND)                                    | 14   |
| `app/api/projects/[id]/export/route.ts`                              | GET              | getSessionUser, withRequest                     | 113  |
| `app/api/projects/[id]/files/route.ts`                               | GET              | getSessionUser, canMutate, withRequest          | 49   |
| `app/api/projects/[id]/import/route.ts`                              | POST             | getSessionUser                                  | 219  |
| `app/api/projects/[id]/job/keep/route.ts`                            | POST             | getSessionUser, withRequest                     | 30   |
| `app/api/projects/[id]/job/retry/route.ts`                           | POST             | getSessionUser, withRequest                     | 38   |
| `app/api/projects/[id]/job/route.ts`                                 | GET              | getSessionUser, withRequest                     | 34   |
| `app/api/projects/[id]/job/start-over/route.ts`                      | POST             | getSessionUser, withRequest                     | 32   |
| `app/api/projects/[id]/lock/release/route.ts`                        | POST             | getSessionUser                                  | 31   |
| `app/api/projects/[id]/plan/approve/route.ts`                        | POST             | (NONE FOUND)                                    | 15   |
| `app/api/projects/[id]/plan/followup/route.ts`                       | POST             | (NONE FOUND)                                    | 15   |
| `app/api/projects/[id]/plan/refine/route.ts`                         | POST             | (NONE FOUND)                                    | 15   |
| `app/api/projects/[id]/plan/route.ts`                                | GET POST         | (NONE FOUND)                                    | 26   |
| `app/api/projects/[id]/presence/route.ts`                            | GET POST         | getSessionUser                                  | 58   |
| `app/api/projects/[id]/preview/route.ts`                             | GET POST         | getSessionUser, signed-token, withRequest       | 81   |
| `app/api/projects/[id]/publish/password/route.ts`                    | POST DELETE      | (NONE FOUND)                                    | 25   |
| `app/api/projects/[id]/publish/route.ts`                             | GET POST         | getSessionUser, ownerId-compare                 | 135  |
| `app/api/projects/[id]/quality-signals/route.ts`                     | POST             | getSessionUser                                  | 33   |
| `app/api/projects/[id]/restore/route.ts`                             | POST             | (NONE FOUND)                                    | 14   |
| `app/api/projects/[id]/route.ts`                                     | GET PATCH DELETE | (NONE FOUND)                                    | 71   |
| `app/api/projects/[id]/seo/route.ts`                                 | GET POST         | (NONE FOUND)                                    | 24   |
| `app/api/projects/route.ts`                                          | GET POST         | (NONE FOUND)                                    | 46   |
| `app/api/scrape-screenshot/route.ts`                                 | POST             | requireSessionUser                              | 94   |
| `app/api/scrape-url-enhanced/route.ts`                               | POST             | requireSessionUser                              | 141  |
| `app/api/scrape-website/route.ts`                                    | POST OPTIONS     | requireSessionUser                              | 123  |
| `app/api/search/route.ts`                                            | GET POST         | requireSessionUser, getSessionUser, withRequest | 79   |
| `app/api/settings/api-keys/route.ts`                                 | GET PUT DELETE   | (NONE FOUND)                                    | 26   |
| `app/api/settings/credits/route.ts`                                  | GET              | (NONE FOUND)                                    | 9    |
| `app/api/settings/password/route.ts`                                 | PATCH            | (NONE FOUND)                                    | 18   |
| `app/api/settings/profile/route.ts`                                  | PATCH            | (NONE FOUND)                                    | 15   |
| `app/api/settings/storage/route.ts`                                  | GET              | getSessionUser                                  | 15   |
| `app/api/settings/usage/route.ts`                                    | GET              | (NONE FOUND)                                    | 9    |
| `app/api/team/deactivate/route.ts`                                   | POST             | (NONE FOUND)                                    | 12   |
| `app/api/team/reactivate/route.ts`                                   | POST             | (NONE FOUND)                                    | 12   |
| `app/api/team/route.ts`                                              | GET PATCH        | (NONE FOUND)                                    | 19   |
| `app/api/templates/[id]/create/route.ts`                             | POST             | withRequest                                     | 18   |
| `app/api/templates/[id]/route.ts`                                    | GET              | withRequest                                     | 16   |
| `app/api/templates/from-project/route.ts`                            | GET POST         | withRequest                                     | 34   |
| `app/api/templates/route.ts`                                         | GET              | withRequest                                     | 22   |
| `app/preview-static/[projectId]/[[...path]]/route.ts`                | GET              | (NONE FOUND)                                    | 56   |
