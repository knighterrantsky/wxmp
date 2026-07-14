import { describe, expect, it } from 'vitest'

import { ApiError } from '../../src/http/errors.js'
import { validateNickname, type NicknameValidationInput } from '../../src/profile/nickname.js'

const confirmedWechatNickname = (
  nickname: string,
  overrides: Partial<NicknameValidationInput> = {},
): NicknameValidationInput => ({
  nickname,
  source: 'wechatNicknameInput',
  confirmed: true,
  ...overrides,
})

function expectInvalid(input: NicknameValidationInput): void {
  let thrown: unknown
  try {
    validateNickname(input)
  } catch (error) {
    thrown = error
  }

  expect(thrown).toBeInstanceOf(ApiError)
  expect(thrown).toMatchObject({
    code: 'NICKNAME_INVALID',
    message: '微信昵称不符合要求',
    statusCode: 422,
    retryable: false,
  })
}

describe('validateNickname', () => {
  it('normalizes to NFC and trims ordinary surrounding whitespace', () => {
    expect(validateNickname(confirmedWechatNickname('  Cafe\u0301 小晴  '))).toBe('Café 小晴')
  })

  it('accepts both one and thirty-two grapheme clusters', () => {
    expect(validateNickname(confirmedWechatNickname('晴'))).toBe('晴')
    expect(validateNickname(confirmedWechatNickname('界'.repeat(32)))).toBe('界'.repeat(32))
  })

  it('counts an ordinary ZWJ emoji sequence as one grapheme cluster', () => {
    const family = '👨‍👩‍👧‍👦'

    expect(validateNickname(confirmedWechatNickname(`${family}小晴`))).toBe(`${family}小晴`)
  })

  it('accepts exactly 128 UTF-8 bytes', () => {
    const nickname = '😀'.repeat(32)

    expect(Buffer.byteLength(nickname, 'utf8')).toBe(128)
    expect(validateNickname(confirmedWechatNickname(nickname))).toBe(nickname)
  })

  it('does not reserve a nickname and permits duplicate display names', () => {
    const input = confirmedWechatNickname('同名用户')

    expect(validateNickname(input)).toBe('同名用户')
    expect(validateNickname(input)).toBe('同名用户')
  })

  it.each([
    ['', 'empty'],
    ['   ', 'whitespace-only'],
    ['晴'.repeat(33), 'thirty-three graphemes'],
    ['👨‍👩‍👧‍👦'.repeat(6), 'more than 128 UTF-8 bytes with fewer than thirty-two graphemes'],
  ])('rejects %s (%s)', (nickname) => {
    expectInvalid(confirmedWechatNickname(nickname))
  })

  it.each([
    ['A\u0000B', 'C0 NUL'],
    ['\nAlice', 'C0 newline even when trim would otherwise remove it'],
    ['A\u007fB', 'DEL'],
    ['A\u0085B', 'C1 next-line'],
    ['A\u061cB', 'Arabic letter mark'],
    ['A\u200eB', 'left-to-right mark'],
    ['A\u200fB', 'right-to-left mark'],
    ['A\u202aB', 'left-to-right embedding'],
    ['A\u202eB', 'right-to-left override'],
    ['A\u2066B', 'left-to-right isolate'],
    ['A\u2069B', 'pop directional isolate'],
  ])('rejects the %s bidirectional/control case', (nickname) => {
    expectInvalid(confirmedWechatNickname(nickname))
  })

  it('requires the exact WeChat nickname input source', () => {
    expectInvalid(confirmedWechatNickname('小晴', { source: 'manual' }))
  })

  it('requires a separate positive confirmation', () => {
    expectInvalid(confirmedWechatNickname('小晴', { confirmed: false }))
  })
})
