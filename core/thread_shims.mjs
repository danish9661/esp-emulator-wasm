// 802.15.4 / Thread radio shims (Phase 1a + 1b + 1c).
//
// Root cause (C6 ThreadDemo, esp-emu 0.42.0):
//   - esp_ieee802154_enable() -> -1 (intr_alloc: No free interrupt inputs
//     for ZB_MAC interrupt; ieee802154_mac_init fails)
//   - otPlatRadioGetState() returns 255 (INVALID; stubbed li a0,255 + c.ret)
//   - scans start (rc=0) but never complete (no TxDone/RxDone without radio)
//
// Phase 1a (observability): stub enable/receive/state, tap TX as `G` frames.
// Phase 1b (completion):
//   - Transmit calls otPlatRadioTxDone synchronously (a pure OT-core
//     trampoline into Radio::Callbacks — verified by disassembly, no RF).
//   - EnergyScan completion is DEFERRED: completing synchronously would run
//     SubMac::HandleEnergyScanDone BEFORE SubMac::EnergyScan's own
//     `SetState(kStateEnergyScan)` continuation, wedging the state at 5
//     forever (next Links::Send asserts mac_links.hpp:536 — root-caused via
//     disassembly, not guessed). Instead the EnergyScan park sets a flag and
//     the smart GetState park delivers EnergyScanDone on a later poll, when
//     the state machine is quiescent. The sketch retries ActiveScan after
//     the energy callback fires.
// Phase 1c (fabricated beacons): the Transmit shim detects outgoing beacon
//   requests (command type + cmd ID 7 at the broadcast short-dst offset) and
//   jumps to an inbound park that delivers a host-staged frame when present,
//   else falls through to a beacon park that crafts a beacon (PAN 0x1234,
//   ext C4:22:…, ch from TX, rssi -50, lqi 200) in DRAM scratch plus a full
//   otRadioFrame struct, then calls otPlatRadioReceiveDone synchronously.
//   Active scans now return results (same fabricated-peer philosophy as BLE).
//   ConvertBeacon requires ext-src (short sets mode 1, silently dropped) and
//   delivery needs Mac+1==1 borrowed (dwell substate) — both verified, not
//   guessed; see Wave G notes in HANDOVER.md.
// Phase 1d (RX injection): the host stages a COMPLETE otRadioFrame+PSDU in
//   the inbound slot (discovered via magic scan, BLE-mirror style); the
//   inbound park delivers it on the next TX instead of the fabricated beacon
//   (consumes the slot). Deterministic, no timing races — the foundation for
//   multi-node relay (harness forwards A's room frames into B's slot).
//   Hard-won mapping rule: JS-staged bytes are NOT guest-visible in place —
//   the inbound park guest-copies struct+psdu (160B, mac_init copySub) to the
//   proven rxBase scratch first (guest-to-guest copies always land), then
//   delivers the copy. Verified by readback + clone experiments, not guessed.
//   The slot check (magic + nonzero len) doubles as a frame-presence test;
//   GetState plants magic idempotently (conditional init only) so polls can
//   neither clobber a staging nor resurrect a consumed slot.
//
// Layout (all RV32I; flash<->IRAM links are absolute `li`+`jalr`, never JAL):
//   esp_ieee802154_enable   (24B) -> ret0 (8B, inline)
//   esp_ieee802154_disable  (24B) -> ret0 (inline)
//   otPlatRadioReceive      (26B) -> ret0 (inline)
//   otPlatRadioTransmit     (254B)-> entry `j +0x5A`; main shim at +0x5A:
//     frame + `jal emitSub` + save channel + TxDone + borrow Mac+1 +
//     beacon-request detect + conditional `j inboundPark`, else ret0.
//     (ALL MAC traffic enters via Radio::Transmit's tail-jump to +0x5A; the
//     full entry is uncalled. Serving +0x5A covers both.)
//   otPlatRadioEnergyScan   (38B) -> `j energyPark` (extra)
//   otPlatRadioGetState     (6B)  -> `j getstatePark` (extra; WEAK stub)
//   ieee802154_mac_init     (266B, dead: its only caller esp_ieee802154_enable
//     is stubbed above) hosts the 1b parks + the copy subroutine:
//       +0:  energyPark   — emit `H<ch>`, set pending flag, ret0
//       +84: getstatePark — if flag set: clear it, EnergyScanDone(inst,-60);
//                            plant inbound-slot magic; always RECEIVE (2)
//       +172: copySub     — word-copy 160B slot→rxBase (leaf, T1/T2/T3)
//   ieee802154_transmit     (250B IRAM, dead: our shim never calls down to
//     RF) hosts emitSub + inboundPark (in that order).
//   ieee802154_transmit_at  (254B IRAM, dead: only caller was the replaced
//     Transmit body) hosts the beacon park.
//     (Both IRAM boxes ARE writable through the flash image's LOAD segments
//     — verified, not assumed.)
//
// G frame: `G<ch:raw><len:raw><psdu:2*len nibbles>`.
// H frame: `H<ch:raw>` (energy-scan request telemetry).
// Scratch map: HP I2C cell (coherent staging) + LP SRAM (park-only).
//   HP+0x20: energy pending flag (zero at boot; clobber-harmless)
//   HP+0x180 (164B): inbound STAGING slot = otRadioFrame struct (32B) +
//     psdu (128B) + magic u32 @+160 (planted by getstatePark with mPsdu,
//     consumed on delivery). Transient (<= one poll period) + gated.
//   LP+0x100 (160B): delivery scratch (rxBase; park-only, never JS-staged)
//   LP+0x28: delivery counter (telemetry); LP+0x200: LP mirror anchor
//     (magic+len0+mPsdu, planted by beaconPark for per-run JS discovery;
//     clear of copySub's LP+0x100+160B blast radius).
// `G`/`H` were free (used: W/R/Q/S/N/A/V/P/I/C/T/D/M/F/L/B/E).
//
// otRadioFrame layout (platform/radio.h, ABI-stable): psdu@0, len@4(u16),
// ch@6, union@8 { timestamp@8, ackCtr@16, ackKey@20, rssi@21, lqi@22 }.
// Beacon PSDU (23B: MHR 13 + superframe/gts/pending 4 + payload 4 + FCS 2,
// matching OT's own PrepareBeacon): FCF 0xD000 (beacon, dst NONE, src EXT,
// version 2006), seq 0x5A, src PAN 0x1234, src ext C4:22:22:22:22:22:22:22,
// superframe 0x00FF, gts/pending 0, payload FF 0F 00 00, FCS pad zeros.
//
// No reply polling anywhere, so no UART mask discipline applies. FRAME
// DISCIPLINE (hard-won): chained parks must leave exactly the frames their
// downstream epilogue pops. beaconPark double-pops (its own + txMain's), so
// inboundPark pops its own frame before falling through to it — jumping
// with three frames live returns into txMain's detect and loops forever
// (infinite re-report flood: 1 TX → 6826 prints, no completion).
// Soft-fail: missing/small symbols or a bad fit skip with a warning; each
// layer (TX completion, energy, beacon, inbound) degrades independently.

import { assemble, asm32, li, A0, A1, A2, A3, T0, T1, T2, T3, T4, T5, SP, S0 } from './rvasm.mjs';
import { makeJal } from '../elf.mjs';

