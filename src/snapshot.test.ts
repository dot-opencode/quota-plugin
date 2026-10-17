import { expect, test } from "bun:test"
import { fromWire, toWire, type Snapshot } from "./snapshot.ts"

test("snapshot survives JSON round trip with Dates restored", () => {
  const s: Snapshot = {
    configured: true,
    failed: false,
    accounts: [
      {
        provider: "claude",
        account: "a@b.c",
        windows: [{ label: "5h", remainingPct: 64, resetsAt: new Date(1_700_000_000_000) }, { label: "7d", remainingPct: 95 }],
        staleSince: new Date(1_700_000_100_000),
        staleReason: "429",
      },
    ],
  }
  const wire = JSON.parse(JSON.stringify(toWire(s)))
  expect(wire.accounts[0].windows[1]).toEqual({ label: "7d", remainingPct: 95 })
  const back = fromWire(wire)
  expect(back.accounts![0]!.windows[0]!.resetsAt).toEqual(new Date(1_700_000_000_000))
  expect(back.accounts![0]!.staleSince).toEqual(new Date(1_700_000_100_000))
  expect(back.accounts![0]!.windows[1]!.resetsAt).toBeUndefined()
})

test("unconfigured / rejected snapshot", () => {
  const wire = toWire({ configured: false, failed: true, rejected: "invalid key (401)" })
  expect(wire).toEqual({ configured: false, failed: true, rejected: "invalid key (401)" })
  expect(fromWire(wire).accounts).toBeUndefined()
})
