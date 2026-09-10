// Validation sketch: bring up OpenThread, print device state, and attempt
// an energy scan + network discovery (exercises the 802.15.4 radio path).
#include <Arduino.h>
#include "OThreadCLI.h"

// Direct 802.15.4 driver probe (C linkage, signatures from esp_ieee802154.h).
extern "C" {
int esp_ieee802154_enable(void);
int esp_ieee802154_set_channel(uint8_t channel);
int esp_ieee802154_receive(void);
int esp_ieee802154_transmit(const uint8_t *frame, bool cca);
}

void setup() {
    Serial.begin(115200);
    Serial.println("thread-start");
    OThread.begin(false);
    Serial.printf("[THREAD] role=%d (%s)\n",
                  (int)OThread.otGetDeviceRole(), OThread.otGetStringDeviceRole());
    // Energy scan forces 802.15.4 TX (beacon requests) so the radio path
    // can be observed with a tap on otPlatRadioTransmit. The 802.15.4 radio
    // must be enabled first (begin(false) leaves it down).
    int en = otLinkSetEnabled(OThread.getInstance(), true);
    Serial.printf("[THREAD] link-enable rc=%d radio=%d\n", en,
                  (int)otPlatRadioGetState(OThread.getInstance()));
    // Raw driver probe: enable -> channel -> receive -> transmit a beacon
    // request. Return codes pinpoint where the 15.4 path stops in-sim.
    int e1 = esp_ieee802154_enable();
    int e2 = esp_ieee802154_set_channel(15);
    int e3 = esp_ieee802154_receive();
    static const uint8_t bcn[] = { 8, 0x03, 0x08, 0x5A, 0xFF, 0xFF, 0xFF, 0xFF, 0x07 };
    int e4 = esp_ieee802154_transmit(bcn, false);
    Serial.printf("[THREAD] drv enable=%d chan=%d rx=%d tx=%d\n", e1, e2, e3, e4);
    int err = otLinkEnergyScan(OThread.getInstance(), 1 << 15, 50,
        [](otEnergyScanResult *r, void *) {
            if (r) {
                Serial.printf("[THREAD] energy ch=%d rssi=%d\n",
                              (int)r->mChannel, (int)r->mMaxRssi);
            } else {
                Serial.println("[THREAD] energy-done");
            }
        }, nullptr);
    Serial.printf("[THREAD] energy-scan-start rc=%d\n", (int)err);
    Serial.println("thread-done");
}

void loop() {
    static int n = 0;
    if (++n % 2 == 0) {
        Serial.printf("[THREAD] poll role=%d radio=%d\n",
                      (int)OThread.otGetDeviceRole(),
                      (int)otPlatRadioGetState(OThread.getInstance()));
    }
    delay(5000);
}
