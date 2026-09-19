# Thread Commissioning: Joiner 3-Message Slice (design-first, no code yet)

> Status: DESIGN DOC (§9.3 step 1). No sketch/harness/shim changes landed.
> Decided AFTER the §9.1 StartAt probe + §9.2 tick-death triage (2026-09-19).
> Next: joiner-only minimal build + verifier `40-verify-thread-joiner.mjs`.

## 1. Goal

Prove a new node can join the emulated Thread partition WITHOUT the static
test master key baked in — the PSKc/joiner flow — while reusing the exact
virtual-radio medium that already carries attach (relay + staged slots +
deferred completion). Smallest slice first: **joiner-only**, commissioner
stubbed by the harness holding the PSKc.

## 2. What the SDK surface gives us (measured 2026-09-19, esp32:esp32 3.3.10)

- `OThread.h` exposes dataset commit only (`commitDataSet`, `hasActiveDataset`,
  `getCurrentDataSet`) — NO joiner hooks. Raw `otJoiner*` is reachable from
  the sketch: `openthread/joiner.h` ships in per-chip `esp32c6-libs`
  (`otJoinerStart`, `otJoinerStop`, `otJoinerGetState`, `OT_JOINER_STATE_*`).
- `commissioner.h` + `dataset*.h` ship alongside — full-commissioner slice is
  possible later, but NOT this slice.
- Sketch links OT FTD (`thread_ftd.h` already included); joiner needs no new
  libs — only `#include <openthread/joiner.h>` + flag-gated call sites
  (same pattern as `THREAD_KEY2` / `THREAD_NODE_B`: never in stock binaries).

## 3. The 3-message slice

```
Joiner (new node, no dataset)          Commissioner (harness stub, holds PSKc)
-----------------------------          ---------------------------------------
1. DISCOVERY  --Beacon Request-->  (existing scan path: fabricated beacons)
              <--Beacon (with Joiner flag)--
2. PSKc AUTH  --DTLS-PSK handshake-->  harness answers with held PSKc
              (Joiner Entrust carried as MLE data frames over 802.15.4)
3. DATASET DELIVER  <--Active Dataset--  (commissioner sends network key)
              --Child-ID exchange-->  (EXISTING attach flow takes over)
```

- Messages 1+3 already ride the proven medium (scan beacons + MLE relay).
  Only message 2 is new crypto — and it stays in-guest (real OT DTLS),
  harness just forwards bytes like any MLE-data frame.
- Joiner state observable via `otJoinerGetState()` polls printed as
  `[THREAD] joiner-state=N` (IDLE 0 → DISCOVER 1 → CONNECT 2 → CONNECTED 3
  → ENTRUST 4 → JOINED 5), same poll-print pattern as role/radio/diag.
- Verifier asserts: state reaches JOINED, then role 2 via the EXISTING
  attach path (proves dataset delivery, not just handshake).

## 4. What must be built (in order)

1. **Sketch (`-DTHREAD_JOINER`, /tmp builds only):** skip `provisionThreadNetwork()`
   (no static key), call `otJoinerStart(instance, PSKc, …)` after link-enable,
   poll `otJoinerGetState()` in `loop()`. Reuse alarm pump + GetState poll.
2. **Commissioner stub (harness JS):** hold test PSKc `J01NME` (public test
   credential, same class as the static test key — safe in-tree), forward
   joiner frames between nodes like MLE relay (no crypto host-side).
3. **Verifier `40-verify-thread-joiner.mjs`:** leader A (static key) + joiner B
   (PSKc only) → asserts JOINED then role 2. Mirror 37's structure
   (per-direction queues, `frame.n` cursors, slot-free staging).
4. **Later (out of slice):** full OT commissioner on A (`commissioner.h`),
   in-network rekey (key seq++ with `keyIdx=(seq&0x7f)+1` wire assert via
   CTR-crib method, §8), PSKc rotation.

## 5. Risks / unknowns

- Joiner DTLS frames are larger/longer-lived than ParentReq — the 127B PSDU
  cap + 160B slot may need chunking (same pattern as SDMMC `writeChunk`).
- Commissioner stub timing: DTLS has real timeouts (unlike MLE retries that
  tolerate spam) — StartAt pacing (§9.1) may become load-bearing here.
- `otJoinerStart` signature takes PSKc + provision URL + vendor data args —
  check exact 3.3.10 prototype before writing the sketch (read `joiner.h:113`).
- H2/C5 tick-decay (§9.2: DISPROVEN as death — 100k-batch solos healthy on
  all chips, rescans rc=0) is not a blocker for joiner timing.

## 6. Gate

`40-verify-thread-joiner` green (JOINED + role 2, no Guru) + 32/35/36/37
still green. Commit sketch-flag + samples-gating + verifier together;
key material stays public-test-only.
