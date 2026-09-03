#include <Arduino.h>
#include "soc/soc_caps.h"

// Virtual touch pad API. Chips without touch hardware (SOC_TOUCH_SENSOR_SUPPORTED=0,
// e.g. C3/C6/H2) need this `extern "C"` fallback so the linker has a symbol for
// the emulator's load-time patcher to overwrite with the virtual-touch shim
// (APC kind 'T'). Unpatched it returns an error sentinel. Chips with native
// touch (e.g. P4) use the core's own declaration; the loader patches it too.
#if !SOC_TOUCH_SENSOR_SUPPORTED
extern "C" {
uint16_t touchRead(uint8_t pin);
void touchAttachInterrupt(uint8_t pin, void (*fn)(void), uint16_t threshold);
void touchDetachInterrupt(uint8_t pin);
}
#endif


#define TOUCH_PIN 4

void setup() {
  Serial.begin(115200);
  delay(100);
  Serial.println("[TOUCH] Touch demo start");
  touchAttachInterrupt(TOUCH_PIN, nullptr, 500);
  uint16_t v = touchRead(TOUCH_PIN);
  Serial.printf("[TOUCH] initial raw=%u touched=%d\n", v, v < 800 ? 1 : 0);
}

void loop() {
  static int n = 0;
  uint16_t v = touchRead(TOUCH_PIN);
  Serial.printf("[TOUCH] poll=%d raw=%u touched=%d\n", n, v, v < 800 ? 1 : 0);
  n++;
  if (n >= 6) {
    if (n == 6) touchDetachInterrupt(TOUCH_PIN);
    Serial.println("[TOUCH] touch-done");
    delay(500);
  } else {
    delay(50);
  }
}
