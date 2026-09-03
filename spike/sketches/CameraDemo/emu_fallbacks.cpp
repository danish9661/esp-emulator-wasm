#include <Arduino.h>
#include <stdint.h>
extern "C" {
int emuCameraReadBand(uint8_t *buf, uint32_t offset, uint32_t len) {
  asm volatile(".rept 512\n\tnop\n\t.endr");  // reserve load-time patch space
  volatile uint32_t pad[160];
  uint32_t acc = offset ^ (len * 2654435761u);
  for (int i = 0; i < 160; i++) {
    pad[i] = acc * 2654435761u + (uint32_t)i;
    acc ^= pad[i] >> 11;
  }
  (void)pad;
  (void)buf;
  return -1;
}
}
