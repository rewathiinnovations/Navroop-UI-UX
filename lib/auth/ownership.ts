/**
 * One definition of "may this actor write to something owned by someone else".
 *
 * This rule was copy-pasted into nine modules — assets, audit, domains, github
 * push, projects, plan, stars, publish and seo — each with the same body and a
 * slightly different parameter type (`SessionUser`, `PushActor`, an inline
 * `{ id, role }`). Nine copies of an authorization primitive is nine places for
 * it to drift, and a drift here is a privilege bug rather than a cosmetic one.
 *
 * The actor is typed structurally so every existing caller passes unchanged:
 * `SessionUser.role` is the `Role` enum and `PushActor.role` is a bare string,
 * and both are assignable to `string`.
 *
 * Deliberately *not* generalised beyond ownership. `lib/memory/actions.ts` keeps
 * its own `canMutateScope`, because workspace-scoped memory asks a different
 * question (ADMIN for WORKSPACE scope, project ownership for PROJECT scope) and
 * folding the two would hide that difference.
 *
 * Note that `role` is global, not per-workspace: an ADMIN may write to any
 * owner's row anywhere. That is correct for Navroop, which runs one workspace
 * for one team, and is the assumption to revisit first if that ever changes.
 */
export type OwnershipActor = { id: string; role: string };

export function canMutateOwned(actor: OwnershipActor, ownerId: string): boolean {
  return actor.id === ownerId || actor.role === 'ADMIN';
}
