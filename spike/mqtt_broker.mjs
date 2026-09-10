// Minimal MQTT broker for testing: CONNACK + SUBACK, echoes PUBLISH back
// to the subscriber. No auth, no persistence, single client at a time.
// Usage: node spike/mqtt_broker.mjs [port]   (default 1884)
import net from 'node:net';

const PORT = +(process.argv[2] || 1884);

function encRemaining(n) {
    const out = [];
    do {
        let b = n % 128;
        n = Math.floor(n / 128);
        if (n > 0) b |= 0x80;
        out.push(b);
    } while (n > 0);
    return Buffer.from(out);
}

const server = net.createServer((sock) => {
    console.log('broker: client connected');
    let buf = Buffer.alloc(0);
    let subscribed = null;
    sock.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        while (buf.length >= 2) {
            const type = buf[0] >> 4;
            let mult = 1, len = 0, pos = 1, b;
            do {
                if (pos >= buf.length) return;
                b = buf[pos++];
                len += (b & 127) * mult;
                mult *= 128;
            } while (b & 128);
            if (buf.length < pos + len) return;
            const payload = buf.slice(pos, pos + len);
            buf = buf.slice(pos + len);
            if (type === 1) { // CONNECT
                console.log('broker: CONNECT -> CONNACK');
                sock.write(Buffer.from([0x20, 0x02, 0x00, 0x00]));
            } else if (type === 8) { // SUBSCRIBE
                const pid = payload.readUInt16BE(0);
                console.log('broker: SUBSCRIBE -> SUBACK id=' + pid);
                sock.write(Buffer.concat([Buffer.from([0x90, 0x03]), payload.slice(0, 2), Buffer.from([0x00])]));
                let ti = 2;
                while (ti + 2 <= payload.length) {
                    const tlen = payload.readUInt16BE(ti);
                    subscribed = payload.slice(ti + 2, ti + 2 + tlen).toString();
                    ti += 2 + tlen + 1;
                }
                console.log('broker: subscribed=' + subscribed);
            } else if (type === 3) { // PUBLISH
                const tlen = payload.readUInt16BE(0);
                const topic = payload.slice(2, 2 + tlen).toString();
                const msg = payload.slice(2 + tlen);
                console.log(`broker: PUBLISH ${topic} len=${msg.length}`);
                if (subscribed) {
                    const t = Buffer.from(subscribed);
                    const body = Buffer.concat([Buffer.from([(t.length >> 8) & 0xff, t.length & 0xff]), t, msg]);
                    sock.write(Buffer.concat([Buffer.from([0x30]), encRemaining(body.length), body]));
                    console.log('broker: echoed back');
                }
            } else if (type === 12) { // PINGREQ
                sock.write(Buffer.from([0xd0, 0x00]));
            } else if (type === 14) { // DISCONNECT
                sock.end();
            }
        }
    });
    sock.on('error', () => {});
});

server.listen(PORT, '0.0.0.0', () => console.log('broker: listening on ' + PORT));
