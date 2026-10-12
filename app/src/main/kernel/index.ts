// Kernel factory. HUMANSTUDY_KERNEL=mock|opencode forces a choice; otherwise opencode is used
// when its binary can be found, else the mock.
import { MockKernel } from './mock'
import { OpencodeKernel, findOpencode } from './opencode'
import { kernelBinary } from '../opencode-install'
import type { Kernel } from './types'

export type { Kernel, KernelEvent, KernelEventType } from './types'
export { MockKernel } from './mock'
export { OpencodeKernel, findOpencode, DEFAULT_MODEL, DEFAULT_PROVIDER } from './opencode'

export function createKernel(): Kernel {
  const forced = process.env.HUMANSTUDY_KERNEL
  if (forced === 'mock') return new MockKernel()
  const bin = kernelBinary() // the managed download first, then an opencode the user installed
  if (bin) return new OpencodeKernel({ binary: bin })
  if (forced === 'opencode') throw new Error('HUMANSTUDY_KERNEL=opencode but opencode is not installed')
  return new MockKernel()
}