const UART_BASE_DEFAULT = 0x60000000;
const ENERGY_RSSI = -60;
const PSDU_CAP = 127; // OT MTU cap (only used by the plain-fallback shim)
const TX_MAIN_OFF = 90; // 0x5A: Radio::Transmit's tail-jump target
const FLAG_WORD_OFF = 0x20;
const RX_SCRATCH_OFF = 0x100;
const SLOT_OFF = 0x180; // inbound slot base (struct + psdu + magic)
const SLOT_MAGIC = 0x54485244; // 'THRD'
// Scratch homes (split by coherence, root-caused, not guessed):
//   HP I2C cell (0x40820000): JS<->guest COHERENT on all chips (proven by
//     35/36 pre-move passes) but heap-owned. Holds TRANSIENT or HARMLESS
//     state only: flag +0x20 (4B; clobber = spurious EnergyScanDone,
//     already tolerated). The staging slot ALSO lives here on H2/C5
//     (heap-quiet there; verified by 36).
//   LP SRAM (0x50000000, shared C6/H2/C5; heap-excluded by capability):
//     park-RW reliable on all chips. JS->guest staging reliable on C6
//     (Adel era) but UNRELIABLE on H2 (Bdel freeze / A2solo) — so the
//     C6 staging slot lives here (C6 heap eats HP on long runs), while
//     H2/C5 stage in HP. LP also holds PARK-ONLY state JS never writes:
//     rxBase +0x100 (160B delivery scratch), counter +0x28, mirror +0x200.
//   LP mirror: beaconPark plants magic+len0+mPsdu at LP+0x200 so JS can
//     locate LP per run (buffer offsets wander with growth); the delivery
//     counter lives at mirror-0x1d8.
const HP_BASE = 0x40820000;
const LP_BASE = 0x50000000;

// Fabricated beacon identity (asserted by 32-verify, proves synthesis).
const BEACON_RSSI = -50;
const BEACON_LQI = 200;
// Beacon PSDU (23B: MHR 13 + superframe/gts/pending 4 + payload 4 + FCS 2).
// Matches what OT itself emits (PrepareBeacon builds ext-src + payload
// FF 0F 00 00): FCF 0xD000 (beacon, dst NONE, src EXT, version 2006,
// no pancomp), seq 0x5A, src PAN 0x1234, src ext C4:22:22:22:22:22:22:22,
// superframe 0x00FF, gts/pending 0, payload FF 0F 00 00, FCS pad zeros.
// NOTE: ConvertBeaconToActiveScanResult requires an EXTENDED src address
// (Address mode Short=1 is silently dropped; Ext=2 passes) — verified
// against OT's own beacon construction, not guessed.
const BEACON_W0 = 0x345ad000;
const BEACON_W1 = 0x2222c412;
const BEACON_W2 = 0x22222222;
const BEACON_W3 = 0x0000ff22;
const BEACON_W4 = 0x000fff00;
const BEACON_LEN = 23;

// Placeholder markers for hand-patched absolute calls (scanned out of the
// assembled blob; values never collide with real encodings here). `li` is
// always exactly two words, so paired markers stay aligned.
const PH_EL0 = 0x454c3030;
const PH_EL1 = 0x454c3031;
const PH_DL0 = 0x444c3030;
const PH_DL1 = 0x444c3031;
const PH_IN0 = 0x494e3030;
const PH_IN1 = 0x494e3031;
const PH_J0 = 0x494a3030;
const PH_J1 = 0x494a3031;
const PH_BC0 = 0x42433030;
const PH_BC1 = 0x42433031;
const PH_CP0 = 0x43503030;
const PH_CP1 = 0x43503031;
const PH_DV0 = 0x44563030;
const PH_DV1 = 0x44563031;

function flagAddrFor(chip) {
    void chip;
    return (HP_BASE + FLAG_WORD_OFF) >>> 0;
}

function rxScratchFor(chip) {
    void chip;
    return (LP_BASE + RX_SCRATCH_OFF) >>> 0;
}

function slotAddrFor(chip) {
    // C6 stages in LP (its heap eats HP on long runs; C6-LP is coherent).
    // H2/C5 stage in HP (coherent there, heap-quiet). Separate MCU
    // instances never share memory, so the split is safe.
    if (chip === 'esp32c6') return (LP_BASE + SLOT_OFF) >>> 0;
    return (HP_BASE + SLOT_OFF) >>> 0;
}

function ret0() {
    return asm32(assemble([
        { op: 'addi', rd: A0, rs1: 0, imm: 0 },
        { op: 'ret' },
    ]));
}

/**
 * G-frame emit leaf (in transmit-park, called via `jal ra,emit`).
 * Args pass through untouched (a0/a1 read-only here); t-regs only.
 * a1 = frame (+0 psdu ptr, +4 len, +6 channel).
 */
function emitSub() {
    const p = [
        { op: 'lui', rd: T0, imm: UART_BASE_DEFAULT },
        // ESC _ G
        { op: 'addi', rd: T2, rs1: 0, imm: 27 }, { op: 'sw', rs2: T2, rs1: T0, imm: 0 },
        { op: 'addi', rd: T2, rs1: 0, imm: 95 }, { op: 'sw', rs2: T2, rs1: T0, imm: 0 },
        { op: 'addi', rd: T2, rs1: 0, imm: 71 }, { op: 'sw', rs2: T2, rs1: T0, imm: 0 },
        // ch = frame[6]; len = frame[4] (OT guarantees <= 127; the JS
        // controller clamps regardless, so no cap here — box budget).
        { op: 'lbu', rd: T1, rs1: A1, imm: 6 }, { op: 'sw', rs2: T1, rs1: T0, imm: 0 },
        { op: 'lbu', rd: T4, rs1: A1, imm: 4 },
        { op: 'sw', rs2: T4, rs1: T0, imm: 0 },
        // T3 = psdu cursor
        { op: 'lw', rd: T3, rs1: A1, imm: 0 },
        { label: 'em_psdu' },
        { op: 'beq', rs1: T4, rs2: 0, label: 'em_done' },
        { op: 'lbu', rd: T1, rs1: T3, imm: 0 },
        { op: 'srli', rd: T2, rs1: T1, sh: 4 }, { op: 'addi', rd: T2, rs1: T2, imm: 97 }, { op: 'sw', rs2: T2, rs1: T0, imm: 0 },
        { op: 'andi', rd: T2, rs1: T1, imm: 15 }, { op: 'addi', rd: T2, rs1: T2, imm: 97 }, { op: 'sw', rs2: T2, rs1: T0, imm: 0 },
        { op: 'addi', rd: T3, rs1: T3, imm: 1 },
        { op: 'addi', rd: T4, rs1: T4, imm: -1 },
        { op: 'jal', rd: 0, label: 'em_psdu' },
        { label: 'em_done' },
        // ESC \
        { op: 'addi', rd: T2, rs1: 0, imm: 27 }, { op: 'sw', rs2: T2, rs1: T0, imm: 0 },
        { op: 'addi', rd: T2, rs1: 0, imm: 92 }, { op: 'sw', rs2: T2, rs1: T0, imm: 0 },
        { op: 'ret' },
    ];
    return asm32(assemble(p));
}

/**
 * Main Transmit shim program (at Transmit+90) with three hand-patched
 * absolute-call sites (labels cannot cross separately-placed blobs, and the
 * IRAM bodies are out of JAL range anyway, so `li`+`jalr` throughout):
 *   PH_EL0/1: `li t5, emitAt`    + `jalr ra, t5`  (emitSub call)
 *   PH_DL0/1: `li t1, txDoneAddr` + `jalr ra, t1` (TxDone call)
 *   PH_IN0/1: `li t5, inboundAt`  + `jalr x0, t5` (scan-TX path)
 *   PH_J0/1:  `li t5, inbound2At` + `jalr x0, t5` (MLE-TX path, no beacon)
 * a0 = instance, a1 = frame. s0 carries the TX channel across TxDone
 * (callee-saved); the saved frame/instance feed the detect and the jump.
 * Frame-type gate (fixes the SubMac-busy wedge): only scan TXs
 * (MAC-command type 3, i.e. beacon requests) take the beacon-fallback
 * path (with dwell borrow). MLE-data TXs (type 1) go to inbound2Park
 * (staged delivery or clean return — never a fabricated beacon, which
 * wedges SubMac busy forever in idle context).
 */
