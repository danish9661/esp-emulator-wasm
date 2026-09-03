#include <Arduino.h>

// Virtual camera (grayscale test-pattern frames). No CSI hardware exists, so
// this fallback provides the patch target for the 'F' shim.
// The frame is pulled in small bands (512B): some chips cannot sink
// multi-KB host->firmware replies. Unpatched it returns -1.
extern "C" {
int emuCameraReadBand(uint8_t *buf, uint32_t offset, uint32_t len);
}


#define CAM_W 96
#define CAM_H 96
#define CAM_LEN (CAM_W * CAM_H)
#define CAM_BAND 512
static uint8_t fb[CAM_LEN];

void setup() {
  Serial.begin(115200);
  delay(100);
  Serial.println("[CAM] Camera demo start");
}

void loop() {
  static int n = 0;
  if (n == 0) {
    int total = 0;
    for (uint32_t off = 0; off < CAM_LEN; off += CAM_BAND) {
      int got = emuCameraReadBand(fb + off, off, CAM_BAND);
      if (got <= 0) break;
      total += got;
      // Yield between bands: back-to-back bulk RX transfers stall some
      // chips' UART model (P4); prints+delays let it settle (as in SDMMCDemo).
      if ((off / CAM_BAND) % 6 == 5) {
        Serial.printf("[CAM] band %u/%u\n", (off / CAM_BAND) + 1, CAM_LEN / CAM_BAND);
      }
      delay(30);
    }
    uint32_t sum = 0;
    for (int i = 0; i < CAM_LEN && i < total; i++) sum += fb[i];
    Serial.printf("[CAM] frame len=%d sum=%u first=%02X %02X %02X %02X\n", total, sum & 0xFFFFu, fb[0], fb[1], fb[8], fb[9]);
    n++;
    delay(50);
  } else {
    Serial.println("[CAM] cam-done");
    delay(500);
  }
}
