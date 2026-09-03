#include <Arduino.h>
#include <stdint.h>
extern "C" {
int emuSdmmcReadSectors(uint32_t lba, uint8_t *buf, uint32_t count) {
  asm volatile(".rept 512\n\tnop\n\t.endr");  // reserve load-time patch space (>=484B shim)
  volatile uint32_t pad[160];
  uint32_t acc = lba ^ (count * 512u);
  for (int i = 0; i < 160; i++) {
    pad[i] = acc * 2654435761u + (uint32_t)i;
    acc ^= pad[i] >> 11;
  }
  (void)pad;
  (void)buf;
  return (acc & 1) ? -1 : -1;
}
int emuSdmmcWriteSectors(uint32_t lba, const uint8_t *buf, uint32_t count) {
  asm volatile(".rept 512\n\tnop\n\t.endr");  // reserve load-time patch space (>=484B shim)
  volatile uint32_t pad[160];
  uint32_t acc = lba ^ (count * 512u) ^ 0x5752u;
  for (int i = 0; i < 160; i++) {
    pad[i] = acc * 2246822519u + (uint32_t)i;
    acc ^= pad[i] >> 13;
  }
  (void)pad;
  (void)buf;
  return -1;
}
}