function txMainProg() {
    return [
        { op: 'addi', rd: SP, rs1: SP, imm: -16 },
        { op: 'sw', rs2: 1, rs1: SP, imm: 12 },
        { op: 'sw', rs2: S0, rs1: SP, imm: 8 },
        { op: 'sw', rs2: A0, rs1: SP, imm: 4 },
        { op: 'sw', rs2: A1, rs1: SP, imm: 0 },
        { op: 'lbu', rd: S0, rs1: A1, imm: 6 }, // s0 = TX channel
        { op: 'raw', w: PH_EL0 },
        { op: 'raw', w: PH_EL1 },
        { op: 'jalr_ra', rs1: T5 },
        // TxDone(instance, frame, NULL, NONE); a0/a1 intact (emit is a leaf).
        { op: 'addi', rd: A2, rs1: 0, imm: 0 },
        { op: 'addi', rd: A3, rs1: 0, imm: 0 },
        { op: 'raw', w: PH_DL0 },
        { op: 'raw', w: PH_DL1 },
        { op: 'jalr_ra', rs1: T1 },
        // Post-TX hook: route by TX frame type (wedge fix). Scan TXs
        // (MAC-command type 3: beacon requests) take the inbound park
        // (staged delivery or fabricated beacon, with dwell borrow).
        // MLE-data TXs (type 1) take inbound2Park (staged delivery or
        // clean return — never a beacon: fabricated beacons on MLE TXs
        // wedge SubMac busy forever). Frame ptr reloaded (TxDone
        // clobbers a1); double-deref to FCF.
        { op: 'lw', rd: A0, rs1: SP, imm: 4 }, // a0 = instance
        { op: 'lw', rd: T2, rs1: SP, imm: 0 }, // t2 = frame ptr
        { op: 'lw', rd: T2, rs1: T2, imm: 0 }, // t2 = mPsdu
        { op: 'lbu', rd: T2, rs1: T2, imm: 0 }, // t2 = FCF low
        { op: 'andi', rd: T2, rs1: T2, imm: 7 }, // t2 = frame type
        { op: 'addi', rd: T1, rs1: 0, imm: 3 },
        { op: 'bne', rs1: T2, rs2: T1, label: 'tx_mle' },
        // Scan path: borrow Mac dwell substate (beacon routing needs
        // Mac+1 == 1; nested-TX delivery runs before OT advances it).
        // Mac* = instance + 0x2F8C; asserted by 32-verify.
        ...li(T4, 0x2f8c),
        { op: 'add', rd: T4, rs1: A0, rs2: T4 },
        { op: 'addi', rd: T2, rs1: 0, imm: 1 },
        { op: 'sb', rs2: T2, rs1: T4, imm: 1 },
        { op: 'addi', rd: A1, rs1: S0, imm: 0 }, // a1 = channel for inboundPark
        { op: 'raw', w: PH_IN0 },
        { op: 'raw', w: PH_IN1 },
        { op: 'jalr', rd: 0, rs1: T5, imm: 0 },
        { label: 'tx_mle' },
        // MLE path: no borrow (natural state correct for data), no
        // beacon. inbound2Park delivers staged or returns clean.
        { op: 'addi', rd: A1, rs1: S0, imm: 0 }, // a1 = channel (ignored)
        { op: 'raw', w: PH_J0 },
        { op: 'raw', w: PH_J1 },
        { op: 'jalr', rd: 0, rs1: T5, imm: 0 },
        { label: 'tx_skip' },
        { op: 'lw', rd: 1, rs1: SP, imm: 12 },
        { op: 'lw', rd: S0, rs1: SP, imm: 8 },
        { op: 'addi', rd: SP, rs1: SP, imm: 16 },
        { op: 'addi', rd: A0, rs1: 0, imm: 0 },
        { op: 'ret' },
    ];
}

/** Patch `li`-pair placeholders in an assembled blob: [[m0, m1, rd, val]]. */
function patchPairs(bytes, pairs) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (const [m0, m1, rd, val] of pairs) {
        let at = -1;
        for (let o = 0; o + 8 <= bytes.length; o += 4) {
            if ((dv.getUint32(o, true) >>> 0) === m0 && (dv.getUint32(o + 4, true) >>> 0) === m1) { at = o; break; }
        }
        if (at < 0) throw new Error('txMain placeholders missing');
        const w = li(rd, val);
        dv.setUint32(at, w[0] >>> 0, true);
        dv.setUint32(at + 4, w[1] >>> 0, true);
    }
    return bytes;
}

/**
 * Word-copy subroutine (mac_init free space): copies 40 words (160B:
 * struct + psdu) from the inbound slot to the proven rxBase scratch.
 * Baked addresses, leaf (no calls, no frame); uses T1/T2/T3 only, so the
 * caller's T0 (slot) and a0 (instance) survive.
 */
function copySub(slotAddr, rxBase) {
    const p = [
        ...li(T1, slotAddr),
        ...li(T2, rxBase),
        { op: 'addi', rd: T3, rs1: 0, imm: 40 },
        { label: 'cp_loop' },
        { op: 'lw', rd: T4, rs1: T1, imm: 0 },
        { op: 'sw', rs2: T4, rs1: T2, imm: 0 },
        { op: 'addi', rd: T1, rs1: T1, imm: 4 },
        { op: 'addi', rd: T2, rs1: T2, imm: 4 },
        { op: 'addi', rd: T3, rs1: T3, imm: -1 },
        { op: 'bne', rs1: T3, rs2: 0, label: 'cp_loop' },
        { op: 'ret' },
    ];
    return asm32(assemble(p));
}

/**
 * Inbound park (in the transmit box, after emitSub): deliver a host-staged
 * frame when present, else fall through to the fabricated beacon park.
 * Entered via `jalr x0` with a0 = instance, a1 = channel; s0 = channel
 * (preserved for our caller). Slot layout (all offsets from slot base):
 * struct (32B: mPsdu guest ptr, len u16, ch, rssi@21, lqi@22) + psdu
 * (128B) + magic u32 @+160. Consumes the slot (clears magic+len) so each
 * staging delivers exactly once; an empty slot (no magic or len 0) falls
 * through. Returns directly to SubMac (double-pop, like beaconPark).
 * mPsdu gate (like deliverPark): heap phantoms must not be consumed.
 */
