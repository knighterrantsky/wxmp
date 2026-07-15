import { chmodSync, mkdtempSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const productionComposePath = join(repositoryRoot, 'deploy/docker-compose.prod.yml')
const workflowPath = join(repositoryRoot, '.github/workflows/ci.yml')
const deployScriptPath = join(repositoryRoot, 'deploy/scripts/deploy-release.sh')
const bootstrapScriptPath = join(repositoryRoot, 'deploy/scripts/bootstrap-ubuntu.sh')

describe('production delivery configuration', () => {
  it('pulls an explicitly configured immutable API image instead of building on the server', () => {
    const compose = readFileSync(productionComposePath, 'utf8')

    expect(compose).toContain(
      'image: ${API_IMAGE:?API_IMAGE is required}:${IMAGE_TAG:?IMAGE_TAG is required}',
    )
    expect(compose).not.toMatch(/^\s+build:/mu)
    expect(compose).not.toContain('latest')
  })

  it('publishes only after verification and gates production deployment to its dedicated runner', () => {
    const workflow = readFileSync(workflowPath, 'utf8')

    expect(workflow).toContain('packages: write')
    expect(workflow).toContain('needs: verify')
    expect(workflow).toContain("vars.ENABLE_PRODUCTION_DEPLOY == 'true'")
    expect(workflow).toContain('runs-on: [self-hosted, linux, x64, production]')
    expect(workflow).toContain('environment: production')
    expect(workflow).toContain('./deploy/scripts/deploy-release.sh')
    expect(workflow).toContain('org.opencontainers.image.source')
    expect(workflow).toContain('IMAGE_TAG=config-only-image-tag')
  })

  it('pins the GitHub-maintained source actions to full commit SHAs', () => {
    const workflow = readFileSync(workflowPath, 'utf8')
    const actionReferences = [...workflow.matchAll(/^\s+uses:\s+([^\s#]+)(?:\s+#.*)?$/gmu)].map(
      ([, reference]) => reference,
    )

    expect(actionReferences.length).toBeGreaterThan(0)
    for (const reference of actionReferences) {
      expect(reference).toMatch(/^[^@]+@[0-9a-f]{40}$/u)
    }
  })

  it('provides a repeatable Ubuntu bootstrap without piping remote scripts into a shell', () => {
    const bootstrap = readFileSync(bootstrapScriptPath, 'utf8')

    expect(bootstrap).toContain('docker.io')
    expect(bootstrap).toContain('docker-buildx')
    expect(bootstrap).toContain('docker-compose-v2')
    expect(bootstrap).toContain('wxdeploy')
    expect(bootstrap).toContain('/swapfile')
    expect(bootstrap).not.toMatch(/curl[^\n]*\|\s*(?:ba)?sh/u)
  })
})

describe('deployment release script', () => {
  it('rejects mutable or non-GHCR image references before invoking Docker', () => {
    const result = spawnSync(
      'bash',
      [deployScriptPath, 'docker.io/example/api', 'latest', repositoryRoot],
      { encoding: 'utf8' },
    )

    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/GHCR|commit SHA/u)
  })

  it('installs an immutable release and deploys it through the stable environment file', () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), 'wx-upload-deploy-'))
    const deployRoot = join(temporaryRoot, 'releases-root')
    const environmentFile = join(temporaryRoot, 'production.env')
    const dockerLog = join(temporaryRoot, 'docker.log')
    const fakeDocker = join(temporaryRoot, 'docker')
    const image = 'ghcr.io/example/wx-private-media-upload-api'
    const tag = 'a'.repeat(40)

    writeFileSync(environmentFile, 'POSTGRES_ADMIN_PASSWORD=test-only\n')
    writeFileSync(fakeDocker, '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$WX_UPLOAD_DOCKER_LOG"\n')
    chmodSync(fakeDocker, 0o755)

    const result = spawnSync('bash', [deployScriptPath, image, tag, repositoryRoot], {
      encoding: 'utf8',
      env: {
        ...process.env,
        WX_UPLOAD_DEPLOY_ROOT: deployRoot,
        WX_UPLOAD_ENV_FILE: environmentFile,
        WX_UPLOAD_DOCKER_BIN: fakeDocker,
        WX_UPLOAD_DOCKER_LOG: dockerLog,
      },
    })

    expect(result.status, result.stderr).toBe(0)
    const releaseDirectory = join(deployRoot, 'releases', tag)
    expect(
      readFileSync(join(releaseDirectory, 'deploy/docker-compose.prod.yml'), 'utf8'),
    ).toContain('${API_IMAGE')
    expect(readlinkSync(join(deployRoot, 'current'))).toBe(releaseDirectory)

    const dockerCalls = readFileSync(dockerLog, 'utf8')
    expect(dockerCalls).toContain('config --quiet')
    expect(dockerCalls).toContain('pull postgres migrate api nginx')
    expect(dockerCalls).toContain('up --detach --wait --wait-timeout 240')
  })
})
