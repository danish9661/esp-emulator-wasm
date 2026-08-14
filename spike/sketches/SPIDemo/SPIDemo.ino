#include <SPI.h>

#define PIN_SCK  4
#define PIN_MISO 5
#define PIN_MOSI 6
#define PIN_SS   7

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println("\n[SPI] Initializing SPI bus...");

  SPI.begin(PIN_SCK, PIN_MISO, PIN_MOSI, PIN_SS);
  pinMode(PIN_SS, OUTPUT);
  digitalWrite(PIN_SS, HIGH);

  Serial.println("[SPI] SPI initialized successfully!");
  delay(100);

  // Perform single-byte SPI transfer
  digitalWrite(PIN_SS, LOW);
  SPI.beginTransaction(SPISettings(1000000, MSBFIRST, SPI_MODE0));
  
  uint8_t txByte = 0x42;
  uint8_t rxByte = SPI.transfer(txByte);
  
  SPI.endTransaction();
  digitalWrite(PIN_SS, HIGH);

  Serial.printf("[SPI] Single byte: TX=0x%02X RX=0x%02X\n", txByte, rxByte);

  // Perform multi-byte SPI transfer
  digitalWrite(PIN_SS, LOW);
  SPI.beginTransaction(SPISettings(1000000, MSBFIRST, SPI_MODE0));

  uint8_t buffer[4] = { 0xAA, 0xBB, 0xCC, 0xDD };
  SPI.transferBytes(buffer, buffer, 4);

  SPI.endTransaction();
  digitalWrite(PIN_SS, HIGH);

  Serial.printf("[SPI] Block transfer: RX=%02X%02X%02X%02X\n", buffer[0], buffer[1], buffer[2], buffer[3]);
  Serial.println("[SPI] spi-done");
}

void loop() {
  delay(1000);
}
