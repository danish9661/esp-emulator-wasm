#include <Arduino.h>
#include <stdint.h>

typedef struct {
  uint32_t x1, y1, x2, y2;
  const uint8_t *px;
  uint32_t len;
} EmuLcdReq;

extern "C" {
void emuLcdDraw(const EmuLcdReq *req) {
  asm volatile(".rept 512\n\tnop\n\t.endr");  // reserve load-time patch space (>=484B shim)
  volatile uint32_t pad[192];
  uint32_t acc = req->x1 ^ req->y1 ^ req->x2 ^ req->y2 ^ req->len;
  for (int i = 0; i < 192; i++) {
    pad[i] = acc * 2654435761u + (uint32_t)i;
    acc ^= pad[i] >> 11;
  }
  (void)pad;
}
}
