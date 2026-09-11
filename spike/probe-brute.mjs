import { readFileSync } from 'node:fs';
import { createHmac, createDecipheriv } from 'node:crypto';

const master = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
function kdf(seq) {
    const h = createHmac('sha256', master);
    const sb = Buffer.alloc(4);
    sb.writeUInt32BE(seq);
    h.update(sb);
    h.update(Buffer.from('Thread', 'ascii'));
    return h.digest(); // 32B; try both halves as key
}
const frame = readFileSync('/tmp/mle63.bin');
const srcExt = frame.slice(7, 15);
const mle = frame.slice(25);
const keySeq = mle.readUInt32BE(6);
const secHdr = mle.slice(1, 11);
const hash = kdf(keySeq);

function iid(ext, flip) {
    const b = Buffer.from(ext);
    if (flip) b[0] ^= 0x02;
    return b;
}
const ll = Buffer.from('fe80000000000000', 'hex');
const mc = (scope) => Buffer.concat([Buffer.from([0xff, scope]), Buffer.alloc(13), Buffer.from([2])]);
const rev = (b) => Buffer.from(b).reverse();

const aadForms = (sender, receiver) => [
    ['s+r+sec', Buffer.concat([sender, receiver, secHdr])],
    ['sec', secHdr],
    ['empty', Buffer.alloc(0)],
    ['s+r', Buffer.concat([sender, receiver])],
];
const extForms = [
    ['iidFlip', iid(srcExt, true)],
    ['macRaw', Buffer.from(srcExt)],
    ['iidFlipRev', rev(iid(srcExt, true))],
    ['zeros', Buffer.alloc(8)],
];

let tried = 0;
for (const tagLen of [4, 8, 16]) {
    if (11 + 1 + tagLen > mle.length) continue;
    const enc = mle.slice(11, mle.length - tagLen);
    const tag = mle.slice(mle.length - tagLen);
    for (const half of [0, 1]) {
        const key = hash.slice(half * 16, half * 16 + 16);
        for (const flip of [true, false]) {
            for (const scope of [2, 3]) {
                const sender = Buffer.concat([ll, iid(srcExt, flip)]);
                const receiver = mc(scope);
                for (const [aname, aad] of aadForms(sender, receiver)) {
                    for (const [ename, ext] of extForms) {
                        for (let level = 0; level < 8; level++) {
                            const nonce = Buffer.alloc(13);
                            ext.copy(nonce, 0);
                            nonce.writeUInt32LE(0, 8);
                            nonce[12] = level;
                            tried++;
                            try {
                                const d = createDecipheriv('aes-128-ccm', key, nonce, { authTagLength: tagLen });
                                d.setAAD(aad, { plaintextLength: enc.length });
                                d.setAuthTag(tag);
                                const pt = Buffer.concat([d.update(enc), d.final()]);
                                console.log(`HIT tag=${tagLen} half=${half} flip=${flip} scope=${scope} aad=${aname} ext=${ename} level=${level}`);
                                console.log('pt=' + pt.toString('hex'));
                                process.exit(0);
                            } catch (_) {}
                        }
                    }
                }
            }
        }
    }
}
console.log(`no hit after ${tried} tries`);