function inboundPark(slotAddr, doneAddr, rxBase) {
    const p = [
        { op: 'addi', rd: SP, rs1: SP, imm: -16 },
        { op: 'sw', rs2: 1, rs1: SP, imm: 12 },
        ...li(T0, slotAddr),
        { op: 'lw', rd: T1, rs1: T0, imm: 160 },
        ...li(T2, SLOT_MAGIC),
        { op: 'bne', rs1: T1, rs2: T2, label: 'in_fallback' },
        { op: 'lbu', rd: T1, rs1: T0, imm: 4 }, // struct len low byte
        { op: 'beq', rs1: T1, rs2: 0, label: 'in_fallback' },
        { op: 'lw', rd: T1, rs1: T0, imm: 0 }, // staged mPsdu
        ...li(T2, (slotAddr + 32) >>> 0),
        { op: 'bne', rs1: T1, rs2: T2, label: 'in_fallback' }, // phantom → beacon
        // Guest-copy staged struct+psdu (160B) to the proven rxBase scratch
        // FIRST (JS-staged bytes may not be guest-visible in place, but
        // guest-to-guest copies always are), then consume the slot.
        { op: 'raw', w: PH_CP0 },
        { op: 'raw', w: PH_CP1 },
        { op: 'jalr_ra', rs1: T5 },
        // Consume: clear magic + len.
        { op: 'sw', rs2: 0, rs1: T0, imm: 160 },
        { op: 'sw', rs2: 0, rs1: T0, imm: 4 },
        // ReceiveDone(instance, rxframe=rxBase, NONE). a0 intact (t-regs).
        // (No mPsdu fix here: transmit box is 6B short; the TX window is
        // transient-safe. deliverPark (roomy box) has the fix.)
        ...li(T0, rxBase),
        { op: 'addi', rd: A1, rs1: T0, imm: 0 },
        { op: 'addi', rd: A2, rs1: 0, imm: 0 },
        ...li(T1, doneAddr),
        { op: 'jalr_ra', rs1: T1 },
        // Epilogue: SubMac's ra from the Transmit frame (s0 untouched);
        // pop both frames.
        { op: 'lw', rd: 1, rs1: SP, imm: 28 },
        { op: 'addi', rd: SP, rs1: SP, imm: 32 },
        { op: 'addi', rd: A0, rs1: 0, imm: 0 },
        { op: 'ret' },
        { label: 'in_fallback' },
        // Pop our own frame first: beaconPark's double-pop epilogue assumes
        // exactly one frame (txMain's) beneath it; jumping with ours still
        // on would return into txMain's detect and loop forever (root-caused
        // the infinite re-report flood, not guessed).
        { op: 'addi', rd: SP, rs1: SP, imm: 16 },
        { op: 'raw', w: PH_BC0 },
        { op: 'raw', w: PH_BC1 },
        { op: 'jalr', rd: 0, rs1: T5, imm: 0 },
    ];
    return asm32(assemble(p));
}

/**
 * Inbound2 park (MLE-data entry, in the dead LL IRAM box): deliver a
 * host-staged frame when present, else return clean (NO fabricated
 * beacon). Fabricated beacons on MLE-data TXs wedge SubMac busy forever
 * (phantom scan state — root-caused via rescan-BUSY + no-beacon-stub
 * unblocking retries/election/ads, not guessed). Scan TXs (beacon-req)
 * keep using inboundPark (beacon fallback appropriate there).
 * Entered via `jalr x0` like inboundPark (same frame discipline).
 */
function inbound2Park(slotAddr, doneAddr, rxBase) {
    const p = [
        { op: 'addi', rd: SP, rs1: SP, imm: -16 },
        { op: 'sw', rs2: 1, rs1: SP, imm: 12 },
        ...li(T0, slotAddr),
        { op: 'lw', rd: T1, rs1: T0, imm: 160 },
        ...li(T2, SLOT_MAGIC),
        { op: 'bne', rs1: T1, rs2: T2, label: 'in2_empty' },
        { op: 'lbu', rd: T1, rs1: T0, imm: 4 }, // struct len low byte
        { op: 'beq', rs1: T1, rs2: 0, label: 'in2_empty' },
        { op: 'lw', rd: T1, rs1: T0, imm: 0 }, // staged mPsdu
        ...li(T2, (slotAddr + 32) >>> 0),
        { op: 'bne', rs1: T1, rs2: T2, label: 'in2_empty' }, // phantom → nothing
        // Guest-copy staged struct+psdu (160B) to rxBase, then consume.
        { op: 'raw', w: PH_CP0 },
        { op: 'raw', w: PH_CP1 },
        { op: 'jalr_ra', rs1: T5 },
        // Consume: clear magic + len.
        { op: 'sw', rs2: 0, rs1: T0, imm: 160 },
        { op: 'sw', rs2: 0, rs1: T0, imm: 4 },
        // ReceiveDone(instance, rxframe=rxBase, NONE). a0 intact (t-regs).
        // Fix mPsdu to the LP copy (see deliverPark).
        ...li(T0, rxBase),
        { op: 'addi', rd: T1, rs1: T0, imm: 32 },
        { op: 'sw', rs2: T1, rs1: T0, imm: 0 },
        { op: 'addi', rd: A1, rs1: T0, imm: 0 },
        { op: 'addi', rd: A2, rs1: 0, imm: 0 },
        ...li(T1, doneAddr),
        { op: 'jalr_ra', rs1: T1 },
        // Epilogue: SubMac's ra from the Transmit frame (s0 untouched);
        // pop both frames.
        { op: 'lw', rd: 1, rs1: SP, imm: 28 },
        { op: 'addi', rd: SP, rs1: SP, imm: 32 },
        { op: 'addi', rd: A0, rs1: 0, imm: 0 },
        { op: 'ret' },
        { label: 'in2_empty' },
        // Clean return (no beacon): pop own frame, then txMain's frame.
        { op: 'addi', rd: SP, rs1: SP, imm: 16 },
        { op: 'lw', rd: 1, rs1: SP, imm: 12 },
        { op: 'addi', rd: SP, rs1: SP, imm: 16 },
        { op: 'addi', rd: A0, rs1: 0, imm: 0 },
        { op: 'ret' },
    ];
    return asm32(assemble(p));
}

/**
 * Beacon park (in transmit-park, after emitSub): craft the beacon + a full
 * otRadioFrame in scratch, call ReceiveDone(instance, rxframe, NONE).
 * Entered via `j` with a0 = instance, a1 = channel; s0 = channel (preserved
 * for our caller). Returns directly to SubMac: restores s0/ra from the
 * still-active Transmit frame and pops both frames.
 */
function beaconPark(rxBase, rxDoneAddr) {
    const rssilqi = ((BEACON_LQI << 16) | ((BEACON_RSSI & 0xff) << 8)) >>> 0;
    const p = [
        { op: 'addi', rd: SP, rs1: SP, imm: -16 },
        { op: 'sw', rs2: 1, rs1: SP, imm: 12 },
        // LP mirror anchor (per-run JS discovery of LP). Idempotent.
        // NOTE: must clear copySub's blast radius (rxBase+160B ends at
        // LP+0x1A0); +0x200 is clear on all chips (H2 LP is 4K).
        ...li(T0, (LP_BASE + 0x200) >>> 0),
        ...li(T1, SLOT_MAGIC),
        { op: 'sw', rs2: T1, rs1: T0, imm: 160 },
        { op: 'sw', rs2: 0, rs1: T0, imm: 4 },
        ...li(T1, (LP_BASE + 0x200 + 32) >>> 0),
        { op: 'sw', rs2: T1, rs1: T0, imm: 0 },
        ...li(T0, rxBase),
        // Zero metadata words (timestamp, ack counter): garbage here was
        // observed to wedge the scan into an infinite re-report loop.
        { op: 'sw', rs2: 0, rs1: T0, imm: 8 },
        { op: 'sw', rs2: 0, rs1: T0, imm: 12 },
        { op: 'sw', rs2: 0, rs1: T0, imm: 16 },
        // Beacon PSDU (21B + 2 FCS pad).
        ...li(T1, BEACON_W0),
        { op: 'sw', rs2: T1, rs1: T0, imm: 32 },
        ...li(T1, BEACON_W1),
        { op: 'sw', rs2: T1, rs1: T0, imm: 36 },
        ...li(T1, BEACON_W2),
        { op: 'sw', rs2: T1, rs1: T0, imm: 40 },
        ...li(T1, BEACON_W3),
        { op: 'sw', rs2: T1, rs1: T0, imm: 44 },
        ...li(T1, BEACON_W4),
        { op: 'sw', rs2: T1, rs1: T0, imm: 48 },
        { op: 'sw', rs2: 0, rs1: T0, imm: 52 },
        // mPsdu = scratch+32.
        { op: 'addi', rd: T1, rs1: T0, imm: 32 },
        { op: 'sw', rs2: T1, rs1: T0, imm: 0 },
        // len + channel word @4 (top byte 0 covers mRadioType).
        { op: 'slli', rd: T1, rs1: A1, sh: 16 },
        { op: 'addi', rd: T1, rs1: T1, imm: BEACON_LEN },
        { op: 'sw', rs2: T1, rs1: T0, imm: 4 },
        // ackKey + rssi + lqi + flags word @20.
        ...li(T1, rssilqi),
        { op: 'sw', rs2: T1, rs1: T0, imm: 20 },
        // ReceiveDone(instance, rxframe, NONE).
        { op: 'addi', rd: A1, rs1: T0, imm: 0 },
        { op: 'addi', rd: A2, rs1: 0, imm: 0 },
        ...li(T1, rxDoneAddr),
        { op: 'jalr_ra', rs1: T1 },
        // Epilogue: SubMac's ra from the Transmit frame (s0 untouched
        // throughout); pop both frames.
        { op: 'lw', rd: 1, rs1: SP, imm: 28 },
        { op: 'addi', rd: SP, rs1: SP, imm: 32 },
        { op: 'addi', rd: A0, rs1: 0, imm: 0 },
        { op: 'ret' },
    ];
    return asm32(assemble(p));
}

