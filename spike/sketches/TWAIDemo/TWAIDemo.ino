#include <Arduino.h>
#include "driver/twai.h"

#define TX_PIN   GPIO_NUM_2
#define RX_PIN   GPIO_NUM_3

void setup() {
  Serial.begin(115200);
  delay(100);
  Serial.println("\n[TWAI] Initializing TWAI / CAN Bus Controller (500 kbps)...");

  twai_general_config_t g_config = TWAI_GENERAL_CONFIG_DEFAULT(TX_PIN, RX_PIN, TWAI_MODE_NORMAL);
  twai_timing_config_t t_config = TWAI_TIMING_CONFIG_500KBITS();
  twai_filter_config_t f_config = TWAI_FILTER_CONFIG_ACCEPT_ALL();

  if (twai_driver_install(&g_config, &t_config, &f_config) == ESP_OK) {
    Serial.println("[TWAI] Driver installed");
  } else {
    Serial.println("[TWAI] Failed to install driver");
    return;
  }

  if (twai_start() == ESP_OK) {
    Serial.println("[TWAI] Driver started successfully");
  } else {
    Serial.println("[TWAI] Failed to start driver");
    return;
  }

  // Send test CAN packet: ID=0x123, DLC=4, Data=[0xDE, 0xAD, 0xBE, 0xEF]
  twai_message_t tx_msg;
  tx_msg.identifier = 0x123;
  tx_msg.extd = 0;
  tx_msg.data_length_code = 4;
  tx_msg.data[0] = 0xDE;
  tx_msg.data[1] = 0xAD;
  tx_msg.data[2] = 0xBE;
  tx_msg.data[3] = 0xEF;

  esp_err_t res = twai_transmit(&tx_msg, pdMS_TO_TICKS(1000));
  Serial.printf("[TWAI] Transmitted CAN frame ID=0x%03x DLC=%d (res=0x%x)\n", tx_msg.identifier, tx_msg.data_length_code, res);
}

void loop() {
  // Check for received CAN packets
  twai_message_t rx_msg;
  if (twai_receive(&rx_msg, pdMS_TO_TICKS(50)) == ESP_OK) {
    Serial.printf("[TWAI] Received CAN frame ID=0x%03x DLC=%d Data=", rx_msg.identifier, rx_msg.data_length_code);
    for (int i = 0; i < rx_msg.data_length_code; i++) {
      Serial.printf("%02X ", rx_msg.data[i]);
    }
    Serial.println();
  }

  // Periodic heartbeat transmission
  static uint32_t count = 0;
  twai_message_t tx_msg;
  tx_msg.identifier = 0x555;
  tx_msg.extd = 0;
  tx_msg.data_length_code = 4;
  tx_msg.data[0] = (count >> 24) & 0xFF;
  tx_msg.data[1] = (count >> 16) & 0xFF;
  tx_msg.data[2] = (count >> 8) & 0xFF;
  tx_msg.data[3] = count & 0xFF;
  twai_transmit(&tx_msg, pdMS_TO_TICKS(100));
  count++;

  Serial.println("[TWAI] twai-bus-done");
  delay(400);
}
