#include <Arduino.h>
#include <LittleFS.h>

// LittleFS test (native flash emulation, no shims). Formats (if needed),
// writes a file, reads it back, and verifies content. Proves the emulator's
// SPI flash erase/program path used by flash filesystems.

static const char *kPath = "/hello.txt";
static const char *kMsg = "Hello from emulated flash LittleFS!";

void setup() {
  Serial.begin(115200);
  delay(100);
  Serial.println("[LITTLEFS] LittleFS demo start");
  if (!LittleFS.begin(false)) {
    Serial.println("[LITTLEFS] mount failed, formatting...");
    if (!LittleFS.format()) {
      Serial.println("[LITTLEFS] format FAILED");
      return;
    }
    if (!LittleFS.begin(false)) {
      Serial.println("[LITTLEFS] mount after format FAILED");
      return;
    }
  }
  Serial.println("[LITTLEFS] mounted");
}

void loop() {
  static int phase = 0;
  if (phase == 0) {
    File f = LittleFS.open(kPath, "w");
    bool ok = !!f;
    if (ok) {
      ok = f.print(kMsg) == (int)strlen(kMsg);
      f.close();
    }
    Serial.printf("[LITTLEFS] write %s\n", ok ? "OK" : "FAIL");
    phase++;
    delay(50);
  } else if (phase == 1) {
    File f = LittleFS.open(kPath, "r");
    String s;
    if (f) {
      s = f.readString();
      f.close();
    }
    bool ok = (s == kMsg);
    Serial.printf("[LITTLEFS] readback (%dB) %s\n", s.length(), ok ? "OK" : "FAIL");
    phase++;
    delay(50);
  } else {
    Serial.println("[LITTLEFS] littlefs-done");
    delay(500);
  }
}