/**
 * EnergyScan park (in dead mac_init): emit H<ch>, set the pending flag,
 * return 0. Must NOT call EnergyScanDone here (see header: nesting hazard).
 * Entry args: a0 = instance (preserved, t-regs only), a1 = channel.
 */
function energyPark(flagAddr) {
    const p = [
        { op: 'addi', rd: SP, rs1: SP, imm: -16 },
        { op: 'sw', rs2: 1, rs1: SP, imm: 12 },
        { op: 'lui', rd: T0, imm: UART_BASE_DEFAULT },
        // ESC _ H ch ESC \
        { op: 'addi', rd: T2, rs1: 0, imm: 27 }, { op: 'sw', rs2: T2, rs1: T0, imm: 0 },
        { op: 'addi', rd: T2, rs1: 0, imm: 95 }, { op: 'sw', rs2: T2, rs1: T0, imm: 0 },
        { op: 'addi', rd: T2, rs1: 0, imm: 72 }, { op: 'sw', rs2: T2, rs1: T0, imm: 0 },
        { op: 'andi', rd: T1, rs1: A1, imm: 0xff }, { op: 'sw', rs2: T1, rs1: T0, imm: 0 },
        { op: 'addi', rd: T2, rs1: 0, imm: 27 }, { op: 'sw', rs2: T2, rs1: T0, imm: 0 },
        { op: 'addi', rd: T2, rs1: 0, imm: 92 }, { op: 'sw', rs2: T2, rs1: T0, imm: 0 },
        // flag = 1
        ...li(T0, flagAddr),
        { op: 'addi', rd: T1, rs1: 0, imm: 1 },
        { op: 'sw', rs2: T1, rs1: T0, imm: 0 },
        { op: 'lw', rd: 1, rs1: SP, imm: 12 },
        { op: 'addi', rd: SP, rs1: SP, imm: 16 },
        { op: 'addi', rd: A0, rs1: 0, imm: 0 },
        { op: 'ret' },
    ];
    return asm32(assemble(p));
}

/**
 * Idle-delivery park (in a dead LL IRAM box): deliver a host-staged frame
 * WITHOUT a transmit (silent attach-wait / leader nodes never TX again, so
 * the post-TX inboundPark can never fire for them — the Phase 1e attach
 * stall, root-caused via relay trace, not guessed). Entered via `jalr ra`
 * from the getstatePark hop with a0 = instance; returns there (single-pop).
 * Same proven sequence as inboundPark (guest-copy via copySub, consume,
 * ReceiveDone), but with NO Mac borrow: idle/dwell state is already
 * correct for data (a real RX interrupt changes nothing); the borrow
 * exists for beacons (scan routing) and may poison data. Beacons are
 * held unless dwelling (gate below), when Mac+1 is already 1.
 * FCF gate: beacons (type 0) are HELD unless dwelling (Mac+1==1) — an
 * off-scan poll must not eat a scan-bound beacon (the 35-inject case);
 * the TX path (which borrows dwell) picks it up during the scan. All
 * other types (data, commands) deliver eagerly (the attach case).
 * mPsdu gate: the HP staging slot lives in live heap; heap message
 * buffers can coincidentally match magic+len+type (phantoms — observed
 * as runaway delivery counts). Verify mPsdu == slot+32 (planted by
 * getstate init / stageInto; 2^-32 for heap to match) else HOLD
 * pristine (no consume — consuming would corrupt the heap object).
 */
function deliverPark(slotAddr, doneAddr, rxBase) {
    const p = [
        { op: 'addi', rd: SP, rs1: SP, imm: -16 },
        { op: 'sw', rs2: 1, rs1: SP, imm: 12 },
        { op: 'sw', rs2: A0, rs1: SP, imm: 4 }, // save instance (ReceiveDone clobbers a0)
        // Mac+1 read (dwell? for the beacon gate; no borrow, no save).
        ...li(T4, 0x2f8c),
        { op: 'add', rd: T4, rs1: A0, rs2: T4 }, // t4 = &Mac+1
        { op: 'lbu', rd: T3, rs1: T4, imm: 1 }, // t3 = Mac+1
        // mPsdu gate first (cheap reject before FCF read).
        ...li(T0, slotAddr),
        { op: 'lw', rd: T1, rs1: T0, imm: 0 }, // staged mPsdu
        ...li(T2, (slotAddr + 32) >>> 0),
        { op: 'bne', rs1: T1, rs2: T2, label: 'dv_hold' }, // heap phantom → hold
        // FCF gate: hold beacons (type 0) unless dwelling.
        { op: 'lbu', rd: T1, rs1: T0, imm: 32 }, // psdu[0] (FCF low)
        { op: 'andi', rd: T1, rs1: T1, imm: 7 }, // frame type
        { op: 'bne', rs1: T1, rs2: 0, label: 'dv_deliver' }, // non-beacon → deliver
        { op: 'addi', rd: T2, rs1: 0, imm: 1 },
        { op: 'bne', rs1: T3, rs2: T2, label: 'dv_hold' }, // beacon + idle → hold
        { label: 'dv_deliver' },
        // Guest-copy staged struct+psdu (160B) to rxBase first.
        { op: 'raw', w: PH_CP0 },
        { op: 'raw', w: PH_CP1 },
        { op: 'jalr_ra', rs1: T5 },
        // Consume the slot (exactly-once).
        ...li(T0, slotAddr),
        { op: 'sw', rs2: 0, rs1: T0, imm: 160 },
        { op: 'sw', rs2: 0, rs1: T0, imm: 4 },
        // ReceiveDone(instance, rxframe=rxBase, NONE). Fix the copied
        // struct's mPsdu to the LP copy (staging slot may be HP-coherent
        // but heap-risky; OT must read the heap-clean LP bytes).
        { op: 'lw', rd: A0, rs1: SP, imm: 4 },
        ...li(T0, rxBase),
        { op: 'addi', rd: T1, rs1: T0, imm: 32 },
        { op: 'sw', rs2: T1, rs1: T0, imm: 0 },
        { op: 'addi', rd: A1, rs1: T0, imm: 0 },
        { op: 'addi', rd: A2, rs1: 0, imm: 0 },
        ...li(T1, doneAddr),
        { op: 'jalr_ra', rs1: T1 },
        // Delivery telemetry: count completed ReceiveDone deliveries
        // (JS reads LP_BASE+0x28 via the LP mirror; proves consumption).
        ...li(T0, (LP_BASE + 0x28) >>> 0),
        { op: 'lw', rd: T1, rs1: T0, imm: 0 },
        { op: 'addi', rd: T1, rs1: T1, imm: 1 },
        { op: 'sw', rs2: T1, rs1: T0, imm: 0 },
        // Pop frame, return to the getstate hop (no borrow to restore).
        { op: 'lw', rd: 1, rs1: SP, imm: 12 },
        { op: 'addi', rd: SP, rs1: SP, imm: 16 },
        { op: 'addi', rd: A0, rs1: 0, imm: 0 },
        { op: 'ret' },
        { label: 'dv_hold' },
        // Beacon held for scan context: leave the slot intact, pop frame.
        { op: 'lw', rd: 1, rs1: SP, imm: 12 },
        { op: 'addi', rd: SP, rs1: SP, imm: 16 },
        { op: 'ret' },
    ];
    return asm32(assemble(p));
}

