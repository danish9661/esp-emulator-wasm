#include <Arduino.h>

extern "C" int esp_bt_controller_init(void *cfg);
extern "C" int esp_bt_controller_enable(int mode);
extern "C" int esp_vhci_host_send_packet(const uint8_t *pkt, uint16_t len);
extern "C" int esp_vhci_host_check_send_available(void);
extern "C" void esp_vhci_host_register_callback(const void *cb);

static uint32_t rd32(uint32_t a) { return *(volatile uint32_t *)a; }

void setup() {
  Serial.begin(115200);
  delay(50);
  uint32_t addrs[] = {
      (uint32_t)esp_bt_controller_init,
      (uint32_t)esp_bt_controller_enable,
      (uint32_t)esp_vhci_host_send_packet,
      (uint32_t)esp_vhci_host_check_send_available,
      (uint32_t)esp_vhci_host_register_callback,
  };
  for (int i = 0; i < 5; i++) {
    uint32_t a = addrs[i];
    Serial.printf("[DETECT] f%d @%08x:", i, a);
    for (int j = 0; j < 4; j++) Serial.printf(" %08x", rd32(a + j * 4));
    Serial.println();
  }
  Serial.println("[DETECT] done");
}

void loop() { delay(1000); }