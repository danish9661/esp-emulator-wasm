import { readFileSync } from 'node:fs';
import { createHmac, createDecipheriv } from 'node:crypto';

const master = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
function mleKey(seq) {
    const h = createHmac('sha256', master);
    const sb = Buffer.alloc(4);
    sb.writeUInt32BE(seq);
    h.update(sb);
    h.update(Buffer.from('Thread', 'ascii'));
    return h.digest().slice(0, 16);
}
console.log('mleKey(1)=' + mleKey(1).toString('hex'));

const frame = readFileSync('/tmp/h2_ad.bin'); // H2 MLE ad, 69B
console.log('frame=' + frame.toString('hex'));
// MHR 15B: fcf(2) seq(1) dstpan(2) dstshort(2) srcext(8)
const srcExt = frame.slice(7, 15);
console.log('srcExt=' + srcExt.toString('hex'));
// 6LoWPAN 10B @15..24 (verify): 7f 3b 02 f0 4d4c 4d4c cksum(2)
console.log('6lowpan=' + frame.slice(15, 25).toString('hex'));
// MLE @25: suite(1) secCtl(1) counter(4LE) keySrc(4BE) keyIdx(1) enc... mic(4)
const mle = frame.slice(25);
console.log('suite=0x' + mle[0].toString(16) + ' secCtl=0x' + mle[1].toString(16));
const counter = mle.readUInt32LE(2);
const keySeq = mle.readUInt32BE(6);
console.log(`counter=${counter} keySeq=${keySeq} keyIdx=0x${mle[10].toString(16)}`);
const secHdr = mle.slice(1, 11); // 10B for AAD
const enc = mle.slice(11, mle.length - 4);
const tag = mle.slice(mle.length - 4);
console.log(`enc(${enc.length}B)=` + enc.toString('hex'));
console.log('tag=' + tag.toString('hex'));

// IPv6 addrs: sender link-local from EUI (flip U/L), receiver ff02::2
function iidFromExt(ext) {
    const iid = Buffer.from(ext);
    iid[0] ^= 0x02;
    return iid;
}
const sender = Buffer.concat([Buffer.from('fe80000000000000', 'hex'), iidFromExt(srcExt)]);
const dstByte = frame[17];
const receiver = Buffer.concat([Buffer.from([0xff, 0x02]), Buffer.alloc(13), Buffer.from([dstByte])]);
console.log('dstByte=0x' + dstByte.toString(16));
console.log('sender=' + sender.toString('hex'));
const aad = Buffer.concat([sender, receiver, secHdr]);
console.log(`aad(${aad.length}B)=` + aad.toString('hex'));

const key = mleKey(keySeq);
console.log('mleKey(seq)=' + key.toString('hex'));
// Nonce ext is IID-derived (SetFromIid): flip U/L like the IPv6 IID.
const nonceExt = iidFromExt(srcExt);
console.log('nonceExt=' + nonceExt.toString('hex'));
for (const level of [5, 1]) {
    for (const ctrBE of [false, true]) {
        const nonce = Buffer.alloc(13);
        nonceExt.copy(nonce, 0);
        if (ctrBE) nonce.writeUInt32BE(counter, 8);
        else nonce.writeUInt32LE(counter, 8);
        nonce[12] = level;
        try {
            const d = createDecipheriv('aes-128-ccm', key, nonce, { authTagLength: 4 });
            d.setAAD(aad, { plaintextLength: enc.length });
            d.setAuthTag(tag);
            const pt = Buffer.concat([d.update(enc), d.final()]);
            console.log(`LEVEL=${level} ctrBE=${ctrBE}: AUTH OK`);
            console.log('pt=' + pt.toString('hex'));
            // TLV walk: cmd + TLVs
            console.log('cmd=0x' + pt[0].toString(16));
            let q = 1;
            const parts = [];
            while (q + 2 <= pt.length) {
                const t = pt[q], l = pt[q + 1];
                parts.push(`T${t}[${l}]=${pt.slice(q + 2, q + 2 + l).toString('hex')}`);
                q += 2 + l;
            }
            console.log(parts.join(' '));
            console.log('end-aligned=' + (q === pt.length));
        } catch (e) {
            console.log(`LEVEL=${level} ctrBE=${ctrBE}: fail (${e.message})`);
        }
    }
}
