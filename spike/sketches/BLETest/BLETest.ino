#include <Arduino.h>

extern "C" int esp_bt_controller_init(void *cfg);
extern "C" int esp_bt_controller_enable(int mode);
extern "C" int esp_vhci_host_send_packet(const uint8_t *pkt, uint16_t len);
extern "C" int API_vhci_host_send_packet(const uint8_t *pkt, uint16_t len);
extern "C" int esp_vhci_host_check_send_available(void);
extern "C" void esp_vhci_host_register_callback(const void *cb);

static uint32_t gLoop = 0;

// Last HCI event delivered through the registered VHCI callback.
// The emulator's send_packet shim invokes this synchronously with a pointer
// to the virtual controller's event packet, so copy out immediately.
static uint8_t gEvt[80];
static uint8_t gEvtLen = 0;

extern "C" void on_hci_evt(const uint8_t *packet) {
    // VHCI event framing: [0x04 type][event code][param len][params...].
    uint8_t total = 0;
    if (packet) {
        uint8_t plen = packet[2];
        total = (uint8_t)(plen + 3);
        if (total > sizeof(gEvt)) total = sizeof(gEvt);
        for (int i = 0; i < total; i++) gEvt[i] = packet[i];
    }
    gEvtLen = total;
}

static void printEvt(const char *which) {
    Serial.printf("[TEST] hci-evt-%s len=%u:", which, gEvtLen);
    for (int i = 0; i < gEvtLen; i++) Serial.printf(" %02x", gEvt[i]);
    Serial.println();
}

// HCI Reset ([H4 cmd][0x0C03][plen 0]) via the given entry point; expects a
// Command Complete for opcode 0x0C03 with status 0 from the virtual
// controller. Returns true on a valid round trip.
static bool hciReset(const char *which,
                     int (*sendFn)(const uint8_t *, uint16_t)) {
    static const uint8_t reset[] = {0x01, 0x03, 0x0C, 0x00};
    gEvtLen = 0;
    Serial.printf("[TEST] sending HCI reset via %s (send_available=%d)\n", which,
                  esp_vhci_host_check_send_available());
    Serial.flush();
    int rc = sendFn(reset, sizeof(reset));
    Serial.printf("[TEST] send returned: %d\n", rc);
    Serial.flush();
    printEvt(which);
    bool ok = (rc == 0 && gEvtLen >= 7 && gEvt[0] == 0x04 && gEvt[1] == 0x0E &&
               gEvt[4] == 0x03 && gEvt[5] == 0x0C && gEvt[6] == 0x00);
    Serial.printf("[TEST] hci-reset-%s %s\n", which, ok ? "ok" : "FAIL");
    Serial.flush();
    return ok;
}

void setup() {
    Serial.begin(115200);
    delay(50);

    // Local identity, reported from the firmware side.
    uint64_t mac = ESP.getEfuseMac();
    char macStr[18];
    snprintf(macStr, sizeof(macStr), "%02x:%02x:%02x:%02x:%02x:%02x",
             (int)((mac >> 40) & 0xff), (int)((mac >> 32) & 0xff),
             (int)((mac >> 24) & 0xff), (int)((mac >> 16) & 0xff),
             (int)((mac >> 8) & 0xff),  (int)(mac & 0xff));
    Serial.printf("[TEST] local-mac=%s\n", macStr);

    Serial.printf("[TEST] send_available before init: %d\n",
                  esp_vhci_host_check_send_available());
    Serial.flush();

    Serial.println("[TEST] calling esp_bt_controller_init(0x1)...");
    Serial.flush();
    int r = esp_bt_controller_init((void *)0x1);  // invalid cfg: real HW faults, loader stub returns
    Serial.printf("[TEST] init returned: %d\n", r);
    Serial.printf("[TEST] send_available after init: %d\n",
                  esp_vhci_host_check_send_available());

    Serial.println("[TEST] calling esp_bt_controller_enable(1)...");
    Serial.flush();
    int r2 = esp_bt_controller_enable(1);
    Serial.printf("[TEST] enable returned: %d\n", r2);
    Serial.printf("[TEST] send_available after enable: %d\n",
                  esp_vhci_host_check_send_available());

    // Direct HCI exchange through the loader's VHCI shims: register the event
    // callback, then issue Reset through both send_packet entry points. Each
    // call round-trips synchronously with the JS virtual HCI controller.
    esp_vhci_host_register_callback((const void *)on_hci_evt);
    bool okEsp = hciReset("esp", esp_vhci_host_send_packet);
    bool okApi = hciReset("api", API_vhci_host_send_packet);
    Serial.printf("[TEST] hci-direct %s\n", (okEsp && okApi) ? "ok" : "FAIL");

    Serial.println("[TEST] done");
}

void loop() {
    delay(1000);
    gLoop++;
    if (gLoop % 3 == 0) {
        Serial.printf("[TEST] heartbeat loop=%u send_available=%d\n",
                      gLoop, esp_vhci_host_check_send_available());
    }
}
