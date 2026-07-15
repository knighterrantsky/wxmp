import type { R2ObjectStorageConfig } from '../../src/uploads/r2-object-storage.js'

type SmokeEnvironment = Readonly<Record<string, string | undefined>>

const BUCKET_PATTERN = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u
const DEDICATED_BUCKET_PATTERN = /(?:^|-)smoke-test(?:-|$)/u
const R2_HOST_PATTERN = /^[a-f0-9]{32}(?:\.(?:eu|fedramp))?\.r2\.cloudflarestorage\.com$/u

function invalid(field: string): never {
  throw new Error(`Invalid R2 smoke configuration: ${field}`)
}

function required(environment: SmokeEnvironment, field: string, minimumLength = 1): string {
  const value = environment[field]
  if ((value?.length ?? 0) < minimumLength || value?.trim() !== value) {
    return invalid(field)
  }
  return value ?? invalid(field)
}

function endpoint(environment: SmokeEnvironment): string {
  const value = required(environment, 'R2_SMOKE_ENDPOINT')
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return invalid('R2_SMOKE_ENDPOINT')
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.port !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    !R2_HOST_PATTERN.test(parsed.hostname)
  ) {
    return invalid('R2_SMOKE_ENDPOINT')
  }
  return parsed.origin
}

function bucket(environment: SmokeEnvironment): string {
  const value = required(environment, 'R2_SMOKE_BUCKET')
  if (!BUCKET_PATTERN.test(value) || !DEDICATED_BUCKET_PATTERN.test(value)) {
    return invalid('R2_SMOKE_BUCKET')
  }
  if (environment['R2_BUCKET'] === value || environment['MINIO_BUCKET'] === value) {
    return invalid('R2_SMOKE_BUCKET')
  }
  return value
}

export function loadR2SmokeConfig(environment: SmokeEnvironment): R2ObjectStorageConfig {
  if (environment['RUN_R2_SMOKE'] !== 'true') return invalid('RUN_R2_SMOKE')
  return {
    endpoint: endpoint(environment),
    bucket: bucket(environment),
    accessKeyId: required(environment, 'R2_SMOKE_ACCESS_KEY_ID', 16),
    secretAccessKey: required(environment, 'R2_SMOKE_SECRET_ACCESS_KEY', 32),
    forcePathStyle: false,
  }
}
