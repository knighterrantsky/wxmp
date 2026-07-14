import { createHash } from 'node:crypto'
import { PassThrough, Readable } from 'node:stream'

import { describe, expect, it } from 'vitest'

import { inspectChunk } from '../../src/uploads/chunk-stream.js'
import { collect } from '../support/streams.js'

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function inspectionOptions(bytes: Buffer, capturePrefixBytes = 16) {
  return {
    expectedBytes: bytes.length,
    expectedSha256: sha256(bytes),
    capturePrefixBytes,
  }
}

describe('inspectChunk', () => {
  it('hashes and counts a stream without changing its bytes', async () => {
    const expected = Buffer.from('abcdef')
    const inspected = inspectChunk(Readable.from([Buffer.from('abc'), Buffer.from('def')]), {
      expectedBytes: expected.length,
      expectedSha256: sha256(expected),
      capturePrefixBytes: 16,
    })

    await expect(collect(inspected.stream)).resolves.toEqual(expected)
    await expect(inspected.completed).resolves.toEqual({
      actualBytes: expected.length,
      sha256: sha256(expected),
      prefix: expected,
    })
  })

  it('emits bytes before the source ends and retains only the requested small prefix', async () => {
    const source = new PassThrough()
    const expected = Buffer.concat([Buffer.from('abc'), Buffer.alloc(1024 * 1024, 0x64)])
    const inspected = inspectChunk(source, inspectionOptions(expected, 3))
    const firstData = new Promise<unknown>((resolve) => {
      inspected.stream.once('data', resolve)
    })
    const output = collect(inspected.stream)

    source.write(expected.subarray(0, 3))
    await expect(firstData).resolves.toEqual(Buffer.from('abc'))

    source.end(expected.subarray(3))
    await expect(output).resolves.toEqual(expected)
    await expect(inspected.completed).resolves.toMatchObject({
      actualBytes: expected.length,
      prefix: Buffer.from('abc'),
    })
  })

  it.each([0, 1, 16])('captures exactly the available prefix up to %d bytes', async (limit) => {
    const expected = Buffer.from('abcdef')
    const inspected = inspectChunk(Readable.from(expected), inspectionOptions(expected, limit))

    await collect(inspected.stream)
    await expect(inspected.completed).resolves.toMatchObject({
      prefix: expected.subarray(0, limit),
    })
  })

  it('drains an overlong body before rejecting so multipart parsers can advance', async () => {
    const source = new PassThrough()
    const inspected = inspectChunk(source, {
      expectedBytes: 3,
      expectedSha256: sha256('abc'),
      capturePrefixBytes: 16,
    })
    const output = collect(inspected.stream)

    source.write('abc')
    source.write('d')
    let settled = false
    void output.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )
    await new Promise((resolve) => setImmediate(resolve))
    expect(settled).toBe(false)
    expect(source.destroyed).toBe(false)
    source.end('ef')

    await expect(output).rejects.toMatchObject({
      code: 'PART_LENGTH_MISMATCH',
      retryable: false,
      statusCode: 422,
    })
    await expect(inspected.completed).rejects.toMatchObject({
      code: 'PART_LENGTH_MISMATCH',
      retryable: false,
      statusCode: 422,
    })
    expect(source.writableEnded).toBe(true)
  })

  it('rejects a body that ends before the planned length', async () => {
    const inspected = inspectChunk(Readable.from(Buffer.from('abc')), {
      expectedBytes: 4,
      expectedSha256: sha256('abcd'),
      capturePrefixBytes: 16,
    })

    await expect(collect(inspected.stream)).rejects.toMatchObject({
      code: 'PART_LENGTH_MISMATCH',
      retryable: false,
      statusCode: 422,
    })
    await expect(inspected.completed).rejects.toMatchObject({
      code: 'PART_LENGTH_MISMATCH',
      retryable: false,
      statusCode: 422,
    })
  })

  it('rejects a lowercase checksum that does not match while preserving retryability', async () => {
    const actual = Buffer.from('abcdef')
    const inspected = inspectChunk(Readable.from(actual), {
      expectedBytes: actual.length,
      expectedSha256: sha256('different'),
      capturePrefixBytes: 16,
    })

    await expect(collect(inspected.stream)).rejects.toMatchObject({
      code: 'PART_CHECKSUM_MISMATCH',
      retryable: true,
      statusCode: 422,
    })
    await expect(inspected.completed).rejects.toMatchObject({
      code: 'PART_CHECKSUM_MISMATCH',
      retryable: true,
      statusCode: 422,
    })
  })

  it.each([
    '',
    'a'.repeat(63),
    'a'.repeat(65),
    'A'.repeat(64),
    'g'.repeat(64),
    `${'a'.repeat(63)} `,
  ])('rejects a checksum that is not exactly 64 lowercase hexadecimal characters', (checksum) => {
    expect(() =>
      inspectChunk(Readable.from(Buffer.from('x')), {
        expectedBytes: 1,
        expectedSha256: checksum,
        capturePrefixBytes: 16,
      }),
    ).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR', statusCode: 422 }))
  })

  it.each([
    { expectedBytes: -1, capturePrefixBytes: 16 },
    { expectedBytes: 1.5, capturePrefixBytes: 16 },
    { expectedBytes: Number.MAX_SAFE_INTEGER + 1, capturePrefixBytes: 16 },
    { expectedBytes: 1, capturePrefixBytes: -1 },
    { expectedBytes: 1, capturePrefixBytes: 1.5 },
    { expectedBytes: 1, capturePrefixBytes: 4_097 },
  ])('rejects unsafe numeric inspection options %#', (options) => {
    expect(() =>
      inspectChunk(Readable.from(Buffer.from('x')), {
        ...options,
        expectedSha256: sha256('x'),
      }),
    ).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR', statusCode: 422 }))
  })

  it('forwards a source error to both the output and completion promise', async () => {
    const source = new PassThrough()
    const inspected = inspectChunk(source, {
      expectedBytes: 3,
      expectedSha256: sha256('abc'),
      capturePrefixBytes: 16,
    })
    const output = collect(inspected.stream)
    const sourceError = new Error('source read failed')

    source.destroy(sourceError)

    await expect(output).rejects.toBe(sourceError)
    await expect(inspected.completed).rejects.toBe(sourceError)
  })

  it('rejects instead of hanging when the source closes before ending', async () => {
    const source = new PassThrough()
    const inspected = inspectChunk(source, {
      expectedBytes: 3,
      expectedSha256: sha256('abc'),
      capturePrefixBytes: 16,
    })
    const output = collect(inspected.stream)

    source.write('a')
    source.destroy()

    await expect(output).rejects.toMatchObject({ code: 'ERR_STREAM_PREMATURE_CLOSE' })
    await expect(inspected.completed).rejects.toMatchObject({
      code: 'ERR_STREAM_PREMATURE_CLOSE',
    })
  })

  it('destroys the source and settles completion when the downstream consumer disconnects', async () => {
    const source = new PassThrough()
    const inspected = inspectChunk(source, {
      expectedBytes: 3,
      expectedSha256: sha256('abc'),
      capturePrefixBytes: 16,
    })

    inspected.stream.destroy()

    await expect(inspected.completed).rejects.toMatchObject({
      code: 'ERR_STREAM_PREMATURE_CLOSE',
    })
    expect(source.destroyed).toBe(true)
  })
})
