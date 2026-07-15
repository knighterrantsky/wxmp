import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { generateConfig, normalizeApiBaseUrl } from '../scripts/generate-config.js'

const temporaryDirectories: string[] = []

function temporaryOutputFile(): string {
  const directory = mkdtempSync(join(tmpdir(), 'wx-upload-config-'))
  temporaryDirectories.push(directory)
  return join(directory, 'config.generated.ts')
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

describe('mini-program API configuration', () => {
  it.each([
    ['credentials', 'https://user:secret@api.example.com'],
    ['a query', 'https://api.example.com?tenant=private'],
    ['a fragment', 'https://api.example.com#private'],
  ])('rejects an API URL containing %s', (_description, value) => {
    expect(() => normalizeApiBaseUrl(value, 'production')).toThrow(/PUBLIC_API_BASE_URL/u)
  })

  it('rejects HTTP outside local development', () => {
    expect(() => normalizeApiBaseUrl('http://api.example.com', 'production')).toThrow(/HTTPS/u)
    expect(() => normalizeApiBaseUrl('http://api.example.com', 'test')).toThrow(/HTTPS/u)
  })

  it('allows an HTTP origin only in local development', () => {
    expect(normalizeApiBaseUrl('http://127.0.0.1:3000/', 'development')).toBe(
      'http://127.0.0.1:3000',
    )
  })

  it('writes only the canonical, exact origin', () => {
    const outputFile = temporaryOutputFile()

    const generated = generateConfig({
      nodeEnv: 'production',
      outputFile,
      publicApiBaseUrl: 'https://api.example.com:8443/',
    })

    const expected = 'export const API_BASE_URL = "https://api.example.com:8443" as const\n'
    expect(generated).toBe(expected)
    expect(readFileSync(outputFile, 'utf8')).toBe(expected)
  })

  it('serializes unusual but valid host characters without generating executable source', () => {
    const outputFile = temporaryOutputFile()
    const dangerousOrigin = "https://x';while(1);'"

    const generated = generateConfig({
      nodeEnv: 'production',
      outputFile,
      publicApiBaseUrl: dangerousOrigin,
    })

    expect(generated).toBe(
      `export const API_BASE_URL = ${JSON.stringify(dangerousOrigin)} as const\n`,
    )
    expect(generated).not.toContain("= 'https://x';")
  })

  it.each(['ftp://api.example.com', 'https://api.example.com/v1', 'not a URL', ''])(
    'rejects a value that is not an HTTP(S) origin: %s',
    (value) => {
      expect(() => normalizeApiBaseUrl(value, 'development')).toThrow(/PUBLIC_API_BASE_URL/u)
    },
  )

  it('keeps real local configuration files out of version control', () => {
    const ignoreFile = readFileSync(resolve(import.meta.dirname, '../../../.gitignore'), 'utf8')

    expect(ignoreFile).toMatch(/^apps\/miniprogram\/project\.private\.config\.json$/mu)
    expect(ignoreFile).toMatch(/^apps\/miniprogram\/miniprogram\/config\.generated\.ts$/mu)
  })

  it('enables the native TypeScript compiler plugin for .ts mini-program sources', () => {
    const projectConfig = JSON.parse(
      readFileSync(resolve(import.meta.dirname, '../project.config.json'), 'utf8'),
    ) as { setting?: { useCompilerPlugins?: unknown } }

    expect(projectConfig.setting?.useCompilerPlugins).toEqual(['typescript'])
  })
})
