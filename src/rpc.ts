import { Rpc } from "@opencode/plugin/rpc"
import { Schema } from "effect"

const Window = Schema.Struct({
  label: Schema.String,
  remainingPct: Schema.Number,
  resetsAt: Schema.optional(Schema.Number),
  detail: Schema.optional(Schema.String),
})

const Account = Schema.Struct({
  provider: Schema.String,
  account: Schema.String,
  plan: Schema.optional(Schema.String),
  windows: Schema.Array(Window),
  error: Schema.optional(Schema.String),
  staleSince: Schema.optional(Schema.Number),
  staleReason: Schema.optional(Schema.String),
})

const SnapshotStruct = Schema.Struct({
  configured: Schema.Boolean,
  accounts: Schema.optional(Schema.Array(Account)),
  failed: Schema.Boolean,
  rejected: Schema.optional(Schema.String),
})

// The RPC contract must be portable (Standard Schema), so wrap the Effect schemas.
export const SnapshotSchema = Schema.toStandardSchemaV1(SnapshotStruct)
const ForceSchema = Schema.toStandardSchemaV1(Schema.Struct({ force: Schema.optional(Schema.Boolean) }))

/** Contract shared by the server plugin (fetching) and the TUI plugin (display). */
export const QuotaRpc = Rpc.define({
  id: "cpa-quota",
  methods: {
    get: {
      input: ForceSchema,
      output: SnapshotSchema,
    },
  },
  events: {
    changed: { schema: SnapshotSchema },
  },
})
