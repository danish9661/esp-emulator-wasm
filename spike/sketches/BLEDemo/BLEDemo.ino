#include <NimBLEDevice.h>
#include <ctype.h>

static NimBLEServer*      pServer;
static NimBLECharacteristic* pChar;
static uint32_t           gNotifyCounter = 0;
static uint32_t           gLoopCount     = 0;
static uint32_t           gConnCount     = 0;

// ---- Server callbacks: connection lifecycle ----
class MyServerCallbacks : public NimBLEServerCallbacks {
    void onConnect(NimBLEServer* pServer, NimBLEConnInfo& connInfo) override {
        gConnCount++;
        Serial.printf("[BLE] connect peer=%s handle=%d\n",
                      connInfo.getAddress().toString().c_str(),
                      connInfo.getConnHandle());
    }
    void onDisconnect(NimBLEServer* pServer, NimBLEConnInfo& connInfo, int reason) override {
        Serial.printf("[BLE] disconnect peer=%s reason=0x%02x\n",
                      connInfo.getAddress().toString().c_str(), reason);
        if (gConnCount > 0) gConnCount--;
        // Restart advertising so the next peer can find us again.
        NimBLEDevice::startAdvertising();
    }
    void onMTUChange(uint16_t MTU, NimBLEConnInfo& connInfo) override {
        Serial.printf("[BLE] mtu-change peer=%s mtu=%d\n",
                      connInfo.getAddress().toString().c_str(), MTU);
    }
};

// ---- Characteristic callbacks: GATT read/write/notify ----
class MyCharCallbacks : public NimBLECharacteristicCallbacks {
    void onRead(NimBLECharacteristic* pCharacteristic, NimBLEConnInfo& connInfo) override {
        Serial.printf("[BLE] gatt-read peer=%s uuid=%s\n",
                      connInfo.getAddress().toString().c_str(),
                      pCharacteristic->getUUID().toString().c_str());
    }
    void onWrite(NimBLECharacteristic* pCharacteristic, NimBLEConnInfo& connInfo) override {
        std::string v = pCharacteristic->getValue();
        Serial.printf("[BLE] gatt-write peer=%s uuid=%s len=%d: ",
                      connInfo.getAddress().toString().c_str(),
                      pCharacteristic->getUUID().toString().c_str(), (int)v.length());
        for (uint8_t b : v) Serial.printf("%02x ", b);
        Serial.printf("\n");
    }
    void onSubscribe(NimBLECharacteristic* pCharacteristic, NimBLEConnInfo& connInfo, uint16_t subValue) override {
        Serial.printf("[BLE] gatt-subscribe peer=%s uuid=%s sub=0x%04x\n",
                      connInfo.getAddress().toString().c_str(),
                      pCharacteristic->getUUID().toString().c_str(), subValue);
    }
};

// ---- Test-only inbound packet fabrication (see loop()) ----
// ble_console_inject is a global stub so the sketch links on every chip.
// In-sim the emulator overwrites its prologue with a direct jump to the
// NimBLE host receive path (a local symbol the sketch cannot reference).
// On real hardware (or if unpatched) it returns -1 and prints a notice.
extern "C" int __attribute__((used, noinline, noipa)) ble_console_inject(int type, uint8_t* data) {
    (void)type; (void)data;
    Serial.println("[BLE] console-inject not patched (real HW?)");
    return -1;
}

static uint8_t  sEvtBuf[64];
static uint8_t  sAclBuf[64];
// Linker-placed emulator scratch for the LL-transport HCI path (mirror +
// static command slot + fake config, ~0x908 bytes at bleBase+0x400; see
// core/ble_shims.mjs). Fixed RAM addresses collide with the firmware heap
// once .bss grows (init stalled after AdvEnable #1 with +192B .bss), so the
// emulator prefers this symbol when present and falls back to the legacy
// fixed base otherwise. C linkage (unmangled: the emulator resolves the
// exact name) + global (visible: never GC'd/DSE'd); written by the host,
// never read by guest code except the retaining touch in setup().
extern "C" {
uint8_t ble_emu_scratch[2560];
}
static unsigned hexVal(char c) {
    if (c >= '0' && c <= '9') return (unsigned)(c - '0');
    if (c >= 'a' && c <= 'f') return (unsigned)(c - 'a' + 10);
    if (c >= 'A' && c <= 'F') return (unsigned)(c - 'A' + 10);
    return 0;
}

