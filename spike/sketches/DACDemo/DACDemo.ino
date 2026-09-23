#include <Arduino.h>
#include "emu_api.h"  // dacWrite/dacDisable (APC kind 'D')


#define DAC_PIN 25

void setup() {
  Serial.begin(115200);
  delay(100);
  Serial.println("[DAC] DAC demo start");
}

void loop() {
  static int step = 0;
  static const uint8_t levels[] = {0, 64, 128, 192, 255};
  if (step < 5) {
    bool ok = dacWrite(DAC_PIN, levels[step]);
    float volts = levels[step] / 255.0f * 3.3f;
    Serial.printf("[DAC] write pin=%d value=%u (~%.2fV) ok=%d\n", DAC_PIN, levels[step], volts, ok ? 1 : 0);
    step++;
    delay(50);
  } else {
    if (step == 5) {
      dacDisable(DAC_PIN);
      step++;
    }
    Serial.println("[DAC] dac-done");
    delay(500);
  }
}
