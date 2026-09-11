// Validation sketch: bring up OpenThread, print device state, and attempt
// an energy scan + network discovery (exercises the 802.15.4 radio path).
#include <Arduino.h>
#include "OThreadCLI.h"
#include "esp_timer.h"
#include "esp_heap_caps.h"
#include "esp_mac.h"
#include <openthread/platform/alarm-milli.h>
#include <openthread/thread_ftd.h>

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
    // THREAD_KEY2 builds use the reversed key (dataset-agility proof).
    static const uint8_t kKey[16] = {
#ifdef THREAD_KEY2
        0xFF, 0xEE, 0xDD, 0xCC, 0xBB, 0xAA, 0x99, 0x88,
        0x77, 0x66, 0x55, 0x44, 0x33, 0x22, 0x11, 0x00
#else
        0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77,
        0x88, 0x99, 0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF
#endif
    };
    ds.setNetworkKey(kKey);
    ds.setChannel(15);
    ds.setPanId(0x1234);
    OThread.commitDataSet(ds);
    Serial.println("[THREAD] dataset-commit done");
}

void setup() {
    Serial.begin(115200);
#ifdef THREAD_NODE_B
    // Second-C6 identity (38 multihop): default emulated EUIs collide
    // across same-chip instances (same link-local IID -> MLE confusion).
    // Override with a locally-administered EUI before OT starts.
    // NOTE: no RNG burn here (esp_random traps in-sim, unemulated RNG).
    {
        static const uint8_t bEui[6] = { 0x02, 0x00, 0x00, 0x00, 0x00, 0xB2 };
        esp_base_mac_addr_set(bEui);
        Serial.println("[THREAD] node-b EUI override");
    }
#endif
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
    // NOTE: do NOT wrap in vTaskSuspendAll (deadlocks: scheduler lock
    // around Fired wedges boot (roles stuck 0,1 + Guru)).
    // Node-B freeze (38 multihop): as an un-upgraded child, skip the pump
    // so Parent Request retries (and challenge churn) freeze after the
    // first request; A answers the stable challenge. Scans (role<2) and
    // router+ (after upgrade) still pump. H2/C6 pump always.
#ifdef THREAD_NODE_B
    // Pump gate (38 multihop): scans + first request need timers early
    // (n<200); after that freeze retries so A's in-flight response lands
    // on a stable challenge (challenge race). Routers/leaders (3/4)
    // always pump (parenting needs timers). H2/C6 pump always.
    {
        int roleNow = (int)OThread.otGetDeviceRole();
        if (roleNow >= 3 || n < 500) otPlatAlarmMilliFired(OThread.getInstance());
    }
#else
    otPlatAlarmMilliFired(OThread.getInstance());
#endif
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
#if CONFIG_IDF_TARGET_ESP32C6 || CONFIG_IDF_TARGET_ESP32C5
    // MULTIHOP test hook (38): become a router on the first poll as a
    // child so a third node can attach through us. C6/C5-gated (never H2,
    // never leaders); immediate to outrun long-run tick decay. 37 uses
    // H2 as B (no hook there) so it still pins role 2.
    {
        static bool triedUpgrade = false;
        if (!triedUpgrade && (int)OThread.otGetDeviceRole() == 2) {
            triedUpgrade = true;
            otError err = otThreadBecomeRouter(OThread.getInstance());
            Serial.printf("[THREAD] upgrade-to-router rc=%d\n", (int)err);
        }
    }
#endif
    // Periodic re-scan probe (SubMac liveness): if SubMac can still TX,    // these emit beacon requests; if wedged, they return BUSY/fail.
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
    // Node-B loop rate (38 multihop): fast polls (delivery + upgrade
    // hook); timers slowed separately above for challenge stability.
    delay(100);
}
