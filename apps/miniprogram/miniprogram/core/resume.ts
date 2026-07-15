import type { UploadDetailResponse } from '@wx-upload/contracts'

export type ResumeServerPart = UploadDetailResponse['data']['parts'][number]
export type ResumeAction = 'resume' | 'replace'
export type PartHashRecord = Readonly<Record<number, string | null | undefined>>

export interface ResumeDecisionInput {
  pathReadable: boolean
  localHashes: PartHashRecord
  remoteHashes: PartHashRecord
}

export type ResumePlan =
  | { action: 'resume'; pendingParts: ResumeServerPart[] }
  | { action: 'replace'; abortReason: 'replaced'; pendingParts: [] }

export interface ColdResumeInput {
  pathReadable: boolean
  localHashes: PartHashRecord
  serverParts: readonly ResumeServerPart[]
}

export function decideResume(input: ResumeDecisionInput): ResumeAction {
  if (!input.pathReadable) return 'replace'

  for (const [partNumber, remoteHash] of Object.entries(input.remoteHashes)) {
    const numericPartNumber = Number(partNumber)
    if (
      typeof remoteHash !== 'string' ||
      !Object.hasOwn(input.localHashes, numericPartNumber) ||
      input.localHashes[numericPartNumber] !== remoteHash
    ) {
      return 'replace'
    }
  }
  return 'resume'
}

export function selectPendingParts(serverParts: readonly ResumeServerPart[]): ResumeServerPart[] {
  return serverParts
    .filter((part) => part.status === 'pending')
    .map((part) => ({ ...part }))
    .sort((left, right) => left.partNumber - right.partNumber)
}

export function planForegroundResume(serverParts: readonly ResumeServerPart[]): ResumePlan {
  return { action: 'resume', pendingParts: selectPendingParts(serverParts) }
}

export function planColdResume(input: ColdResumeInput): ResumePlan {
  const remoteHashes: Record<number, string | null> = {}
  for (const part of input.serverParts) {
    if (part.status !== 'pending') remoteHashes[part.partNumber] = part.sha256
  }

  if (
    decideResume({
      pathReadable: input.pathReadable,
      localHashes: input.localHashes,
      remoteHashes,
    }) === 'replace'
  ) {
    return { action: 'replace', abortReason: 'replaced', pendingParts: [] }
  }

  return planForegroundResume(input.serverParts)
}