/**
 * Smart GetState park (in dead mac_init, after energyPark): if the pending
 * flag is set, clear it and deliver EnergyScanDone(instance, ENERGY_RSSI)
 * — now safe, long after SubMac::EnergyScan returned. Then, if a frame is
 * staged in the inbound slot, hop to the delivery park (returns here) so
 * silent nodes consume without transmitting. Always reports RECEIVE (2).
 * Entered via `j` (ra = OT's return address).
 * Entry: a0 = instance (survives; t-regs only below, a0 intact to hop).
 */
function getstatePark(flagAddr, energyDoneAddr, slotAddr, withHop) {
    const p = [
        { op: 'addi', rd: SP, rs1: SP, imm: -16 },
        { op: 'sw', rs2: 1, rs1: SP, imm: 12 },
        // Save instance: EnergyScanDone below clobbers a0 (return value),
        // but the delivery hop needs it (Mac borrow + ReceiveDone).
        { op: 'sw', rs2: A0, rs1: SP, imm: 8 },
        ...li(T0, flagAddr),
        { op: 'lw', rd: T1, rs1: T0, imm: 0 },
        { op: 'beq', rs1: T1, rs2: 0, label: 'gs_done' },
        { op: 'sw', rs2: 0, rs1: T0, imm: 0 },
        { op: 'addi', rd: A1, rs1: 0, imm: ENERGY_RSSI },
        ...li(T1, energyDoneAddr),
        { op: 'jalr_ra', rs1: T1 },
        { label: 'gs_done' },
        { op: 'lw', rd: A0, rs1: SP, imm: 8 },
        // Initialize the inbound slot ONCE (when its magic is absent): plant
        // magic + zero len (disarmed). Never touches a live slot, so polls
        // can neither clobber a staged frame nor resurrect a consumed one
        // (consume clears both; the next poll re-arms to disarmed-empty).
        ...li(T0, slotAddr),
        { op: 'lw', rd: T1, rs1: T0, imm: 160 },
        ...li(T2, SLOT_MAGIC),
        { op: 'bne', rs1: T1, rs2: T2, label: 'gs_initarmed' },
        { op: 'jal', rd: 0, label: 'gs_status' },
        { label: 'gs_initarmed' },
        ...li(T1, SLOT_MAGIC),
        { op: 'sw', rs2: T1, rs1: T0, imm: 160 },
        { op: 'sw', rs2: 0, rs1: T0, imm: 4 },
        // Fully form the disarmed slot: mPsdu = slot+32. Lets JS discovery
        // verify candidates (magic + len 0 + mPsdu match), rejecting heap
        // phantoms (OT message buffers with coincidental THRD words).
        ...li(T1, (slotAddr + 32) >>> 0),
        { op: 'sw', rs2: T1, rs1: T0, imm: 0 },
        { label: 'gs_status' },
        { op: 'lw', rd: 1, rs1: SP, imm: 12 },
        { op: 'addi', rd: SP, rs1: SP, imm: 16 },
        { op: 'addi', rd: A0, rs1: 0, imm: 2 },
        { op: 'ret' },
    ];
    if (withHop) {
        // Idle-delivery hop (inserted before gs_status): staged frame
        // present (magic + nonzero len) → jalr to deliverPark (returns).
        // a0 (instance) intact — only T-regs used here.
        const hop = [
            ...li(T0, slotAddr),
            { op: 'lw', rd: T1, rs1: T0, imm: 160 },
            ...li(T2, SLOT_MAGIC),
            { op: 'bne', rs1: T1, rs2: T2, label: 'gs_nodeliver' },
            { op: 'lbu', rd: T1, rs1: T0, imm: 4 },
            { op: 'beq', rs1: T1, rs2: 0, label: 'gs_nodeliver' },
            { op: 'raw', w: PH_DV0 },
            { op: 'raw', w: PH_DV1 },
            { op: 'jalr_ra', rs1: T5 },
            { label: 'gs_nodeliver' },
        ];
        const idx = p.findIndex((i) => i.label === 'gs_status');
        p.splice(idx, 0, ...hop);
    }
    return asm32(assemble(p));
}

export const THREAD_HOOKS = [
    'esp_ieee802154_enable',
    'esp_ieee802154_disable',
    'otPlatRadioReceive',
    'otPlatRadioGetState',
    'otPlatRadioTransmit',
    'otPlatRadioEnergyScan',
    'otPlatRadioTxDone',
    'otPlatRadioEnergyScanDone',
    'otPlatRadioReceiveDone',
    'ieee802154_mac_init',
    'ieee802154_transmit',
    'ieee802154_transmit_at',
    'otPlatAlarmMilliGetNow',
    'xTaskGetTickCount',
];

/**
 * Alarm-Now park (in the dead LL IRAM box): otPlatAlarmMilliGetNow
 * replacement. The FRC/esp_timer alarm ISR never fires in-sim (interrupt
 * starvation — the boot log's "No free interrupt inputs"), so OT
 * TimerMilli alarms pile up forever (no Parent Responses, no retries, no
 * advertisements — root-caused via 150s ad-less leader run with live
 * ticks/etime/heap, not guessed). This park reports FreeRTOS ticks
 * (alive, ms-ish) as the alarm timebase; the sketch pumps
 * otPlatAlarmFired() every loop so expired timers run (polled alarms).
 * Absolute li+jalr (flash<->IRAM out of JAL range); the 32B original is
 * overwritten inline (jump + nops).
 */
function alarmNowPark(tickAddr) {
    const p = [
        { op: 'addi', rd: SP, rs1: SP, imm: -16 },
        { op: 'sw', rs2: 1, rs1: SP, imm: 12 },
        ...li(T1, tickAddr),
        { op: 'jalr_ra', rs1: T1 }, // a0 = xTaskGetTickCount()
        { op: 'lw', rd: 1, rs1: SP, imm: 12 },
        { op: 'addi', rd: SP, rs1: SP, imm: 16 },
        { op: 'ret' }, // return ticks in a0
    ];
    return asm32(assemble(p));
}