// HCI packet indicator values used by the LL transport glue.
#define HCI_EVT_IND 4
#define HCI_ACL_IND 2

// Inbound fabrication must hand the host REAL pool mbufs: the stack frees
// and parses them as mbufs, and a raw static buffer faults in
// r_os_mbuf_free. Only the LL-transport chips (C6/H2/C5 Arduino BLE) expose
// this path in-sim (the emulator jumps ble_console_inject into the local
// ble_transport_host_recv_cb); other chips print a notice.
struct os_mbuf;
extern "C" struct os_mbuf *ble_hs_mbuf_from_flat(const void *buf, uint16_t len);
extern "C" struct os_mbuf *ble_hs_mbuf_l2cap_pkt(void);
extern "C" struct os_mbuf *ble_hs_mbuf_acl_pkt(void);
extern "C" int r_os_mbuf_free_chain(struct os_mbuf *);

// Test-only introspection (global NimBLE symbols, verified via nm).
struct ble_hs_conn;
extern "C" struct ble_hs_conn *ble_hs_conn_find(uint16_t);
extern "C" int ble_gap_adv_active(void);

// Host mbuf pool for injection (the stubbed controller init never builds
// one, so from_flat/ATT responses would have nothing to allocate from).
// Uses the real NimBLE struct types (visible via NimBLEDevice.h); the arena
// is heap-malloc'd by r_mem_malloc_mbufpkt_pool itself (no .bss cost).
static struct os_mempool sInjMp;
static struct os_mbuf_pool sInjOmp;
static bool sInjPoolDone = false;

// Not exposed via NimBLEDevice.h (mem.h is internal); the r_ symbol is
// global in all LL images (verified via nm).
extern "C" int r_mem_malloc_mbufpkt_pool(struct os_mempool*, struct os_mbuf_pool*,
                                         int, int, char*, void**);
extern "C" int r_os_msys_num_free(void);

static void bleNetPoolInit(void) {
#if defined(CONFIG_IDF_TARGET_ESP32C6) || defined(CONFIG_IDF_TARGET_ESP32H2) || defined(CONFIG_IDF_TARGET_ESP32C5)
    if (sInjPoolDone) return;
    sInjPoolDone = true;
    void *buf = nullptr;
    // 32 blocks: ATT responses/requests are consumed+few-freed by the real
    // controller; margin for multi-step fabricated flows.
    int rc = r_mem_malloc_mbufpkt_pool(&sInjMp, &sInjOmp, 32, 160, (char*)"emu_inject", &buf);
    Serial.printf("[BLE] inj-pool rc=%d buf=%p\n", rc, buf);
    if (rc == 0) {
        // r__os_msys_find_pool only considers pools with mp_flags bit1
        // set for pkthdr allocations (get_pkthdr passes a1=1); the ROM pool
        // init sets it, os_mempool_init leaves flags=0.
        sInjMp.mp_flags |= 0x02;
        int rr = r_os_msys_register(&sInjOmp);
        Serial.printf("[BLE] inj-pool registered rr=%d\n", rr);
    }
#endif
}

static void bleInjectPacket(int type, uint8_t *flat, unsigned flatLen) {
#if defined(CONFIG_IDF_TARGET_ESP32C6) || defined(CONFIG_IDF_TARGET_ESP32H2) || defined(CONFIG_IDF_TARGET_ESP32C5)
    if (type == HCI_EVT_IND) {
        // HCI events travel as flat buffers (ble_hs_hci_rx_evt parses
        // bytes; ble_transport_free is a no-op in-sim, so statics are safe).
        ble_console_inject(type, flat);
        return;
    }
    // HCI ACL travels as pool mbufs (ble_hs_rx_data parses struct os_mbuf).
    struct os_mbuf *om = ble_hs_mbuf_from_flat(flat, (uint16_t)flatLen);
    if (!om) {
        Serial.println("[BLE] console-inject mbuf alloc failed");
        return;
    }
    ble_console_inject(type, (uint8_t*)om);
#else
    (void)type; (void)flat; (void)flatLen;
    Serial.println("[BLE] console-inject unsupported on this chip");
#endif
}

