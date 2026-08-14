// Uses both Wire and SPI so the linker keeps both driver sets.
#include <Wire.h>
#include <SPI.h>
void setup() {
  Serial.begin(115200);
  Wire.begin(8, 9);
  Wire.beginTransmission(0x3C); Wire.write(0xAF); Wire.endTransmission();
  SPI.begin(4, 5, 6, 7);
  SPI.beginTransaction(SPISettings(1000000, MSBFIRST, SPI_MODE0));
  SPI.transfer(0x42);
  SPI.endTransaction();
  Serial.println("bus-done");
}
void loop() { delay(1000); }
