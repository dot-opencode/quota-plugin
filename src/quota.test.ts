import { describe, expect, test } from "bun:test"
import { compactLine, compactSegments, fullReport, providerForModel, toneFor } from "./format.ts"
import type { AccountQuota } from "./types.ts"
import { CPA_PROVIDERS as P } from "./sources/cpa/index.ts"
import { reportGroups, type ProviderMeta } from "./format.ts"

const acc = (provider: string, account: string, r5: number, r7: number, extra: Partial<AccountQuota> = {}): AccountQuota => ({
  provider,
  account,
  windows: [{ label: "5h", remainingPct: r5 }, { label: "7d", remainingPct: r7 }],
  ...extra,
})

describe("format", () => {
  test("providerForModel", () => {
    expect(providerForModel(P, "claude-opus-4")).toBe("claude")
    expect(providerForModel(P, "gpt-5")).toBe("codex")
    expect(providerForModel(P, "o3-mini")).toBe("codex")
    expect(providerForModel(P, "gemini-3-pro")).toBe("antigravity")
    expect(providerForModel(P, "kimi-k2")).toBe("kimi")
    expect(providerForModel(P, "foo", "kimi")).toBe("kimi")
    expect(providerForModel(P, "foo", "bar")).toBeUndefined()
  })
  test("compactLine single & multi", () => {
    expect(compactLine(P, [acc("claude", "a", 64, 95)], "claude")).toBe("claude 5h 64% · 7d 95%")
    expect(compactLine(P, [acc("claude", "a", 64, 95), acc("claude", "b", 80, 90)], "claude")).toBe(
      "claude 5h 64% · 7d 95% / 5h 80% · 7d 90%",
    )
  })
  test("compactLine shows time to 5h reset", () => {
    const soon = new Date(Date.now() + (90 * 60 + 30) * 1000)
    const a = { provider: "claude", account: "a", windows: [
      { label: "5h", remainingPct: 77, resetsAt: soon },
      { label: "7d", remainingPct: 45, resetsAt: new Date(Date.now() + 86400000) },
    ] }
    expect(compactLine(P, [a], "claude")).toMatch(/^claude 5h 77% \(1h 3[01]m\) · 7d 45%$/)
    const full = { ...a, windows: [{ label: "5h", remainingPct: 100, resetsAt: soon }] }
    expect(compactLine(P, [full], "claude")).toBe("claude 5h 100%")
  })
  test("compactLine puts active provider first and keeps others", () => {
    const accts = [acc("claude", "a", 64, 95), acc("claude", "b", 80, 90), acc("codex", "c", 50, 46)]
    expect(compactLine(P, accts, "codex")).toBe("codex 5h 50% · 7d 46% claude 5h 64% · 7d 95%")
    expect(compactLine(P, accts, "claude")).toBe("claude 5h 64% · 7d 95% / 5h 80% · 7d 90% codex 5h 50% · 7d 46%")
  })
  test("compactSegments assigns tones per value", () => {
    const segs = compactSegments(P, [acc("claude", "a", 3, 15), acc("codex", "c", 0, 60)], "claude")
    const tones = Object.fromEntries(segs.filter((s) => s.text.endsWith("%")).map((s, i) => [`${i}:${s.text}`, s.tone]))
    expect(tones).toEqual({ "0:3%": "critical", "1:15%": "warn", "2:0%": "empty", "3:60%": "ok" })
    expect(segs[0]).toEqual({ text: "claude ", tone: "provider", provider: "claude" })
    expect(segs.find((s) => s.text === "codex ")!.tone).toBe("provider")
    expect(toneFor(20)).toBe("ok")
    expect(toneFor(19.9)).toBe("warn")
    expect(toneFor(4.9)).toBe("critical")
  })
  test("compactLine all providers uses worst account", () => {
    const line = compactLine(P, [acc("claude", "a", 64, 95), acc("claude", "b", 10, 90), acc("kimi", "k", 50, 50)])
    expect(line).toBe("claude 5h 10% · 7d 90% kimi 5h 50% · 7d 50%")
  })
  test("custom providers: matching, order, name", () => {
    const M: ProviderMeta[] = [
      { id: "zed", name: "Zed AI", providerIDs: ["zed-oc"], modelPrefixes: ["Zed-"] },
      { id: "mist", modelPattern: "^mistral-(small|large)" },
      { id: "bad", modelPattern: "([" },
    ]
    expect(providerForModel(M, "x", "zed-oc")).toBe("zed")
    expect(providerForModel(M, "x", "mist")).toBe("mist")
    expect(providerForModel(M, "zed-1")).toBe("zed")
    expect(providerForModel(M, "vendor/Mistral-Large-2")).toBe("mist")
    expect(providerForModel(M, "nothing")).toBeUndefined()
    expect(providerForModel(M, undefined, undefined)).toBeUndefined()
    const accts = [acc("other", "o", 10, 10), acc("mist", "m", 20, 20), acc("zed", "z", 30, 30)]
    expect(compactLine(M, accts)).toBe("Zed AI 5h 30% · 7d 30% mist 5h 20% · 7d 20% other 5h 10% · 7d 10%")
    expect(compactSegments(M, accts)[0]).toEqual({ text: "Zed AI ", tone: "provider", provider: "zed" })
    expect(compactLine(M, accts, "other").startsWith("other ")).toBe(true)
    expect(reportGroups(M, accts).map((g) => g.provider)).toEqual(["zed", "mist", "other"])
  })
  test("fullReport", () => {
    const now = Date.parse("2026-10-08T10:00:00Z")
    const r = fullReport(
      [
        { ...acc("claude", "me@x", 64, 100), plan: "max", windows: [
          { label: "5h", remainingPct: 64, resetsAt: new Date(now + (2 * 60 + 13) * 60000) },
          { label: "7d", remainingPct: 100, resetsAt: new Date(now + 86400000) },
        ] },
        { provider: "codex", account: "c", windows: [], error: "boom" },
      ],
      now,
    )
    expect(r).toContain("claude · me@x · max")
    expect(r).toContain("resets in 2h 13m")
    expect(r).not.toContain("resets in 1d")
    expect(r).toContain("error: boom")
  })
})

