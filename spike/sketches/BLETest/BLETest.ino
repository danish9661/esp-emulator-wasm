#include <Arduino.h>

extern "C" int esp_bt_controller_init(void *cfg);
extern "C" int esp_bt_controller_enable(int mode);
extern "C" int esp_vhci_host_send_packet(const uint8_t *pkt, uint16_t len);
extern "C" int esp_vhci_host_check_send_available(void);
extern "C" void esp_vhci_host_register_callback(const void *cb);

void setup() {
  Serial.begin(115200);
  delay(50);
  Serial.println("[TEST] check_send_available before init: " + String(esp_vhci_host_check_send_available()));
  Serial.flush();
  Serial.println("[TEST] calling esp_bt_controller_init...");
  Serial.flush();
  int r = esp_bt_controller_init((void *)0x1); // invalid cfg on purpose: real impl faults, intercepted stub returns
  Serial.println("[TEST] init returned: " + String(r));
  Serial.flush();
  Serial.println("[TEST] check_send_available after init: " + String(esp_vhci_host_check_send_available()));
  Serial.println("[TEST] calling esp_bt_controller_enable...");
  Serial.flush();
  int r2 = esp_bt_controller_enable(1);
  Serial.println("[TEST] enable returned: " + String(r2));
  Serial.println("[TEST] done");
}

void loop() { delay(1000); }