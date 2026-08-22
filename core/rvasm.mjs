// Minimal RV32I assembler for generating firmware shims (mirrors spike/mkimg.py).
// Used by the BLE interception shims; all instructions are standard RV32I base ISA
// so the same bytecode runs on C3/C6/H2/P4.

export const T0 = 5, T1 = 6, T2 = 7, T3 = 28, T4 = 29, T5 = 30;
export const A0 = 10, A1 = 11, A2 = 12, A3 = 13, A4 = 14, A5 = 15, A6 = 16, A7 = 17;
export const S0 = 8, S1 = 9;
export const SP = 2, RA = 1, ZERO = 0;

export function lui(rd, imm20) { return ((imm20 & 0xFFFFF) << 12) | (rd << 7) | 0x37; }
export function addi(rd, rs1, imm) { return ((imm & 0xFFF) << 20) | (rs1 << 15) | (rd << 7) | 0x13; }
export function sw(rs2, rs1, imm) {
  const i = imm & 0xFFF;
  return ((i >> 5) << 25) | (rs2 << 20) | (rs1 << 15) | (2 << 12) | ((i & 0x1F) << 7) | 0x23;
}
export function lw(rd, rs1, imm) {
  return ((imm & 0xFFF) << 20) | (rs1 << 15) | (2 << 12) | (rd << 7) | 0x03;
}
export function sb(rs2, rs1, imm) {
  const i = imm & 0xFFF;
  return ((i >> 5) << 25) | (rs2 << 20) | (rs1 << 15) | (0 << 12) | ((i & 0x1F) << 7) | 0x23;
}
export function lbu(rd, rs1, imm) {
  return ((imm & 0xFFF) << 20) | (rs1 << 15) | (4 << 12) | (rd << 7) | 0x03;
}
export function andi(rd, rs1, imm) { return ((imm) << 20) | (rs1 << 15) | (7 << 12) | (rd << 7) | 0x13; }
export function srli(rd, rs1, sh) { return ((sh & 0x1F) << 20) | (rs1 << 15) | (5 << 12) | (rd << 7) | 0x13; }
export function slli(rd, rs1, sh) { return ((sh & 0x1F) << 20) | (rs1 << 15) | (1 << 12) | (rd << 7) | 0x13; }
export function beq(rs1, rs2, off) {
  const o = off & 0x1FFF;
  return (((o >> 12) & 1) << 31) | (((o >> 5) & 0x3F) << 25) | (rs2 << 20) | (rs1 << 15) |
    (0 << 12) | (((o >> 1) & 0xF) << 8) | (((o >> 11) & 1) << 7) | 0x63;
}
export function bne(rs1, rs2, off) {
  const o = off & 0x1FFF;
  return (((o >> 12) & 1) << 31) | (((o >> 5) & 0x3F) << 25) | (rs2 << 20) | (rs1 << 15) |
    (1 << 12) | (((o >> 1) & 0xF) << 8) | (((o >> 11) & 1) << 7) | 0x63;
}
export function bge(rs1, rs2, off) {
  const o = off & 0x1FFF;
  return (((o >> 12) & 1) << 31) | (((o >> 5) & 0x3F) << 25) | (rs2 << 20) | (rs1 << 15) |
    (5 << 12) | (((o >> 1) & 0xF) << 8) | (((o >> 11) & 1) << 7) | 0x63;
}
export function add(rd, rs1, rs2) {
  return (rs2 << 20) | (rs1 << 15) | (0 << 12) | (rd << 7) | 0x33;
}
export function or(rd, rs1, rs2) {
  return (rs2 << 20) | (rs1 << 15) | (6 << 12) | (rd << 7) | 0x33;
}
export function lb(rd, rs1, imm) {
  return ((imm & 0xFFF) << 20) | (rs1 << 15) | (0 << 12) | (rd << 7) | 0x03;
}
export function jal(rd, off) {
  const o = off & 0x1FFFFF;
  const imm = (((o >> 20) & 1) << 31) | (((o >> 1) & 0x3FF) << 21) |
    (((o >> 11) & 1) << 20) | (((o >> 12) & 0xFF) << 12);
  return imm | (rd << 7) | 0x6F;
}
// jalr x1, rs1, 0  -> return (matches mkimg._ret)
export function ret() { return (1 << 15) | 0x67; }
// call: jalr x1, rs1, 0  (rs1 holds target address, ra preserved in caller's frame)
export function jalr_ra(rs1) { return (rs1 << 15) | (1 << 7) | 0x67; }
// generic jalr: jalr rd, rs1, imm  (rd = return address, imm 12-bit signed)
export function jalr(rd, rs1, imm) {
  return ((imm & 0x1F) << 20) | (rs1 << 15) | (rd << 7) | 0x67;
}

