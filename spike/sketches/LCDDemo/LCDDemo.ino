#include <Arduino.h>
#include "emu_api.h"  // EmuLcdReq + emuLcdDraw (APC kind 'L')

#define LCD_W 240
#define LCD_H 40
static uint16_t bar[LCD_W * LCD_H];

static void fillBar(uint16_t rgb565) {
  for (int i = 0; i < LCD_W * LCD_H; i++) bar[i] = rgb565;
}

void setup() {
  Serial.begin(115200);
  delay(100);
  Serial.println("[LCD] LCD demo start");
}

void loop() {
  static int phase = 0;
  if (phase == 0) {
    fillBar(0xF800);
    EmuLcdReq r = {0, 0, LCD_W - 1, LCD_H - 1, (const uint8_t *)bar, sizeof(bar)};
    emuLcdDraw(&r);
    Serial.println("[LCD] red bar");
    phase++;
    delay(50);
  } else if (phase == 1) {
    fillBar(0x07E0);
    EmuLcdReq r = {0, 40, LCD_W - 1, 79, (const uint8_t *)bar, sizeof(bar)};
    emuLcdDraw(&r);
    Serial.println("[LCD] green bar");
    phase++;
    delay(50);
  } else if (phase == 2) {
    fillBar(0x001F);
    EmuLcdReq r = {0, 80, LCD_W - 1, 119, (const uint8_t *)bar, sizeof(bar)};
    emuLcdDraw(&r);
    Serial.println("[LCD] blue bar");
    phase++;
    delay(50);
  } else {
    Serial.println("[LCD] lcd-done");
    delay(500);
  }
}
