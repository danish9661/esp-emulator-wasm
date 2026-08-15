#include <Arduino.h>
#include "driver/i2s.h"

#define I2S_SAMPLE_RATE     (16000)
#define I2S_BCLK_PIN        (4)
#define I2S_WS_PIN          (5)
#define I2S_DOUT_PIN        (6)

void setup() {
  Serial.begin(115200);
  delay(100);
  Serial.println("\n[I2S] Initializing I2S Digital Audio Output...");

  i2s_config_t i2s_config = {
    .mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_TX),
    .sample_rate = I2S_SAMPLE_RATE,
    .bits_per_sample = I2S_BITS_PER_SAMPLE_16BIT,
    .channel_format = I2S_CHANNEL_FMT_RIGHT_LEFT,
    .communication_format = I2S_COMM_FORMAT_STAND_I2S,
    .intr_alloc_flags = ESP_INTR_FLAG_LEVEL1,
    .dma_buf_count = 4,
    .dma_buf_len = 128,
    .use_apll = false,
    .tx_desc_auto_clear = true,
    .fixed_mclk = 0
  };

  i2s_pin_config_t pin_config = {
    .bck_io_num = I2S_BCLK_PIN,
    .ws_io_num = I2S_WS_PIN,
    .data_out_num = I2S_DOUT_PIN,
    .data_in_num = I2S_PIN_NO_CHANGE
  };

  esp_err_t err = i2s_driver_install(I2S_NUM_0, &i2s_config, 0, NULL);
  if (err == ESP_OK) {
    i2s_set_pin(I2S_NUM_0, &pin_config);
    Serial.println("[I2S] I2S driver installed successfully (16kHz 16-bit stereo)");
  } else {
    Serial.printf("[I2S] Driver install returned: 0x%x\n", err);
  }
}

void loop() {
  // Generate a 440 Hz sine wave tone buffer (128 samples, 16-bit stereo)
  int16_t samples[256];
  for (int i = 0; i < 128; i++) {
    int16_t val = (int16_t)(sin(2.0 * PI * 440.0 * i / I2S_SAMPLE_RATE) * 10000.0);
    samples[i * 2] = val;     // Left
    samples[i * 2 + 1] = val; // Right
  }

  size_t bytes_written = 0;
  esp_err_t ret = i2s_write(I2S_NUM_0, samples, sizeof(samples), &bytes_written, portMAX_DELAY);
  Serial.printf("[I2S] Wrote %u bytes of audio PCM (ret=0x%x)\n", bytes_written, ret);
  Serial.println("[I2S] i2s-audio-done");
  delay(300);
}