static void bleConsoleCmd(const char* cmd) {
    if (strncmp(cmd, "conn", 4) != 0 &&
        strncmp(cmd, "advterm", 7) != 0 &&
        strncmp(cmd, "rver", 4) != 0 &&
        strncmp(cmd, "feat", 4) != 0 &&
        strncmp(cmd, "stat", 4) != 0 &&
        strncmp(cmd, "disc", 4) != 0 && strncmp(cmd, "find", 4) != 0 &&
        strncmp(cmd, "wr", 2) != 0) {
        // Plain "!text": set + notify path (original bridge behavior).
        pChar->setValue((const uint8_t*)cmd, strlen(cmd));
        pChar->notify();
        Serial.printf("[BLE] console-notify value='%s'\n", cmd);
        return;
    }
    if (strncmp(cmd, "conn", 4) == 0) {
        // LE Connection Complete: [0x3E][len=0x13][sub=0x01][status=0]
        // [handle 1][role 1=peripheral][addr-type 0][AA BB CC DD EE FF]
        // [interval/latency/timeout/accuracy = 0].
        uint8_t* e = sEvtBuf;
        e[0] = 0x3E; e[1] = 0x13; e[2] = 0x01; e[3] = 0x00;
        e[4] = 0x01; e[5] = 0x00; e[6] = 0x01; e[7] = 0x00;
        e[8] = 0xAA; e[9] = 0xBB; e[10] = 0xCC;
        e[11] = 0xDD; e[12] = 0xEE; e[13] = 0xFF;
        memset(e + 14, 0, 7);
        bleInjectPacket(HCI_EVT_IND, e, (unsigned)e[1] + 2);
        Serial.println("[BLE] console-conn injected");
        return;
    }
    if (strncmp(cmd, "advterm", 7) == 0) {
        // LE Advertising Set Terminated (subevent 0x12): with extended
        // advertising the host parks a slave Connection Complete until
        // this arrives, then creates the connection.
        // [0x3E][len=0x06][sub=0x12][status=0][adv_handle 0]
        // [conn_handle 1][num_events 0].
        uint8_t* e = sEvtBuf;
        e[0] = 0x3E; e[1] = 0x06; e[2] = 0x12; e[3] = 0x00;
        e[4] = 0x00; e[5] = 0x01; e[6] = 0x00; e[7] = 0x00;
        bleInjectPacket(HCI_EVT_IND, e, (unsigned)e[1] + 2);
        Serial.println("[BLE] console-advterm injected");
        return;
    }
    if (strncmp(cmd, "rver", 4) == 0) {
        // Read Remote Version Complete (0x0C): answers the host's 0x041D
        // (sent after slave conn-complete); the host then reads features.
        // [0x0C][len=8][status=0][handle 1][ver 0x0B][mfr 0x02E5][sub 0].
        uint8_t* e = sEvtBuf;
        e[0] = 0x0C; e[1] = 0x08; e[2] = 0x00;
        e[3] = 0x01; e[4] = 0x00; e[5] = 0x0B;
        e[6] = 0xE5; e[7] = 0x02; e[8] = 0x00; e[9] = 0x00;
        bleInjectPacket(HCI_EVT_IND, e, (unsigned)e[1] + 2);
        Serial.println("[BLE] console-rver injected");
        return;
    }
    if (strncmp(cmd, "feat", 4) == 0) {
        // LE Read Remote Features Complete (subevent 0x04): answers the
        // host's 0x2016; the slave path then fires the GAP connect event.
        // [0x3E][len=12][sub=0x04][status=0][handle 1][features x8].
        uint8_t* e = sEvtBuf;
        e[0] = 0x3E; e[1] = 0x0C; e[2] = 0x04; e[3] = 0x00;
        e[4] = 0x01; e[5] = 0x00;
        e[6] = 0xFF; e[7] = 0xFF; e[8] = 0xFF; e[9] = 0xFF;
        e[10] = 0xFF; e[11] = 0xFF; e[12] = 0xFF; e[13] = 0xFF;
        bleInjectPacket(HCI_EVT_IND, e, (unsigned)e[1] + 2);
        Serial.println("[BLE] console-feat injected");
        return;
    }
    if (strncmp(cmd, "stat", 4) == 0) {
        // Observability for the fabricated-peer flow (all test-only).
        struct ble_hs_conn *c = ble_hs_conn_find(1);
        struct os_mbuf *t1 = ble_hs_mbuf_l2cap_pkt();
        struct os_mbuf *t2 = ble_hs_mbuf_acl_pkt();
        Serial.printf("[BLE] console-stat conn1=%p serverCount=%d advertising=%d msysfree=%d l2cap=%p acl=%p\n",
                      c, pServer->getConnectedCount(),
                      (int)NimBLEDevice::getAdvertising()->isAdvertising(),
                      r_os_msys_num_free(), t1, t2);
        if (t1) r_os_mbuf_free_chain(t1);
        if (t2) r_os_mbuf_free_chain(t2);
        return;
    }
    if (strncmp(cmd, "disc", 4) == 0) {
        // ATT Read By Group Request over ACL handle 1:
        // [h=1][dlen=11][llen=7][cid=4][op=0x10][start=1][end=0xffff]
        // [uuid=0x2800].
        uint8_t* p = sAclBuf;
        p[0] = 0x01; p[1] = 0x20; // PB=10: first (complete) L2CAP packet
        p[2] = 0x0B; p[3] = 0x00;
        p[4] = 0x07; p[5] = 0x00; p[6] = 0x04; p[7] = 0x00; p[8] = 0x10;
        p[9] = 0x01; p[10] = 0x00; p[11] = 0xFF; p[12] = 0xFF;
        p[13] = 0x00; p[14] = 0x28;
        bleInjectPacket(HCI_ACL_IND, p, 15);
        Serial.println("[BLE] console-disc injected");
        return;
    }
    unsigned a = 0, b = 0;
    if (sscanf(cmd, "find %x %x", &a, &b) == 2) {
        // ATT Find Information Request: [h=1][dlen=9][llen=5][cid=4]
        // [op=0x04][start][end].
        uint8_t* p = sAclBuf;
        p[0] = 0x01; p[1] = 0x20; // PB=10: first (complete) L2CAP packet
        p[2] = 0x09; p[3] = 0x00;
        p[4] = 0x05; p[5] = 0x00; p[6] = 0x04; p[7] = 0x00; p[8] = 0x04;
        p[9] = (uint8_t)a; p[10] = (uint8_t)(a >> 8);
        p[11] = (uint8_t)b; p[12] = (uint8_t)(b >> 8);
        bleInjectPacket(HCI_ACL_IND, p, 13);
        Serial.println("[BLE] console-find injected");
        return;
    }
    if (strncmp(cmd, "wr", 2) == 0) {
        // ATT Write Request: [h=1][dlen][llen][cid=4][op=0x12]
        // [attr-handle u16][bytes...]. First hex token is the handle,
        // rest are value bytes.
        const char* s = nullptr;
        unsigned h = (unsigned)strtoul(cmd + 2, (char**)&s, 16);
        uint8_t* p = sAclBuf;
        unsigned vi = 0;
        while (*s && vi < sizeof(sAclBuf) - 16) {
            while (*s == ' ') s++;
            if (!isxdigit((unsigned char)s[0]) || !isxdigit((unsigned char)s[1])) break;
            p[11 + vi++] = (uint8_t)((hexVal(s[0]) << 4) | hexVal(s[1]));
            s += 2;
        }
        p[0] = 0x01; p[1] = 0x20; // PB=10: first (complete) L2CAP packet
        unsigned n2 = 4 + 3 + vi;
        p[2] = (uint8_t)(n2 & 0xFF); p[3] = (uint8_t)(n2 >> 8);
        p[4] = (uint8_t)((3 + vi) & 0xFF); p[5] = 0x00;
        p[6] = 0x04; p[7] = 0x00; p[8] = 0x12;
        p[9] = (uint8_t)h; p[10] = (uint8_t)(h >> 8);
        bleInjectPacket(HCI_ACL_IND, p, n2 + 4);
        Serial.println("[BLE] console-wr injected");
        return;
    }
}

