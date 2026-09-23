// emu_api.cpp — link-time fallback bodies for emu_api.h.
//
// Every body reserves >= 512 NOPs + scratch words so the compiled function
// is ALWAYS larger than its shim (loader patches only when
// shim.length <= func size). Unpatched (real hardware) they return safe
// error sentinels and touch no peripherals.

#include "emu_api.h"

// Pad macro: 512 NOPs (~512B .text) + 160-word scratch loop so even -Os
// builds stay comfortably above the largest virtual shim (~484B).
#define EMU_API_PAD(seed_expr)                                                  \
  asm volatile(".rept 512\n\tnop\n\t.endr"); /* reserve patch space */         \
  volatile uint32_t pad[160];                                                  \
  uint32_t acc = (uint32_t)(seed_expr);                                        \
  for (int i = 0; i < 160; i++) {                                              \
    pad[i] = acc * 2654435761u + (uint32_t)i;                                  \
    acc ^= pad[i] >> 11;                                                       \
  }                                                                            \
  (void)pad

extern "C" {

#if !SOC_TOUCH_SENSOR_SUPPORTED
uint16_t touchRead(uint8_t pin) {
  EMU_API_PAD((((uint32_t)pin | 1u) * 2654435761u));
  for (int i = 0; i < 160; i++) {
    acc ^= (acc >> 13) + (uint32_t)i;
    acc *= 2246822519u;
  }
  return (uint16_t)(0xFFFFu - (acc & 0xFFu));
}

void touchAttachInterrupt(uint8_t pin, void (*fn)(void), uint16_t threshold) {
  (void)fn;
  EMU_API_PAD(((uint32_t)threshold + pin));
  (void)acc;
}

void touchDetachInterrupt(uint8_t pin) {
  EMU_API_PAD((uint32_t)pin);
  (void)acc;
}
#endif // !SOC_TOUCH_SENSOR_SUPPORTED

bool dacWrite(uint8_t pin, uint8_t value) {
  EMU_API_PAD((((uint32_t)pin << 8) | value));
  (void)acc;
  return false;
}

void dacDisable(uint8_t pin) {
  // Small body is INTENTIONAL: the dacDisable shim is a noop (8B), so any
  // function >= 8B patches. Keep it tiny so -Os never inlines it away, but
  // never smaller than the shim.
  volatile uint32_t sink = (uint32_t)pin * 2654435761u;
  (void)sink;
}

int emuSdmmcReadSectors(uint32_t lba, uint8_t *buf, uint32_t count) {
  (void)buf;
  EMU_API_PAD((lba ^ (count * 512u)));
  (void)acc;
  return -1;
}

int emuSdmmcWriteSectors(uint32_t lba, const uint8_t *buf, uint32_t count) {
  (void)buf;
  EMU_API_PAD((lba ^ (count * 512u) ^ 0x5752u));
  (void)acc;
  return -1;
}

int emuCameraReadBand(uint8_t *buf, uint32_t offset, uint32_t len) {
  (void)buf;
  EMU_API_PAD((offset ^ (len * 2654435761u)));
  (void)acc;
  return -1;
}

void emuLcdDraw(const EmuLcdReq *req) {
  EMU_API_PAD((req->x1 ^ req->y1 ^ req->x2 ^ req->y2 ^ req->len));
  (void)acc;
}

} // extern "C"