export function prepareThreadShims(elf, chip) {
    const shims = {};
    const extra = [];
    const { found } = elf.resolve(THREAD_HOOKS);
    // Silent when the firmware has no 15.4 stack at all (most suites);
    // warn per-symbol only on partial presence (shape change).
    if (!found.length) return { shims, extra, hooks: found };
    const byName = Object.fromEntries(found.map((s) => [s.name, s]));
    const inRange = (from, to) => to - from >= -(1 << 20) && to - from < (1 << 20);

    for (const n of ['esp_ieee802154_enable', 'esp_ieee802154_disable', 'otPlatRadioReceive']) {
        const sym = byName[n];
        if (!sym) console.warn(`[thread] skip ${n}: symbol missing`);
        else if (sym.size < 8) console.warn(`[thread] skip ${n}: func ${sym.size}B < 8B`);
        else shims[n] = ret0();
    }

    // Deferred energy completion: energy + getstate parks live in dead
    // mac_init. Idle delivery (deliverPark + copySub) lives in a dead LL
    // IRAM box (enh_ack_generator 436B, else receive_done 344B — pure RF
    // interrupt path, never called with the radio stubbed); the getstate
    // hop reaches it via absolute li+jalr. Each layer degrades
    // independently (no box → TX-driven delivery only, as before).
    const energySym = byName['otPlatRadioEnergyScan'];
    const energyDoneSym = byName['otPlatRadioEnergyScanDone'];
    const getstateSym = byName['otPlatRadioGetState'];
    const macSym = byName['ieee802154_mac_init'];
    const rxDoneSym0 = byName['otPlatRadioReceiveDone'];
    const mapped = (a) => elf.vaddrToFileOffset(a) !== null;
    let boxSym = null;
    if (energySym && energyDoneSym && getstateSym && macSym && rxDoneSym0) {
        try {
            const { found: boxFound } = elf.resolve(['esp_ieee802154_enh_ack_generator', 'esp_ieee802154_receive_done']);
            const boxByName = Object.fromEntries(boxFound.map((s) => [s.name, s]));
            boxSym = boxByName['esp_ieee802154_enh_ack_generator'] || boxByName['esp_ieee802154_receive_done'] || null;
        } catch (_) { boxSym = null; }
    }
    if (energySym && energyDoneSym && getstateSym && macSym) {
        const ePark = energyPark(flagAddrFor(chip));
        const cPark = copySub(slotAddrFor(chip), rxScratchFor(chip));
        let deliver = null;
        try {
            if (boxSym && rxDoneSym0) deliver = deliverPark(slotAddrFor(chip), rxDoneSym0.addr, rxScratchFor(chip));
        } catch (e) {
            console.warn(`[thread] delivery assemble failed (${e.message})`);
        }
        const boxOk = deliver && boxSym && deliver.length + cPark.length <= boxSym.size && mapped(boxSym.addr);
        // Alarm-Now park (ticks timebase for dead esp_timer alarms).
        const getNowSym = byName['otPlatAlarmMilliGetNow'];
        const tickSym = byName['xTaskGetTickCount'];
        let alarmNow = null;
        try {
            if (boxOk && getNowSym && tickSym) alarmNow = alarmNowPark(tickSym.addr);
        } catch (e) {
            console.warn(`[thread] alarm assemble failed (${e.message})`);
        }
        const copyAtBase = boxOk ? boxSym.addr + deliver.length : 0;
        const boxEnd = boxOk ? boxSym.addr + boxSym.size : 0;
        // Box cursor: [deliver][copy][alarmNow?][inbound2?] (each optional).
        let boxNext = boxOk ? copyAtBase + cPark.length : 0;
        const alarmAt = (alarmNow && boxNext + alarmNow.length <= boxEnd) ? boxNext : 0;
        if (alarmAt) boxNext = alarmAt + alarmNow.length;
        const alarmOk = alarmAt !== 0 && getNowSym.size >= 12;
        // Inbound2 park (MLE-TX entry, no beacon fallback) shares the box.
        let inbound2 = null;
        try {
            if (boxOk && rxDoneSym0) inbound2 = inbound2Park(slotAddrFor(chip), rxDoneSym0.addr, rxScratchFor(chip));
        } catch (e) {
            console.warn(`[thread] inbound2 assemble failed (${e.message})`);
        }
        const in2At = (inbound2 && boxNext + inbound2.length <= boxEnd) ? boxNext : 0;
        const gPark = getstatePark(flagAddrFor(chip), energyDoneSym.addr, slotAddrFor(chip), !!boxOk);
        const eAt = macSym.addr;
        const gAt = macSym.addr + ePark.length;
        const macNeed = ePark.length + gPark.length + (boxOk ? 0 : cPark.length);
        if (energySym.size >= 4 && getstateSym.size >= 4 &&
            eAt + macNeed <= macSym.addr + macSym.size &&
            inRange(energySym.addr, eAt) && inRange(getstateSym.addr, gAt)) {
            const deliveryAt = boxOk ? boxSym.addr : 0;
            const copyAt = boxOk ? deliveryAt + deliver.length : gAt + gPark.length;
            if (boxOk) {
                patchPairs(gPark, [[PH_DV0, PH_DV1, T5, deliveryAt]]);
                patchPairs(deliver, [[PH_CP0, PH_CP1, T5, copyAt]]);
            }
            extra.push({ addr: energySym.addr, bytes: makeJal(energySym.addr, eAt) });
            extra.push({ addr: eAt, bytes: ePark });
            extra.push({ addr: getstateSym.addr, bytes: makeJal(getstateSym.addr, gAt) });
            extra.push({ addr: gAt, bytes: gPark });
            if (boxOk) {
                extra.push({ addr: deliveryAt, bytes: deliver });
                extra.push({ addr: copyAt, bytes: cPark });
                if (alarmOk) {
                    extra.push({ addr: alarmAt, bytes: alarmNow });
                    // Inline hook: li t0, alarmAt + jalr x0, t0 + nops.
                    const jump = [
                        ...li(T0, alarmAt),
                        { op: 'jalr', rd: 0, rs1: T0, imm: 0 },
                    ];
                    const jumpBytes = Array.from(asm32(assemble(jump)));
                    while (jumpBytes.length + 4 <= getNowSym.size) jumpBytes.push(0x13, 0x00, 0x00, 0x00);
                    extra.push({ addr: getNowSym.addr, bytes: new Uint8Array(jumpBytes.slice(0, getNowSym.size)) });
                } else if (alarmNow) {
                    console.warn('[thread] skip alarm-now hook (fit)');
                }
                if (in2At) {
                    patchPairs(inbound2, [[PH_CP0, PH_CP1, T5, copyAt]]);
                    extra.push({ addr: in2At, bytes: inbound2 });
                } else if (inbound2) {
                    console.warn('[thread] skip inbound2 (fit; MLE TX uses scan path)');
                }
            } else {
                if (deliver) console.warn('[thread] skip idle delivery (no dead-box fit; TX-driven only)');
                extra.push({ addr: copyAt, bytes: cPark });
            }
            macSym.copyAt = copyAt;
            macSym.inbound2At = in2At || 0;
        } else {
            console.warn(`[thread] skip energy parks (fit: mac ${macSym.size}B need ${macNeed}B)`);
        }
    } else {
        const missing = ['otPlatRadioEnergyScan', 'otPlatRadioEnergyScanDone', 'otPlatRadioGetState', 'ieee802154_mac_init']
            .filter((n) => !byName[n]);
        if (missing.length) console.warn(`[thread] skip energy parks: missing ${missing.join(',')}`);
    }

    // Transmit main shim at +90 (serves both entries) + inbound/beacon
    // layer in the reclaimed boxes. Each layer degrades independently.
    // Cross-region links (flash<->IRAM, ~24MB) use absolute li+jalr — never
    // JAL. txMain always jumps post-TX to the inbound park; the inbound
    // park falls through to the beacon park when the slot is empty.
    const txSym = byName['otPlatRadioTransmit'];
    const doneSym = byName['otPlatRadioTxDone'];
    const rxDoneSym = byName['otPlatRadioReceiveDone'];
    const tParkSym = byName['ieee802154_transmit'];
    const tPark2Sym = byName['ieee802154_transmit_at'];
    if (txSym && doneSym) {
        let txMain;
        try {
            txMain = asm32(assemble(txMainProg()));
        } catch (e) {
            console.warn(`[thread] skip otPlatRadioTransmit: assemble failed (${e.message})`);
        }
        const mainAt = txSym.addr + TX_MAIN_OFF;
        const mapped = (a) => elf.vaddrToFileOffset(a) !== null;
        if (txMain && txSym.size >= TX_MAIN_OFF + 4 && TX_MAIN_OFF + txMain.length <= txSym.size) {
            // Emit leaf + inbound park share the transmit box; the beacon
            // park lives in the transmit_at box. Assemble all three first
            // (inbound's beacon fallback needs beaconAt), then place.
            let emitAt = 0, inboundAt = 0, beaconAt = 0;
            let emit = null, inbound = null, beacon = null;
            try {
                if (tParkSym) emit = emitSub();
                if (rxDoneSym) {
                    inbound = inboundPark(slotAddrFor(chip), rxDoneSym.addr, rxScratchFor(chip));
                    beacon = tPark2Sym ? beaconPark(rxScratchFor(chip), rxDoneSym.addr) : null;
                }
            } catch (e) {
                console.warn(`[thread] shim assemble failed (${e.message})`);
            }
            const emitOk = emit && tParkSym && emit.length <= tParkSym.size && mapped(tParkSym.addr);
            const inOk = inbound && emitOk && emit.length + inbound.length <= tParkSym.size;
            const bcOk = beacon && tPark2Sym && beacon.length <= tPark2Sym.size && mapped(tPark2Sym.addr);
            const copyAt = (macSym && macSym.copyAt) || 0;
            if (!emitOk) console.warn(`[thread] skip emit park (fit: box ${tParkSym ? tParkSym.size : 0}B)`);
            if (inOk && !bcOk) console.warn('[thread] skip inbound park: no beacon fallback');
            if (emitOk && inOk && bcOk && copyAt) {
                emitAt = tParkSym.addr;
                inboundAt = tParkSym.addr + emit.length;
                beaconAt = tPark2Sym.addr;
                patchPairs(inbound, [
                    [PH_BC0, PH_BC1, T5, beaconAt],
                    [PH_CP0, PH_CP1, T5, copyAt],
                ]);
                extra.push({ addr: emitAt, bytes: emit });
                extra.push({ addr: inboundAt, bytes: inbound });
                extra.push({ addr: beaconAt, bytes: beacon });
            } else if (emitOk && bcOk) {
                // 1c fallback: inbound unavailable, txMain jumps straight to
                // the fabricated beacon park.
                console.warn('[thread] inbound layer skipped (fabricated beacons only)');
                emitAt = tParkSym.addr;
                beaconAt = tPark2Sym.addr;
                extra.push({ addr: emitAt, bytes: emit });
                extra.push({ addr: beaconAt, bytes: beacon });
            } else {
                console.warn('[thread] inbound/beacon layer skipped (plain emit + TxDone fallback)');
            }
            try {
                // MLE path target: inbound2 (no beacon) if placed, else
                // fall back to the scan path (wedge risk, documented).
                const mleAt = (macSym && macSym.inbound2At) || inboundAt || beaconAt;
                if (emitAt && inboundAt && beaconAt) {
                    patchPairs(txMain, [
                        [PH_EL0, PH_EL1, T5, emitAt],
                        [PH_DL0, PH_DL1, T1, doneSym.addr],
                        [PH_IN0, PH_IN1, T5, inboundAt],
                        [PH_J0, PH_J1, T5, mleAt],
                    ]);
                } else if (emitAt && beaconAt) {
                    patchPairs(txMain, [
                        [PH_EL0, PH_EL1, T5, emitAt],
                        [PH_DL0, PH_DL1, T1, doneSym.addr],
                        [PH_IN0, PH_IN1, T5, beaconAt],
                        [PH_J0, PH_J1, T5, mleAt],
                    ]);
                } else {
                    // No beacon: replace the detect+jump with straight fallthrough.
                    // (Simplest correct degradation: plain emit + TxDone.)
                    txMain = txMainPlain(doneSym.addr);
                    if (TX_MAIN_OFF + txMain.length > txSym.size) {
                        throw new Error('plain shim does not fit');
                    }
                }
                extra.push({ addr: txSym.addr, bytes: makeJal(txSym.addr, mainAt) });
                extra.push({ addr: mainAt, bytes: txMain });
            } catch (e) {
                console.warn(`[thread] skip otPlatRadioTransmit: ${e.message}`);
            }
        } else if (txMain) {
            console.warn(`[thread] skip otPlatRadioTransmit (fit: func ${txSym.size}B main ${txMain.length}B @+${TX_MAIN_OFF})`);
        }
    } else {
        console.warn('[thread] skip otPlatRadioTransmit: symbol missing');
    }
    return { shims, extra, hooks: found };
}