void setup(void) {
    ble_emu_scratch[0] = 0; // retain the emulator scratch (never otherwise touched by guest code)
    Serial.begin(115200);
    Serial.println("\n[BLE] starting");

    NimBLEDevice::init("NimBLE");
    Serial.println("[BLE] init done");
    bleNetPoolInit();

    uint64_t mac = ESP.getEfuseMac();
    char macStr[18];
    snprintf(macStr, sizeof(macStr), "%02x:%02x:%02x:%02x:%02x:%02x",
             (int)((mac >> 40) & 0xff), (int)((mac >> 32) & 0xff),
             (int)((mac >> 24) & 0xff), (int)((mac >> 16) & 0xff),
             (int)((mac >> 8) & 0xff),  (int)(mac & 0xff));
    Serial.printf("[BLE] local-mac=%s\n", macStr);

    pServer = NimBLEDevice::createServer();
    pServer->setCallbacks(new MyServerCallbacks());
    Serial.println("[BLE] server created");

    NimBLEService* pService = pServer->createService("DEAD");
    pChar = pService->createCharacteristic(
        "BEEF", NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::NOTIFY);
    pChar->setValue("Burger");
    pChar->setCallbacks(new MyCharCallbacks());
    Serial.printf("[BLE] service created uuid=%s\n",
                  pService->getUUID().toString().c_str());
    Serial.printf("[BLE] characteristic uuid=%s props=0x%02x value='%s'\n",
                  pChar->getUUID().toString().c_str(), pChar->getProperties(),
                  pChar->getValue().c_str());

    NimBLEAdvertising* pAdvertising = NimBLEDevice::getAdvertising();
    pAdvertising->setName("NimBLE-Server");
    pAdvertising->addServiceUUID(pService->getUUID());
    pAdvertising->enableScanResponse(true);
    pAdvertising->start();
    Serial.printf("[BLE] advertising started name='NimBLE-Server' scan-response=1\n");
    Serial.println("[BLE] ble-done");
}

