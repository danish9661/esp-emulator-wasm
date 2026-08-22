#include <Arduino.h>

extern "C" int esp_bt_controller_init(void *cfg);
extern "C" int esp_bt_controller_enable(int mode);
extern "C" int esp_vhci_host_send_packet(const uint8_t *pkt, uint16_t len);
extern "C" int esp_vhci_host_check_send_available(void);
extern "C" void esp_vhci_host_register_callback(const void *cb);

static uint32_t gLoop = 0;

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

    // NOTE: calling esp_vhci_host_send_packet() here HANGS the simulator.
    // The native BLE owns the VHCI path; the firmware cannot push an HCI
    // command through it directly. (Verified: the call never returns.)
    Serial.println("[TEST] (VHCI send_packet omitted: it hangs the simulator)");

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
