#include <Arduino.h>

extern "C" int esp_bt_controller_init(void *cfg);
extern "C" int esp_bt_controller_enable(int mode);
extern "C" int esp_vhci_host_send_packet(const uint8_t *pkt, uint16_t len);
extern "C" int esp_vhci_host_check_send_available(void);
extern "C" void esp_vhci_host_register_callback(const void *cb);

static uint32_t rd32(uint32_t a) { return *(volatile uint32_t *)a; }
static uint32_t gLoop = 0;

// Classify the first instruction as seen in flash. NOTE: the simulator's
// loader intercepts these symbols at RUNTIME (in the wasm JIT), so flash
// bytes still show the firmware's own weak stubs. We can only see what the
// firmware image contains, not the live override.
static const char *classifyFirst(uint32_t w0, int *imm) {
    uint8_t op = w0 & 0x7f;
    if (op == 0x6f || op == 0x67 || op == 0x17)
        return "TRAMPOLINE (intercepted by loader)";
    if (op == 0x13 && ((w0 >> 7) & 0x1f) == 10 /*a0*/) {  // addi a0, ...
        *imm = (int)(w0 & 0xfff);
        if (*imm & 0x800) *imm -= 0x1000;
        return "STUB: returns constant (real impl supplied by loader at runtime)";
    }
    return "normal function";
}

static void dumpSym(const char *name, uint32_t a) {
    uint32_t w0 = rd32(a);
    int imm = 0;
    Serial.printf("[DETECT] %-40s @%08x w0=%08x -> %s\n", name, a, w0,
                  classifyFirst(w0, &imm));
    if (imm) Serial.printf("           (returns %d)\n", imm);
    for (int j = 0; j < 8; j++) Serial.printf("           +%02d %08x\n", j * 4, rd32(a + j * 4));
}

void setup() {
    Serial.begin(115200);
    delay(50);

    uint64_t mac = ESP.getEfuseMac();
    char macStr[18];
    snprintf(macStr, sizeof(macStr), "%02x:%02x:%02x:%02x:%02x:%02x",
             (int)((mac >> 40) & 0xff), (int)((mac >> 32) & 0xff),
             (int)((mac >> 24) & 0xff), (int)((mac >> 16) & 0xff),
             (int)((mac >> 8) & 0xff),  (int)(mac & 0xff));
    Serial.printf("[DETECT] local-mac=%s\n", macStr);

    dumpSym("esp_bt_controller_init",              (uint32_t)esp_bt_controller_init);
    dumpSym("esp_bt_controller_enable",            (uint32_t)esp_bt_controller_enable);
    dumpSym("esp_vhci_host_send_packet",           (uint32_t)esp_vhci_host_send_packet);
    dumpSym("esp_vhci_host_check_send_available",  (uint32_t)esp_vhci_host_check_send_available);
    dumpSym("esp_vhci_host_register_callback",     (uint32_t)esp_vhci_host_register_callback);
    Serial.println("[DETECT] done");
}

void loop() {
    delay(1000);
    gLoop++;
    if (gLoop % 3 == 0) {
        Serial.printf("[DETECT] heartbeat loop=%u send_available=%d\n",
                      gLoop, esp_vhci_host_check_send_available());
    }
}