void loop(void) {
    delay(100);
    gLoopCount++;
    // Console-to-BLE bridge: a line starting with '!' sets the
    // characteristic and notifies (no peer required for the print path).
    // Test-only inbound fabrications (static buffers: the host may retain
    // pointers past our return, so never stack-allocate these):
    //   !conn            -> LE Connection Complete (handle 1) via recv_cb
    //   !disc            -> ATT Read-By-Group request (services)
    //   !find <sh> <eh>  -> ATT Find Information (hex u16 handles)
    //   !wr <h> <hex>    -> ATT Write Request (hex u16 handle + bytes)
    while (Serial.available()) {
        static char cmd[64];
        static uint8_t cmdLen = 0;
        char ch = (char)Serial.read();
        if (ch == '\n' || ch == '\r') {
            if (cmdLen > 1 && cmd[0] == '!') {
                cmd[cmdLen] = '\0';
                bleConsoleCmd(cmd + 1);
            }
            cmdLen = 0;
        } else if (cmdLen < sizeof(cmd) - 1) {
            cmd[cmdLen++] = ch;
        }
    }
    // Periodic heartbeat so behavior is observable even without a peer.
    if (gLoopCount % 50 == 0) {
        uint32_t up = gLoopCount * 100;  // ms
        Serial.printf("[BLE] heartbeat uptime=%ums connections=%d\n",
                      up, (int)gConnCount);
        // Demonstrate a NOTIFY: bump the value and push it to subscribers.
        String s = "tick-" + String(gNotifyCounter++);
        pChar->setValue(s.c_str());
        pChar->notify();
        Serial.printf("[BLE] gatt-notify uuid=%s value='%s'\n",
                      pChar->getUUID().toString().c_str(), s.c_str());
    }
}
