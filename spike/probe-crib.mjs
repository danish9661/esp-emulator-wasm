import { readFileSync } from 'node:fs';
import { createHmac, createCipheriv } from 'node:crypto';

const master = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
function mleKey(seq) {
    const h = createHmac('sha256', master);
    const sb = Buffer.alloc(4);
    sb.writeUInt32BE(seq);
    h.update(sb);
    h.update(Buffer.from('Thread', 'ascii'));
    return h.digest().slice(0, 16);
}
function aesEcb(key, block16) {
    const c = createCipheriv('aes-128-ecb', key, null);
    c.setAutoPadding(false);
    return Buffer.concat([c.update(block16), c.final()]);
}
const frame = readFileSync(process.env.F || '/tmp/mle63.bin');
const srcExt = frame.slice(7, 15);
const mle = frame.slice(25);
const keySeq = mle.readUInt32BE(6);
const enc = mle.slice(11, mle.length - 4);
const key = mleKey(keySeq);

function iid(ext, flip) {
    const b = Buffer.from(ext);
    if (flip) b[0] ^= 0x02;
    return b;
}
const rev = (b) => Buffer.from(b).reverse();
const extForms = [
    ['iidFlip', iid(srcExt, true)],
    ['macRaw', Buffer.from(srcExt)],
    ['iidFlipRev', rev(iid(srcExt, true))],
    ['macRawRev', rev(Buffer.from(srcExt))],
];
// CTR keystream: S_i = AES(key, 0x01 || nonce13 || BE16(i)), i = 1,2,...
function keystream(key, nonce13, nbytes) {
    let out = Buffer.alloc(0);
    let ctr = 1;
    while (out.length < nbytes) {
        const blk = Buffer.alloc(16);
        blk[0] = 0x01;
        nonce13.copy(blk, 1);
        blk.writeUInt16BE(ctr, 14);
        out = Buffer.concat([out, aesEcb(key, blk)]);
        ctr++;
    }
    return out.slice(0, nbytes);
}
const want = Buffer.from([0x09, 0x01, 0x01, 0x0f]);
let tried = 0;
for (const [ename, ext] of extForms) {
    for (let level = 0; level < 8; level++) {
        const nonce = Buffer.alloc(13);
        ext.copy(nonce, 0);
        nonce.writeUInt32LE(0, 8);
        nonce[12] = level;
        for (const ctrBE of [false, true]) {
            // counter byte order only matters if nonzero; counter is 0 here
            const ks = keystream(key, nonce, enc.length);
            const pt = Buffer.from(enc.map((b, i) => b ^ ks[i]));
            tried++;
            if (pt[0] === 0x09 && pt[1] === 0x01 && pt[2] === 0x01 && (pt[3] & 0x0f) === 0x0f) {
                console.log(`HIT ext=${ename} level=${level} ctrBE=${ctrBE}`);
                console.log('pt=' + pt.toString('hex'));
                // TLV walk
                let q = 1;
                const parts = [];
                while (q + 2 <= pt.length) {
                    const t = pt[q], l = pt[q + 1];
                    parts.push(`T${t}[${l}]=${pt.slice(q + 2, q + 2 + l).toString('hex')}`);
                    q += 2 + l;
                    if (q > pt.length) break;
                }
                console.log(parts.join(' '));
                process.exit(0);
            }
        }
    }
}
console.log(`no crib hit after ${tried} tries`);
// debug: show pt under most-likely (iidFlip, level 5)
const nonce = Buffer.alloc(13);
iid(srcExt, true).copy(nonce, 0);
nonce.writeUInt32LE(0, 8);
nonce[12] = 5;
const ks = keystream(key, nonce, enc.length);
console.log('pt(iidFlip,5)=' + Buffer.from(enc.map((b, i) => b ^ ks[i])).toString('hex'));
