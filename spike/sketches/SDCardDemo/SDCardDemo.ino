#include <SPI.h>
#include <SD.h>

#define SD_CS 7

void setup() {
  Serial.begin(115200);
  delay(100);
  Serial.println("\n[SD] Initializing SD Card on SPI CS=7...");

  SPI.begin(4, 5, 6, -1); // SCK=4, MISO=5, MOSI=6, SS=-1 (leave CS pin 7 free for SD driver)

  if (!SD.begin(SD_CS)) {
    Serial.println("[SD] SD Card Mount Failed!");
    return;
  }
  Serial.println("[SD] SD Card Initialized Successfully!");

  File file = SD.open("/README.TXT");
  if (!file) {
    Serial.println("[SD] Failed to open /README.TXT for reading");
    return;
  }

  Serial.print("[SD] Content: ");
  while (file.available()) {
    Serial.write(file.read());
  }
  file.close();

  Serial.println("[SD] sd-done");
}

void loop() {
  delay(1000);
}
