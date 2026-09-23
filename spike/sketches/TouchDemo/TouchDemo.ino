#include <Arduino.h>
#include "emu_api.h"  // touchRead/touchAttachInterrupt/touchDetachInterrupt (APC kind 'T')


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
