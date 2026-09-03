#include <Arduino.h>
#include <stdint.h>
#include "soc/soc_caps.h"

// Only chips without touch hardware need the fallback (e.g. ESP32-P4 provides
// touchRead natively and would conflict). Either way the emulator's loader
// overwrites the symbol with the virtual-touch shim at load time.
#if !SOC_TOUCH_SENSOR_SUPPORTED
extern "C" {
uint16_t touchRead(uint8_t pin) {
  asm volatile(".rept 512\n\tnop\n\t.endr");  // reserve load-time patch space (>=484B shim)
  volatile uint32_t pad[160];
  uint32_t acc = ((uint32_t)pin | 1u) * 2654435761u;
  for (int i = 0; i < 160; i++) {
    pad[i] = acc;
    acc ^= (acc >> 13) + (uint32_t)i;
    acc *= 2246822519u;
  }
  (void)pad;
  return (uint16_t)(0xFFFFu - (acc & 0xFFu));
}
void touchAttachInterrupt(uint8_t pin, void (*fn)(void), uint16_t threshold) {
  (void)pin;
  (void)fn;
  (void)threshold;
  volatile uint32_t sink = threshold + pin;
  (void)sink;
}
void touchDetachInterrupt(uint8_t pin) {
  (void)pin;
  volatile uint32_t sink = pin;
  (void)sink;
}
}
#endif  // !SOC_TOUCH_SENSOR_SUPPORTED
