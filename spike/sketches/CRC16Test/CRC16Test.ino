#include <Arduino.h>
#include <SD.h>

extern "C" uint16_t CRC16(uint8_t *data, size_t len);

void setup() {
    Serial.begin(115200);
    delay(200);
    uint8_t buf[] = {0x40, 0x0E, 0x00, 0x32, 0x5B, 0x59, 0x00, 0x00, 0x00, 0x01, 0x7F, 0x80, 0x0A, 0x40, 0x00, 0x00};
    uint16_t c = CRC16(buf, 16);
    Serial.print("[C] crc=");
    Serial.println(c, HEX);
    Serial.println("[C] done");
}

void loop() {
    delay(1000);
}