// Does the emulator support the I2C peripheral at all?
#include <Wire.h>
void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println("i2c-begin");
  Wire.begin(8, 9);
  Serial.println("i2c-inited");
  Wire.beginTransmission(0x3C);
  Wire.write(0xAF);
  uint8_t r = Wire.endTransmission();
  Serial.printf("endTransmission=%u\n", r);
  Serial.println("i2c-done");
}
void loop() { delay(1000); }
