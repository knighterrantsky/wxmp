import type { Static, TSchema } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'

export function matchesSchema<T extends TSchema>(schema: T, value: unknown): value is Static<T> {
  return Value.Check(schema, value)
}
