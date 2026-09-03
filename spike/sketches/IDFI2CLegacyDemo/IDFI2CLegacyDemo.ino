// Raw ESP-IDF legacy I2C test (NO Arduino Wire.h): i2c_param_config,
// i2c_driver_install, i2c_master_write_to_device, i2c_master_read_from_device
// against the virtual 0x68 MPU device.
// NOTE: the legacy command-link API (i2c_master_cmd_begin) is NOT emulated.
// Kept in a separate sketch from IDFI2CDemo: real IDF aborts when the v5 and
// legacy drivers are both initialized (check_i2c_driver_conflict).
#include <Arduino.h>
#include "driver/i2c.h"

#define PIN_SDA 8
#define PIN_SCL 9
#define DEV_ADDR 0x68

void setup() {
  Serial.begin(115200);
  delay(100);
  Serial.println("[IDFI2C] IDF legacy I2C demo start");

  i2c_config_t cfg = {};
  cfg.mode = I2C_MODE_MASTER;
  cfg.sda_io_num = PIN_SDA;
  cfg.scl_io_num = PIN_SCL;
  cfg.master.clk_speed = 100000;
  esp_err_t r0 = i2c_param_config(I2C_NUM_0, &cfg);
  esp_err_t r00 = i2c_driver_install(I2C_NUM_0, I2C_MODE_MASTER, 0, 0, 0);
  Serial.printf("[IDFI2C] legacy setup param=%d install=%d\n", (int)r0, (int)r00);
}

void loop() {
  static int phase = 0;
  if (phase == 0) {
    uint8_t reg = 0x3B;
    uint8_t buf[3] = {0, 0, 0};
    esp_err_t r1 = i2c_master_write_to_device(I2C_NUM_0, DEV_ADDR, &reg, 1, 50);
    esp_err_t r2 = i2c_master_read_from_device(I2C_NUM_0, DEV_ADDR, buf, 3, 50);
    bool ok = (r1 == ESP_OK) && (r2 == ESP_OK) &&
              buf[0] == 0xDE && buf[1] == 0xAD && buf[2] == 0xBE;
    Serial.printf("[IDFI2C] legacy wr=%d rd=%d got=%02X%02X%02X %s\n",
                  (int)r1, (int)r2, buf[0], buf[1], buf[2], ok ? "OK" : "FAIL");
    phase = ok ? 1 : 99;
    delay(50);
  } else if (phase == 1) {
    Serial.println("[IDFI2C] idf-i2c-legacy-done");
    delay(500);
  } else {
    Serial.println("[IDFI2C] idf-i2c-legacy-FAILED");
    delay(500);
  }
}
