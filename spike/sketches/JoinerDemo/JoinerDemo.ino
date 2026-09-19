#include <Arduino.h>
#include "OThreadCLI.h"
#include <openthread/joiner.h>
#include <openthread/link.h>
#include <openthread/ip6.h>
#include <openthread/dataset.h>
#include <openthread/platform/alarm-milli.h>
// THREAD_JOINER discovery probe (Phase 40, slice 1): no static dataset.
// Joiner scans (fabricated beacons), discovers, times out cleanly with
// join-cb err=23 (NOT_FOUND) when no commissioner answers. Prints the
// ACTIVE DATASET TLVs length so the verifier can tell joined vs clean.
static void onJoin(otError e, void *) {
  Serial.printf("join-cb err=%d\n", (int)e);
}
static volatile bool sEnergyDone = false;
void setup() {
  Serial.begin(115200);
  Serial.println("thread-start");
  OThread.begin(false);
  otInstance *ip = OThread.getInstance();
  int en = otLinkSetEnabled(ip, true);
  Serial.printf("link-enable rc=%d radio=%d\n", en, (int)otPlatRadioGetState(ip));
  int e1 = otIp6SetEnabled(ip, true);
  Serial.printf("ip6-up rc=%d\n", (int)e1);
  int errE = otLinkEnergyScan(ip, 1 << 15, 50,
      [](otEnergyScanResult *r, void *) {
          if (r) Serial.printf("[THREAD] energy ch=%d rssi=%d\n", (int)r->mChannel, (int)r->mMaxRssi);
          else { Serial.println("[THREAD] energy-done"); sEnergyDone = true; }
      }, nullptr);
  Serial.printf("energy-scan-start rc=%d\n", (int)errE);
  otError e = otJoinerStart(ip, "J01NME", NULL, NULL, NULL, NULL, NULL, onJoin, NULL);
  Serial.printf("joiner-start rc=%d state=%d\n", (int)e, (int)otJoinerGetState(ip));
  Serial.println("thread-setup-done");
  OThread.networkInterfaceUp();
  Serial.println("thread-net-start");
}
static bool sActiveStarted = false;
void loop() {
  static int n = 0;
  otPlatAlarmMilliFired(OThread.getInstance());
  int radio = (int)otPlatRadioGetState(OThread.getInstance());
  if (++n % 2 == 0) {
    otError dsErr;
    otOperationalDatasetTlvs tlvs;
    dsErr = otDatasetGetActiveTlvs(OThread.getInstance(), &tlvs);
    Serial.printf("joiner-poll state=%d role=%d radio=%d dstlv=%d/%d\n",
                  (int)otJoinerGetState(OThread.getInstance()),
                  (int)OThread.otGetDeviceRole(), radio,
                  (int)dsErr, (int)tlvs.mLength);
  }
  if (sEnergyDone && !sActiveStarted) {
    sActiveStarted = true;
    int err = otLinkActiveScan(OThread.getInstance(), 1 << 15, 50,
        [](otActiveScanResult *r, void *) {
            if (r) Serial.printf("active-scan pan=0x%04x ch=%d rssi=%d\n",
                                 (unsigned)r->mPanId, (int)r->mChannel, (int)r->mRssi);
            else Serial.println("active-scan-done");
        }, nullptr);
    Serial.printf("active-scan-start rc=%d\n", (int)err);
    Serial.println("thread-done");
  }
  delay(100);
}
