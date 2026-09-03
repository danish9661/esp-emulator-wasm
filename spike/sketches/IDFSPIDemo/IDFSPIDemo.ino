// Raw ESP-IDF SPI master test (NO Arduino SPI.h). Exercises the idf-spi
// shim tier: spi_bus_initialize, spi_bus_add_device, spi_device_transmit and
// spi_device_polling_transmit (full-duplex, pointer + inline tx_data paths).
// The virtual bus answers each byte with (b ^ 0x55), like the Arduino SPIDemo.
#include <Arduino.h>
#include "driver/spi_master.h"
#include "esp_check.h"

#define PIN_SCK 4
#define PIN_MISO 5
#define PIN_MOSI 6
#define PIN_SS 7

static spi_device_handle_t gDev = nullptr;

void setup() {
  Serial.begin(115200);
  delay(100);
  Serial.println("[IDFSPI] IDF SPI demo start");

  spi_bus_config_t buscfg = {};
  buscfg.mosi_io_num = PIN_MOSI;
  buscfg.miso_io_num = PIN_MISO;
  buscfg.sclk_io_num = PIN_SCK;
  buscfg.max_transfer_sz = 64;
  esp_err_t r = spi_bus_initialize(SPI2_HOST, &buscfg, SPI_DMA_DISABLED);
  Serial.printf("[IDFSPI] bus_initialize rc=%d\n", (int)r);

  spi_device_interface_config_t devcfg = {};
  devcfg.clock_speed_hz = 1000000;
  devcfg.mode = 0;
  devcfg.spics_io_num = PIN_SS;
  devcfg.queue_size = 4;
  r = spi_bus_add_device(SPI2_HOST, &devcfg, &gDev);
  Serial.printf("[IDFSPI] bus_add_device rc=%d handle=%p\n", (int)r, gDev);
}

static bool checkXor(const char *what, const uint8_t *tx, const uint8_t *rx, int n) {
  bool ok = true;
  for (int i = 0; i < n; i++) {
    if (rx[i] != (uint8_t)(tx[i] ^ 0x55)) ok = false;
  }
  Serial.printf("[IDFSPI] %s %s\n", what, ok ? "OK" : "FAIL");
  return ok;
}

void loop() {
  static int phase = 0;
  if (phase == 0) {
    // Pointer-based full duplex via spi_device_transmit.
    static uint8_t tx[16], rx[16];
    for (int i = 0; i < 16; i++) tx[i] = (uint8_t)i;
    memset(rx, 0, sizeof(rx));
    spi_transaction_t t = {};
    t.length = 16 * 8;
    t.tx_buffer = tx;
    t.rx_buffer = rx;
    esp_err_t r = spi_device_transmit(gDev, &t);
    bool ok = (r == ESP_OK) && checkXor("transmit", tx, rx, 16);
    Serial.printf("[IDFSPI] transmit rc=%d\n", (int)r);
    phase = ok ? 1 : 99;
    delay(50);
  } else if (phase == 1) {
    // Inline tx_data/rx_data path via spi_device_polling_transmit.
    spi_transaction_t t = {};
    t.flags = SPI_TRANS_USE_TXDATA | SPI_TRANS_USE_RXDATA;
    t.length = 4 * 8;
    t.tx_data[0] = 0xDE;
    t.tx_data[1] = 0xAD;
    t.tx_data[2] = 0xBE;
    t.tx_data[3] = 0xEF;
    esp_err_t r = spi_device_polling_transmit(gDev, &t);
    uint8_t exp[4] = {0xDE ^ 0x55, 0xAD ^ 0x55, 0xBE ^ 0x55, 0xEF ^ 0x55};
    bool ok = (r == ESP_OK);
    for (int i = 0; i < 4 && ok; i++) {
      if (t.rx_data[i] != exp[i]) ok = false;
    }
    Serial.printf("[IDFSPI] polling-inline %s\n", ok ? "OK" : "FAIL");
    Serial.printf("[IDFSPI] polling rc=%d\n", (int)r);
    phase = ok ? 2 : 99;
    delay(50);
  } else if (phase == 2) {
    Serial.println("[IDFSPI] idf-spi-done");
    delay(500);
  } else {
    Serial.println("[IDFSPI] idf-spi-FAILED");
    delay(500);
  }
}
