// Kernel factory. HUMANSTUDY_KERNEL=mock forces the mock (development). Otherwise the HumanStudy
// edition of opencode is used: the managed download (src/main/opencode-install.ts) or a developer's
// HUMANSTUDY_KERNEL_BIN announce the binary through HUMANSTUDY_OPENCODE_BIN, so this module stays free
// of electron and bundleable for kernel.test.mjs. A system-installed opencode is never used; until the
// managed kernel is installed the mock stands in.
import { MockKernel } from './mock'
import { OpencodeKernel } from './opencode'
import type { Kernel } from './types'

export type { Kernel, KernelEvent, KernelEventType, KernelPermission, KernelUsage, PermissionReply } from './types'
export { MockKernel } from './mock'
export { OpencodeKernel, isInsideProject, toKernelPermission, DEFAULT_MODEL, DEFAULT_PROVIDER } from './opencode'

export function createKernel(): Kernel {
  const forced = process.env.HUMANSTUDY_KERNEL
  if (forced === 'mock') return new MockKernel()
  const bin = process.env.HUMANSTUDY_KERNEL_BIN?.trim() || process.env.HUMANSTUDY_OPENCODE_BIN
  if (bin) return new OpencodeKernel({ binary: bin })
  if (forced === 'opencode') throw new Error('HUMANSTUDY_KERNEL=opencode but the HumanStudy kernel is not installed')
  return new MockKernel()
}
