import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface GenerateConfigInput {
  nodeEnv: string | undefined
  outputFile?: string
  publicApiBaseUrl: string | undefined
}

const currentFile = fileURLToPath(import.meta.url)
const defaultOutputFile = resolve(dirname(currentFile), '../miniprogram/config.generated.ts')

function invalidConfiguration(reason: string): never {
  throw new Error(`PUBLIC_API_BASE_URL ${reason}`)
}

export function normalizeApiBaseUrl(
  value: string | undefined,
  nodeEnv: string | undefined,
): string {
  if (value === undefined || value.trim() === '') {
    return invalidConfiguration('is required')
  }

  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return invalidConfiguration('must be a valid URL')
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return invalidConfiguration('must use HTTP or HTTPS')
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return invalidConfiguration('must not include credentials')
  }
  if (value.includes('?') || parsed.search !== '') {
    return invalidConfiguration('must not include a query')
  }
  if (value.includes('#') || parsed.hash !== '') {
    return invalidConfiguration('must not include a fragment')
  }
  if (parsed.pathname !== '/') {
    return invalidConfiguration('must be an origin without a path')
  }
  if (nodeEnv !== 'development' && parsed.protocol !== 'https:') {
    return invalidConfiguration('must use HTTPS outside local development')
  }

  return parsed.origin
}

export function generateConfig(input: GenerateConfigInput): string {
  const origin = normalizeApiBaseUrl(input.publicApiBaseUrl, input.nodeEnv)
  const generated = `export const API_BASE_URL = ${JSON.stringify(origin)} as const\n`
  const outputFile = input.outputFile ?? defaultOutputFile

  mkdirSync(dirname(outputFile), { recursive: true })
  writeFileSync(outputFile, generated, 'utf8')

  return generated
}

const entryFile = process.argv[1]
if (entryFile !== undefined && resolve(entryFile) === currentFile) {
  try {
    generateConfig({
      nodeEnv: process.env['NODE_ENV'],
      publicApiBaseUrl: process.env['PUBLIC_API_BASE_URL'],
    })
    process.stdout.write('Generated miniprogram/config.generated.ts\n')
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid configuration'
    process.stderr.write(`${message}\n`)
    process.exitCode = 1
  }
}
