import {
  FormatRegistry,
  Type,
  type Static,
  type TProperties,
  type TSchema,
} from '@sinclair/typebox'

export const UUID_V7_PATTERN =
  '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
export const RFC_3339_UTC_PATTERN = '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,9})?Z$'

const RFC_3339_UTC_COMPONENTS = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/
const DAYS_PER_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const

function isLeapYear(year: number) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
}

function isRfc3339UtcDateTime(value: string) {
  const match = RFC_3339_UTC_COMPONENTS.exec(value)
  if (match === null) return false

  const component = (index: number) => Number(match[index] ?? Number.NaN)
  const year = component(1)
  const month = component(2)
  const day = component(3)
  const hour = component(4)
  const minute = component(5)
  const second = component(6)
  const maximumDay = month === 2 && isLeapYear(year) ? 29 : (DAYS_PER_MONTH[month - 1] ?? 0)

  return (
    year >= 1 &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= maximumDay &&
    hour >= 0 &&
    hour <= 23 &&
    minute >= 0 &&
    minute <= 59 &&
    second >= 0 &&
    second <= 59
  )
}

FormatRegistry.Set('date-time', isRfc3339UtcDateTime)

export const PublicIdSchema = Type.String({ pattern: UUID_V7_PATTERN })
export const RequestIdSchema = Type.String({ pattern: UUID_V7_PATTERN })
export const DateTimeSchema = Type.String({
  format: 'date-time',
  pattern: RFC_3339_UTC_PATTERN,
})

export function strictObject<T extends TProperties>(properties: T) {
  return Type.Object(properties, { additionalProperties: false })
}

export const ResponseMetaSchema = strictObject({
  requestId: RequestIdSchema,
  serverTime: DateTimeSchema,
})

export const PaginationSchema = strictObject({
  limit: Type.Integer({ minimum: 1, maximum: 100 }),
  hasMore: Type.Boolean(),
  nextCursor: Type.Union([Type.String({ minLength: 1, maxLength: 4096 }), Type.Null()]),
})

export const ListResponseMetaSchema = strictObject({
  requestId: RequestIdSchema,
  serverTime: DateTimeSchema,
  pagination: PaginationSchema,
})

export function successEnvelopeSchema<T extends TSchema>(data: T) {
  return strictObject({ data, meta: ResponseMetaSchema })
}

export function listSuccessEnvelopeSchema<T extends TSchema>(data: T) {
  return strictObject({ data, meta: ListResponseMetaSchema })
}

export type ResponseMeta = Static<typeof ResponseMetaSchema>
export type Pagination = Static<typeof PaginationSchema>
