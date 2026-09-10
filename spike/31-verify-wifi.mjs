// WiFi end-to-end via the OpenHW gateway (gVisor NAT): DHCP + HTTP GET
// from real internet, driven headlessly over WebSocket.
// Needs the gateway on ws://127.0.0.1:5099 (openhw-studio-gateway) and
// internet egress; otherwise prints SKIP (exit 0) instead of failing.
// Run: node spike/31-verify-wifi.mjs
//   GW_URL=ws://host:port/api/network-gateway node spike/31-verify-wifi.mjs
import { readFileSync } from 'node:fs';
import { ESP32C3 } from '../index.mjs';

const GW_URL = process.env.GW_URL || 'ws://127.0.0.1:5099/api/network-gateway';

function skipWhy(msg) {
    console.log(`WiFi E2E: SKIP (${msg})`);
}

try {
    // Internet egress through gVisor is timing-sensitive (ARP/ND races,
    // upstream route flaps); retry the whole flow like the C6 multi-instance
    // precedent instead of failing loudly on a flakes.
    let attempt = 0, pass = false, lastLog = '';
    while (attempt < 3 && !pass) {
        attempt++;
        if (attempt > 1) console.log(`retry WiFi E2E (attempt ${attempt})...`);
        ({ pass, lastLog } = await wifiAttempt());
    }
    if (!pass) {
        console.log('WiFi E2E: FAIL ❌');
        console.log(lastLog);
        process.exit(1);
    }
    console.log('WiFi E2E: PASS ✅ (DHCP + HTTP 200 via gateway)');
} catch (e) {
    console.log('WiFi E2E: FAIL ❌ (' + String(e && e.message || e).slice(0, 120) + ')');
    process.exit(1);
}

async function wifiAttempt() {
    const mcu = await ESP32C3.create({ chip: 'esp32c3' });
    await mcu.loadFirmware(
        new Uint8Array(readFileSync('samples/wifidemo.merged.bin')),
        new Uint8Array(readFileSync('samples/wifidemo.elf')));
    mcu.emu.set_wifi_config('testssid', 'testpass');

    const ws = new WebSocket(GW_URL);
    ws.binaryType = 'arraybuffer';
    const rxq = [];
    try {
        await new Promise((res, rej) => {
            ws.onopen = res;
            ws.onerror = () => rej(new Error('ws open failed'));
            setTimeout(() => rej(new Error('ws open timeout')), 8000);
        });
    } catch (e) {
        skipWhy('no gateway at ' + GW_URL + ' — start openhw-studio-gateway first');
        ws.close();
        process.exit(0);
    }
    ws.onmessage = (e) => { if (e.data instanceof ArrayBuffer) rxq.push(new Uint8Array(e.data)); };

    // Pump frames; yield to the event loop regularly or WS messages never
    // dispatch (single-threaded Node) and the gateway looks dead.
    const tick = () => new Promise((r) => setImmediate(r));
    let live = '';
    mcu.uart0.onData((t) => { live += t; });
    const checks = [];
    const sendFrame = (fr) => { if (ws.readyState === 1) ws.send(fr.buffer.slice(fr.byteOffset, fr.byteOffset + fr.byteLength)); };
    for (let i = 0; i < 15000 && !/wifi-done|wifi-connect FAIL/.test(live); i++) {
        while (rxq.length) {
            const f = rxq.shift();
            try { mcu.emu.wifi_rx_push(f); } catch (_) { break; }
        }
        mcu.step(100000);
        try {
            const buf = mcu.emu.wifi_tx_drain();
            if (buf && buf.length > 0) {
                let off = 0;
                while (off + 4 <= buf.length) {
                    const len = buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24);
                    off += 4;
                    if (off + len > buf.length) break;
                    sendFrame(new Uint8Array(buf.buffer.slice(buf.byteOffset + off, buf.byteOffset + off + len)));
                    off += len;
                }
            }
        } catch (_) { break; }
        if (i % 500 === 499) await tick();
    }
    ws.close();
    const has = (re) => re.test(live);
    const ip = live.match(/wifi-ip=(\S+)/);
    const code = live.match(/http-code=(-?\d+)/);
    const len = live.match(/http-len=(\d+)/);
    console.log(`DHCP ip=${ip ? ip[1] : '(none)'}, HTTP code=${code ? code[1] : '(none)'} len=${len ? len[1] : '(none)'}`);
    checks.push(ip && ip[1].startsWith('192.168.4.'));
    checks.push(code && +code[1] === 200);
    checks.push(len && +len[1] > 100);
    checks.push(has(/Example Domain/));
    if (!checks.every(Boolean)) {
        return { pass: false, lastLog: live.split('\r\n').filter((l) => /wifi|http|IP|FAIL/i.test(l)).join('\n') };
    }
    return { pass: true, lastLog: '' };
}