/** Load a 32-bit immediate into rd via lui+addi (matches mkimg.li). */
export function li(rd, val) {
  const hi = (val + 0x800) >> 12;
  const lo = val - (hi << 12);
  return [lui(rd, hi & 0xFFFFF), addi(rd, rd, lo)];
}

/** Assemble an instruction list into a little-endian Uint8Array. */
export function asm32(insns) {
  const words = insns.flat();
  const out = new Uint8Array(words.length * 4);
  words.forEach((w, i) => {
    out[i * 4] = w & 0xff;
    out[i * 4 + 1] = (w >> 8) & 0xff;
    out[i * 4 + 2] = (w >> 16) & 0xff;
    out[i * 4 + 3] = (w >> 24) & 0xff;
  });
  return out;
}

/**
 * Two-pass assembler with label support.
 * `prog` is a flat list where each element is either:
 *   - a pre-encoded 32-bit word (number)
 *   - { label: 'name' }                      (label anchored to the NEXT instruction)
 *   - { op: 'addi', rd, rs1, imm } etc.
 * Branch/jump instructions reference labels via { op:'beq', rs1, rs2, label:'L' }
 * or { op:'jal', rd, label:'L' }.
 */
export function assemble(prog) {
  const labels = {};
  const insns = [];
  let idx = 0;
  for (const t of prog) {
    if (typeof t === 'number') { insns.push(t); idx++; continue; }
    if (t.label !== undefined && Object.keys(t).length === 1) { labels[t.label] = idx; continue; }
    insns.push(t); idx++;
  }
  return insns.map((ins, i) => {
    if (typeof ins === 'number') return ins;
    const o = { ...ins };
    if (o.label !== undefined) { o.off = (labels[o.label] - i) * 4; delete o.label; }
    return encode(o);
  });
}

function encode(o) {
  switch (o.op) {
    case 'raw': return o.w;
    case 'lui': return lui(o.rd, (o.imm >>> 12) & 0xFFFFF);
    case 'addi': return addi(o.rd, o.rs1, o.imm);
    case 'add': return add(o.rd, o.rs1, o.rs2);
    case 'or': return or(o.rd, o.rs1, o.rs2);
    case 'andi': return andi(o.rd, o.rs1, o.imm);
    case 'srli': return srli(o.rd, o.rs1, o.sh);
    case 'slli': return slli(o.rd, o.rs1, o.sh);
    case 'sw': return sw(o.rs2, o.rs1, o.imm);
    case 'lw': return lw(o.rd, o.rs1, o.imm);
    case 'sb': return sb(o.rs2, o.rs1, o.imm);
    case 'lbu': return lbu(o.rd, o.rs1, o.imm);
    case 'lb': return lb(o.rd, o.rs1, o.imm);
    case 'beq': return beq(o.rs1, o.rs2, o.off);
    case 'bne': return bne(o.rs1, o.rs2, o.off);
    case 'bge': return bge(o.rs1, o.rs2, o.off);
    case 'jal': return jal(o.rd, o.off);
    case 'ret': return ret();
    case 'jalr_ra': return jalr_ra(o.rs1);
    case 'jalr': return jalr(o.rd, o.rs1, o.imm);
    default: throw new Error('unknown op ' + o.op);
  }
}