/**
 * Degraded Transmit shim (no beacon layer): emit + TxDone only. Same entry
 * layout (at Transmit+90, `j` at +0); assembled standalone, no patching.
 */
function txMainPlain(txDoneAddr) {
    const p = [
        { op: 'addi', rd: SP, rs1: SP, imm: -16 },
        { op: 'sw', rs2: 1, rs1: SP, imm: 12 },
        { op: 'lui', rd: T0, imm: UART_BASE_DEFAULT },
        { op: 'addi', rd: T2, rs1: 0, imm: 27 }, { op: 'sw', rs2: T2, rs1: T0, imm: 0 },
        { op: 'addi', rd: T2, rs1: 0, imm: 95 }, { op: 'sw', rs2: T2, rs1: T0, imm: 0 },
        { op: 'addi', rd: T2, rs1: 0, imm: 71 }, { op: 'sw', rs2: T2, rs1: T0, imm: 0 },
        { op: 'lbu', rd: T1, rs1: A1, imm: 6 }, { op: 'sw', rs2: T1, rs1: T0, imm: 0 },
        { op: 'lbu', rd: T4, rs1: A1, imm: 4 },
        { op: 'andi', rd: T4, rs1: T4, imm: PSDU_CAP },
        { op: 'sw', rs2: T4, rs1: T0, imm: 0 },
        { op: 'lw', rd: T3, rs1: A1, imm: 0 },
        { label: 'pl_psdu' },
        { op: 'beq', rs1: T4, rs2: 0, label: 'pl_done' },
        { op: 'lbu', rd: T1, rs1: T3, imm: 0 },
        { op: 'srli', rd: T2, rs1: T1, sh: 4 }, { op: 'addi', rd: T2, rs1: T2, imm: 97 }, { op: 'sw', rs2: T2, rs1: T0, imm: 0 },
        { op: 'andi', rd: T2, rs1: T1, imm: 15 }, { op: 'addi', rd: T2, rs1: T2, imm: 97 }, { op: 'sw', rs2: T2, rs1: T0, imm: 0 },
        { op: 'addi', rd: T3, rs1: T3, imm: 1 },
        { op: 'addi', rd: T4, rs1: T4, imm: -1 },
        { op: 'jal', rd: 0, label: 'pl_psdu' },
        { label: 'pl_done' },
        { op: 'addi', rd: T2, rs1: 0, imm: 27 }, { op: 'sw', rs2: T2, rs1: T0, imm: 0 },
        { op: 'addi', rd: T2, rs1: 0, imm: 92 }, { op: 'sw', rs2: T2, rs1: T0, imm: 0 },
        { op: 'addi', rd: A2, rs1: 0, imm: 0 },
        { op: 'addi', rd: A3, rs1: 0, imm: 0 },
        ...li(T1, txDoneAddr),
        { op: 'jalr_ra', rs1: T1 },
        { op: 'lw', rd: 1, rs1: SP, imm: 12 },
        { op: 'addi', rd: SP, rs1: SP, imm: 16 },
        { op: 'addi', rd: A0, rs1: 0, imm: 0 },
        { op: 'ret' },
    ];
    return asm32(assemble(p));
}
