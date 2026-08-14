// Reads 3 bytes from a virtual device at 0x68 (MPU6050-style address).
#include <Wire.h>
void setup() {
  Serial.begin(115200);
  delay(200);
  Wire.begin(8, 9);
  Serial.println("read-start");
  uint8_t n = Wire.requestFrom((uint8_t)0x68, (uint8_t)3);
  Serial.printf("got=%u:", n);
  while (Wire.available()) Serial.printf("%02X", Wire.read());
  Serial.println();
  Serial.println("read-done");
}
void loop() { delay(1000); }
