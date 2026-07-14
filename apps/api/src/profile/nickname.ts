import { ApiError } from '../http/errors.js'

export interface NicknameValidationInput {
  nickname: string
  source: string
  confirmed: boolean
}

const MAX_GRAPHEME_CLUSTERS = 32
const MAX_UTF8_BYTES = 128
const C0_MAX = 0x1f
const C1_MIN = 0x7f
const C1_MAX = 0x9f
const BIDIRECTIONAL_CONTROLS = /\p{Bidi_Control}/u
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

function containsForbiddenControl(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? -1
    if (
      codePoint <= C0_MAX ||
      (codePoint >= C1_MIN && codePoint <= C1_MAX) ||
      BIDIRECTIONAL_CONTROLS.test(character)
    ) {
      return true
    }
  }
  return false
}

function invalidNickname(): never {
  throw new ApiError({
    code: 'NICKNAME_INVALID',
    message: '微信昵称不符合要求',
    statusCode: 422,
  })
}

export function validateNickname(input: NicknameValidationInput): string {
  if (input.source !== 'wechatNicknameInput' || !input.confirmed) {
    invalidNickname()
  }

  const normalized = input.nickname.normalize('NFC')
  if (containsForbiddenControl(normalized)) {
    invalidNickname()
  }

  const nickname = normalized.trim()
  if (nickname === '' || Buffer.byteLength(nickname, 'utf8') > MAX_UTF8_BYTES) {
    invalidNickname()
  }

  const graphemeClusters = Array.from(graphemeSegmenter.segment(nickname)).length
  if (graphemeClusters > MAX_GRAPHEME_CLUSTERS) invalidNickname()

  return nickname
}
