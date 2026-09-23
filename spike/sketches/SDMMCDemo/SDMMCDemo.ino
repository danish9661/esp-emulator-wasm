#include <Arduino.h>
#include "emu_api.h"  // emuSdmmcReadSectors/emuSdmmcWriteSectors (APC kind 'M')


static uint8_t sector[512];

void setup() {
  Serial.begin(115200);
  delay(100);
  Serial.println("[SDMMC] SDMMC demo start");
}

void loop() {
  static int phase = 0;
  if (phase == 0) {
    int rc = emuSdmmcReadSectors(0, sector, 1);
    bool sig = (rc == 0 && sector[510] == 0x55 && sector[511] == 0xAA);
    Serial.printf("[SDMMC] vbr rc=%d sig=%s\n", rc, sig ? "OK" : "FAIL");
    phase++;
    delay(50);
  } else if (phase == 1) {
    // Cluster 2 of the default FAT16 image lives at LBA 65.
    int rc = emuSdmmcReadSectors(65, sector, 1);
    sector[511] = 0;
    Serial.printf("[SDMMC] cluster rc=%d content=%.32s\n", rc, (const char *)sector);
    phase++;
    delay(50);
  } else if (phase == 2) {
    for (int i = 0; i < 512; i++) sector[i] = (uint8_t)(i ^ 0xA5);
    int rc = emuSdmmcWriteSectors(100, sector, 1);
    Serial.printf("[SDMMC] write rc=%d\n", rc);
    phase++;
    delay(50);
  } else if (phase == 3) {
    for (int i = 0; i < 512; i++) sector[i] = 0;
    int rc = emuSdmmcReadSectors(100, sector, 1);
    bool ok = (rc == 0);
    for (int i = 0; ok && i < 512; i++) {
      if (sector[i] != (uint8_t)(i ^ 0xA5)) ok = false;
    }
    Serial.printf("[SDMMC] writeback=%s\n", ok ? "OK" : "FAIL");
    phase++;
    delay(50);
  } else {
    Serial.println("[SDMMC] sdmmc-done");
    delay(500);
  }
}
