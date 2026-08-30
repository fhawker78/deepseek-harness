/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-auto-correct`.
 * @module @deepseek-ai/dsh-auto-correct/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-auto-correct'

/** Cordis companion plugin name. */
export const name = 'auto-correct-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the guard's detection is stateless per call, exposes
 * no package-owned event or snapshot, and corrects through the sanctioned
 * deny-with-reason seam — nothing for an independent companion to observe.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
