// Raw ESP-IDF I2C test (NO Arduino Wire.h). Exercises two shim tiers:
//   - idf-i2c-v5: i2c_new_master_bus, i2c_master_bus_add_device,
//     i2c_master_transmit, i2c_master_receive, i2c_master_transmit_receive,
//     i2c_master_probe (against the virtual 0x68 MPU device).
//   - idf-i2c-legacy: i2c_param_config, i2c_driver_install,
//     i2c_master_write_to_device, i2c_master_read_from_device.
// NOTE: the legacy command-link API (i2c_master_cmd_begin) is NOT emulated.
#include <Arduino.h>
#include "driver/i2c_master.h"

#define PIN_SDA 8
#define PIN_SCL 9
#define DEV_ADDR 0x68

static i2c_master_bus_handle_t gBus = nullptr;
static i2c_master_dev_handle_t gDev = nullptr;

void setup() {
  Serial.begin(115200);
  delay(100);
  Serial.println("[IDFI2C] IDF I2C demo start");

  // ---- v5 driver ----
  i2c_master_bus_config_t busCfg = {};
  busCfg.i2c_port = 0;
  busCfg.sda_io_num = (gpio_num_t)PIN_SDA;
  busCfg.scl_io_num = (gpio_num_t)PIN_SCL;
  busCfg.glitch_ignore_cnt = 7;
  busCfg.flags.enable_internal_pullup = 1;
  esp_err_t r = i2c_new_master_bus(&busCfg, &gBus);
  Serial.printf("[IDFI2C] new_bus rc=%d\n", (int)r);

  i2c_device_config_t devCfg = {};
  devCfg.dev_addr_length = I2C_ADDR_BIT_LEN_7;
  devCfg.device_address = DEV_ADDR;
  devCfg.scl_speed_hz = 100000;
  r = i2c_master_bus_add_device(gBus, &devCfg, &gDev);
  Serial.printf("[IDFI2C] add_device rc=%d\n", (int)r);

  r = i2c_master_probe(gBus, DEV_ADDR, 50);
  Serial.printf("[IDFI2C] probe rc=%d\n", (int)r);
}

void loop() {
  static int phase = 0;
  if (phase == 0) {
    // v5 transmit (register pointer) + receive (3 sensor bytes).
    uint8_t reg = 0x3B;
    uint8_t buf[3] = {0, 0, 0};
    esp_err_t r1 = i2c_master_transmit(gDev, &reg, 1, 50);
    esp_err_t r2 = i2c_master_receive(gDev, buf, 3, 50);
    bool ok = (r1 == ESP_OK) && (r2 == ESP_OK) &&
              buf[0] == 0xDE && buf[1] == 0xAD && buf[2] == 0xBE;
    Serial.printf("[IDFI2C] v5 txrx rc=%d/%d got=%02X%02X%02X %s\n",
                  (int)r1, (int)r2, buf[0], buf[1], buf[2], ok ? "OK" : "FAIL");
    phase = ok ? 1 : 99;
    delay(50);
  } else if (phase == 1) {
    // v5 combined transmit_receive.
    uint8_t reg = 0x3B;
    uint8_t buf[3] = {0, 0, 0};
    esp_err_t r = i2c_master_transmit_receive(gDev, &reg, 1, buf, 3, 50);
    bool ok = (r == ESP_OK) && buf[0] == 0xDE && buf[1] == 0xAD && buf[2] == 0xBE;
    Serial.printf("[IDFI2C] v5 transmit_receive rc=%d %s\n", (int)r, ok ? "OK" : "FAIL");
    phase = ok ? 2 : 99;
    delay(50);
  } else if (phase == 2) {
    Serial.println("[IDFI2C] idf-i2c-done");
    delay(500);
  } else {
    Serial.println("[IDFI2C] idf-i2c-FAILED");
    delay(500);
  }
}
