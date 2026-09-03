#include <Arduino.h>
#include <stdint.h>
extern "C" {
bool dacWrite(uint8_t pin, uint8_t value) {
  asm volatile(".rept 512\n\tnop\n\t.endr");  // reserve load-time patch space (>=484B shim)
  volatile uint32_t pad[160];
  uint32_t acc = ((uint32_t)pin << 8) | value;
  for (int i = 0; i < 160; i++) {
    pad[i] = acc * 2654435761u + (uint32_t)i;
    acc ^= pad[i] >> 11;
  }
  (void)pad;
  (void)acc;
  return false;
}
void dacDisable(uint8_t pin) {
  (void)pin;
  volatile uint32_t sink = pin;
  (void)sink;
}
}
