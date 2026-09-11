// Validation sketch: bring up OpenThread, print device state, and attempt
// an energy scan + network discovery (exercises the 802.15.4 radio path).
#include <Arduino.h>
#include "OThreadCLI.h"
#include "esp_timer.h"
#include "esp_heap_caps.h"
#include <openthread/platform/alarm-milli.h>

// Direct 802.15.4 driver probe (C linkage, signatures from esp_ieee802154.h).
extern "C" {
int esp_ieee802154_enable(void);
int esp_ieee802154_set_channel(uint8_t channel);
int esp_ieee802154_receive(void);
int esp_ieee802154_transmit(const uint8_t *frame, bool cca);
}

// Set by the energy-scan callback; loop() waits for it before starting the
// active scan (back-to-back scans return BUSY while the MAC is occupied).
static volatile bool sEnergyDone = false;

// Static Thread network dataset (known test key shared with the harness).
// Starts from initNew() (a complete VALID dataset) and overrides the
// identity fields, so commit validation always passes.
static void provisionThreadNetwork() {
    DataSet ds;
    ds.initNew();
    ds.setNetworkName("ESP-EMU");
    static const uint8_t kExtPan[8] = { 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88 };
    ds.setExtendedPanId(kExtPan);
    // Thread spec test master key (shared with the harness peer).
    static const uint8_t kKey[16] = {
        0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77,
        0x88, 0x99, 0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF
    };
    ds.setNetworkKey(kKey);
    ds.setChannel(15);
    ds.setPanId(0x1234);
    OThread.commitDataSet(ds);
    Serial.println("[THREAD] dataset-commit done");
}

void setup() {
    Serial.begin(115200);
    Serial.println("thread-start");    OThread.begin(false);
    Serial.printf("[THREAD] role=%d (%s)\n",
                  (int)OThread.otGetDeviceRole(), OThread.otGetStringDeviceRole());
    // The 802.15.4 radio must be enabled first (begin(false) leaves it down).
    int en = otLinkSetEnabled(OThread.getInstance(), true);
    Serial.printf("[THREAD] link-enable rc=%d radio=%d\n", en,
                  (int)otPlatRadioGetState(OThread.getInstance()));
    // Raw driver probe: enable -> channel -> receive. Return codes pinpoint
    // where the 15.4 path stops in-sim.
    int e1 = esp_ieee802154_enable();
    int e2 = esp_ieee802154_set_channel(15);
    int e3 = esp_ieee802154_receive();
    Serial.printf("[THREAD] drv enable=%d chan=%d rx=%d\n", e1, e2, e3);
    // Energy scan: the virtual radio completes it on a later poll
    // (otPlatRadioEnergyScanDone with a fixed RSSI). The callback sets a
    // flag; loop() starts the active scan once it fires (back-to-back
    // scans return BUSY while the MAC is occupied).
    int errE = otLinkEnergyScan(OThread.getInstance(), 1 << 15, 50,
        [](otEnergyScanResult *r, void *) {
            if (r) {
                Serial.printf("[THREAD] energy ch=%d rssi=%d\n",
                              (int)r->mChannel, (int)r->mMaxRssi);
            } else {
                Serial.println("[THREAD] energy-done");
                sEnergyDone = true;
            }
        }, nullptr);
    Serial.printf("[THREAD] energy-scan-start rc=%d\n", (int)errE);
    Serial.println("thread-setup-done");
    // Bring up the Thread network (attach begins; role polls in loop() show
    // Detached -> Child/Router/Leader as it progresses). Interface must come
    // up before Thread enables (CLI: ifconfig up, thread start).
    provisionThreadNetwork();
    OThread.networkInterfaceUp();
    OThread.start();
    Serial.println("thread-net-start");
}

static bool sActiveStarted = false;

void loop() {
    static int n = 0;
    // Pump OT alarms (polled): the FRC/esp_timer alarm ISR never fires
    // in-sim, so TimerMilli would pile up forever (no Parent Responses,
    // retries, advertisements). GetNow is shimmed to FreeRTOS ticks.
    otPlatAlarmMilliFired(OThread.getInstance());
    // Polling GetState drives the virtual radio's deferred energy-scan
    // completion; the first poll after setup fires the energy callback.
    int radio = (int)otPlatRadioGetState(OThread.getInstance());
    if (++n % 2 == 0) {
        Serial.printf("[THREAD] poll role=%d radio=%d\n",
                      (int)OThread.otGetDeviceRole(), radio);
        // Diagnostics (attach debugging): heap + FreeRTOS tick + esp_timer.
        // Stable or drifting values pinpoint timer/heap death vs MLE drops.
        Serial.printf("[THREAD] diag heap=%u tick=%u etime=%lld now=%lu\n",
                      (unsigned)esp_get_free_heap_size(),
                      (unsigned)xTaskGetTickCount(),
                      (long long)esp_timer_get_time(),
                      (unsigned long)otPlatAlarmMilliGetNow());
    }
    // Active scan sends beacon requests (TX tap) once the energy scan
    // has completed and freed the MAC.
    if (sEnergyDone && !sActiveStarted) {
        sActiveStarted = true;
        int err = otLinkActiveScan(OThread.getInstance(), 1 << 15, 50,
            [](otActiveScanResult *r, void *) {
                if (r) {
                    Serial.printf("[THREAD] active-scan pan=0x%04x ch=%d rssi=%d\n",
                                  (unsigned)r->mPanId,
                                  (int)r->mChannel, (int)r->mRssi);
                } else {
                    Serial.println("[THREAD] active-scan-done");
                }
            }, nullptr);
        Serial.printf("[THREAD] active-scan-start rc=%d\n", (int)err);
        Serial.println("thread-done");
    }
    // Periodic re-scan probe (SubMac liveness): if SubMac can still TX,
    // these emit beacon requests; if wedged, they return BUSY/fail.
    // Runs rarely to avoid disturbing attach timing.
    if ((n % 50) == 0 && n > 0) {
        int err = otLinkActiveScan(OThread.getInstance(), 1 << 15, 50,
            [](otActiveScanResult *r, void *) {
                if (r) {
                    Serial.printf("[THREAD] rescan pan=0x%04x ch=%d rssi=%d\n",
                                  (unsigned)r->mPanId,
                                  (int)r->mChannel, (int)r->mRssi);
                } else {
                    Serial.println("[THREAD] rescan-done");
                }
            }, nullptr);
        Serial.printf("[THREAD] rescan-start rc=%d n=%d\n", (int)err, n);
    }
    delay(100);
}
