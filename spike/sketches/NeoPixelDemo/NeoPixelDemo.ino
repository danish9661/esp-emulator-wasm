#include <Adafruit_NeoPixel.h>

#define PIN        8
#define NUMPIXELS 8

Adafruit_NeoPixel pixels(NUMPIXELS, PIN, NEO_GRB + NEO_KHZ800);

void setup() {
  Serial.begin(115200);
  delay(100);
  Serial.println("\n[NeoPixel] Initializing 8-pixel WS2812 strip on GPIO 8...");
  pixels.begin();
  pixels.clear();
  pixels.show();
  Serial.println("[NeoPixel] NeoPixel strip initialized!");
}

int hue = 0;

void loop() {
  for (int i = 0; i < NUMPIXELS; i++) {
    int pixelHue = (hue + (i * 65536L / NUMPIXELS)) & 65535;
    pixels.setPixelColor(i, pixels.gamma32(pixels.ColorHSV(pixelHue)));
  }
  pixels.show();
  Serial.printf("[NeoPixel] Rainbow frame: hue=%d\n", hue);
  hue = (hue + 256) & 65535;
  delay(50);
}
