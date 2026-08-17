#include <SPI.h>
#include <SD.h>

#define SD_CS 7

void setup() {
  Serial.begin(115200);
  delay(100);
  Serial.println("\n[SD] Initializing SD Card on SPI CS=7...");

  SPI.begin(4, 5, 6, -1);

  Serial.println("[SD] before begin");
  if (!SD.begin(SD_CS)) {
    Serial.println("[SD] SD Card Mount Failed!");
    return;
  }
  Serial.println("[SD] after begin");

  Serial.println("[SD] before open");
  File file = SD.open("/README.TXT");
  Serial.println("[SD] after open");
  if (!file) {
    Serial.println("[SD] Failed to open /README.TXT for reading");
    return;
  }

  Serial.print("[SD] Content: ");
  int c = 0;
  while (file.available()) {
    c++;
    if (c % 25 == 0) Serial.println("[SD] progress " + String(c));
    Serial.write(file.read());
  }
  Serial.println();
  file.close();

  Serial.println("[SD] sd-done");
}

void loop() {
  delay(1000);
}