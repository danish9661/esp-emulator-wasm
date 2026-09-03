#include <Arduino.h>
#include <Preferences.h>

// NVS test (native flash emulation, no shims). Writes a counter + string via
// Preferences (NVS namespace), reads them back, and verifies. Proves the
// emulator's NVS/flash backend used by settings storage.

static Preferences prefs;

void setup() {
  Serial.begin(115200);
  delay(100);
  Serial.println("[NVS] NVS demo start");
  if (!prefs.begin("emu-test", false)) {
    Serial.println("[NVS] begin FAILED");
    return;
  }
  Serial.println("[NVS] namespace open");
}

void loop() {
  static int phase = 0;
  if (phase == 0) {
    bool ok = prefs.putUInt("counter", 424242) > 0;
    ok = prefs.putString("greeting", "nvs-hello") > 0 && ok;
    Serial.printf("[NVS] write %s\n", ok ? "OK" : "FAIL");
    phase++;
    delay(50);
  } else if (phase == 1) {
    uint32_t c = prefs.getUInt("counter", 0);
    String g = prefs.getString("greeting", "?");
    bool ok = (c == 424242) && (g == "nvs-hello");
    Serial.printf("[NVS] readback counter=%u greeting=%s %s\n", c, g.c_str(), ok ? "OK" : "FAIL");
    prefs.end();
    phase++;
    delay(50);
  } else {
    Serial.println("[NVS] nvs-done");
    delay(500);
  }
}
