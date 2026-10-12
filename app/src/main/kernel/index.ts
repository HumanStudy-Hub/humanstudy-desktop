// Kernel factory. HUMANSTUDY_KERNEL=mock|opencode forces a choice; otherwise opencode is used
// when its binary can be found, else the mock. The managed download (src/main/opencode-install.ts)
// announces its binary through HUMANSTUDY_OPENCODE_BIN, so this module stays free of electron and
// stays bundleable for kernel.test.mjs.
import { MockKernel } from './mock'
import { OpencodeKernel, findOpencode } from './opencode'
import type { Kernel } from './types'

export type { Kernel, KernelEvent, KernelEventType } from './types'
export { MockKernel } from './mock'
export { OpencodeKernel, findOpencode, DEFAULT_MODEL, DEFAULT_PROVIDER } from './opencode'

export function createKernel(): Kernel {
  const forced = process.env.HUMANSTUDY_KERNEL
  if (forced === 'mock') return new MockKernel()
  const managed = process.env.HUMANSTUDY_OPENCODE_BIN
  const bin = managed || (process.env.HUMANSTUDY_IGNORE_SYSTEM_OPENCODE ? null : findOpencode())
  if (bin) return new OpencodeKernel({ binary: bin })
  if (forced === 'opencode') throw new Error('HUMANSTUDY_KERNEL=opencode but opencode is not installed')
  return new MockKernel()
}
